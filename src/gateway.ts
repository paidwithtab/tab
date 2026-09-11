// The gateway: a reverse proxy that issues 402 challenges on priced routes,
// verifies credentials, reserves funds, forwards upstream, and captures on 2xx.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  PayError,
  VERSION,
  encodeChallengeHeader,
  encodeReceiptHeader,
  makeChallenge,
  microToUsd,
  parseCredentialHeader,
  problemBody,
  randomId,
  resourceOf,
  sha256b64url,
  usdToMicro,
  verifyChallengeId,
  verifyCredentialSig,
  type Challenge,
  type Credential,
  type ProblemCode,
  type Receipt,
} from './protocol.js';
import { mandateExpired, realmAllowed, verifyMandate } from './mandate.js';
import { checkAndSpend, windowKey } from './rails/budget.js';
import { createRail, type Rail } from './rails/index.js';
import type { HoldRow, Store } from './store.js';

// ---------------------------------------------------------------------------
// spec

export interface RouteSpec {
  method: string;
  path: string; // supports :param segments; relative to the service prefix
  price: string; // USD, up to six decimals; "0" = free, forwarded unpaid
  description?: string;
}

export interface ServiceSpec {
  name: string;
  prefix: string; // matched longest-first; "" is the root
  upstream: string;
  upstream_headers?: Record<string, string>;
  description?: string;
  routes: RouteSpec[];
}

export interface Spec {
  realm: string;
  recipient: string;
  rail?: 'ledger' | 'evm';
  evm?: { rpc: string; chain_id: number; token: string; decimals: number; recipient: string; explorer?: string };
  public_receipts?: boolean;
  services: ServiceSpec[];
}

/** Load a spec file, expanding ${UPPER_CASE_NAME} from the environment. */
export function loadSpec(path: string): Spec {
  const raw = readFileSync(path, 'utf8').replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
    return process.env[name] ?? '';
  });
  const parsed = JSON.parse(raw);
  // single-service shorthand: top-level upstream/upstream_headers/routes
  if (!parsed.services && parsed.upstream) {
    parsed.services = [
      {
        name: parsed.name ?? 'service',
        prefix: '',
        upstream: parsed.upstream,
        upstream_headers: parsed.upstream_headers,
        routes: parsed.routes ?? [],
      },
    ];
    delete parsed.upstream;
    delete parsed.upstream_headers;
    delete parsed.routes;
  }
  const spec = parsed as Spec;
  if (!spec.realm) throw new Error('spec.realm is required');
  if (!spec.recipient) throw new Error('spec.recipient is required');
  if (!Array.isArray(spec.services) || spec.services.length === 0) {
    throw new Error('spec.services is required');
  }
  for (const s of spec.services) {
    if (typeof s.prefix !== 'string' || !s.upstream) throw new Error(`service ${s.name}: prefix and upstream are required`);
    for (const r of s.routes) usdToMicro(r.price); // validate prices early
  }
  return spec;
}

// ---------------------------------------------------------------------------
// route matching

interface Match {
  service: ServiceSpec;
  route: RouteSpec;
  rest: string; // the path forwarded upstream (prefix stripped)
}

function pathMatches(pattern: string, actual: string): boolean {
  const p = pattern.split('/');
  const a = actual.split('/');
  if (p.length !== a.length) return false;
  return p.every((seg, i) => (seg.startsWith(':') && seg.length > 1 ? a[i].length > 0 : seg === a[i]));
}

export function matchRoute(spec: Spec, method: string, pathname: string): Match | null {
  const services = [...spec.services].sort((x, y) => y.prefix.length - x.prefix.length);
  for (const service of services) {
    if (service.prefix !== '' && pathname !== service.prefix && !pathname.startsWith(service.prefix + '/')) {
      continue;
    }
    const rest = pathname.slice(service.prefix.length) || '/';
    for (const route of service.routes) {
      if (route.method.toUpperCase() !== method.toUpperCase()) continue;
      if (pathMatches(route.path, rest)) return { service, route, rest };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// server

export interface GatewayOptions {
  store: Store;
  rail?: Rail;
  log?: (msg: string) => void;
  challengeTtlMs?: number; // default 120 s
  upstreamTimeoutMs?: number; // default 60 s
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Tab-Receipt, Tab-Void, WWW-Authenticate',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 1);
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(data);
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createGateway(spec: Spec, opts: GatewayOptions): Server {
  const store = opts.store;
  const rail = opts.rail ?? createRail(spec, store);
  const log = opts.log ?? (() => {});
  const ttlMs = opts.challengeTtlMs ?? 120_000;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 60_000;

  const discovery = () => ({
    ver: VERSION,
    realm: spec.realm,
    rail: rail.name,
    rail_info: rail.info(),
    recipient: spec.recipient,
    services: spec.services.map((s) => ({
      name: s.name,
      prefix: s.prefix,
      description: s.description,
      routes: s.routes.map((r) => ({
        method: r.method.toUpperCase(),
        path: r.path,
        price: r.price,
        description: r.description,
      })),
    })),
  });

  async function freshChallenge(priceMicro: number, resource: string): Promise<Challenge> {
    const extras = await rail.challengeExtras();
    return makeChallenge(store.secret, {
      realm: spec.realm,
      rail: rail.name,
      amount: String(priceMicro),
      recipient: spec.recipient,
      resource,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      ...extras,
    });
  }

  async function respondProblem(
    res: ServerResponse,
    code: ProblemCode,
    detail: string,
    status: number,
    challenge?: Challenge,
  ): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/problem+json', ...CORS };
    if (challenge) headers['www-authenticate'] = encodeChallengeHeader(challenge);
    res.writeHead(status, headers);
    res.end(problemBody(code, detail, status));
  }

  /** A 402 with a fresh challenge — or 502 if the rail cannot mint one (e.g. dead RPC). */
  async function respondChallenge(
    res: ServerResponse,
    code: ProblemCode,
    detail: string,
    priceMicro: number,
    resource: string,
  ): Promise<void> {
    let chal: Challenge;
    try {
      chal = await freshChallenge(priceMicro, resource);
    } catch (err) {
      await respondProblem(res, 'upstream-failed', `payment rail unavailable: ${(err as Error).message}`, 502);
      return;
    }
    await respondProblem(res, code, detail, 402, chal);
  }

  /** All the checks before money moves. Throws PayError. Returns the hold. */
  function verifyAndReserve(
    cred: Credential,
    priceMicro: number,
    resource: string,
    actual: { query: string; bodySha256: string },
    now: Date,
  ): HoldRow {
    const chal = cred.challenge;
    if (cred.ver !== VERSION) throw new PayError('malformed-credential', `unsupported version ${cred.ver}`);
    if (!chal || typeof chal.id !== 'string' || !verifyChallengeId(store.secret, chal)) {
      throw new PayError('invalid-challenge', 'challenge was not issued by this gateway');
    }
    if (
      chal.realm !== spec.realm ||
      chal.rail !== rail.name ||
      chal.recipient !== spec.recipient ||
      chal.amount !== String(priceMicro) ||
      chal.resource !== resource
    ) {
      throw new PayError('invalid-challenge', 'challenge does not match this request');
    }
    const exp = Date.parse(chal.expires_at);
    if (!Number.isFinite(exp) || exp <= now.getTime()) {
      throw new PayError('payment-expired', 'challenge expired; request a fresh one');
    }
    const mv = verifyMandate(cred.mandate);
    if (!mv.ok) throw new PayError('mandate-invalid', `mandate: ${mv.error}`);
    if (mandateExpired(cred.mandate, now)) throw new PayError('mandate-invalid', 'mandate expired');
    if (cred.agent !== cred.mandate.agent) {
      throw new PayError('verification-failed', 'credential agent does not match the mandate agent');
    }
    if (!cred.request || typeof cred.request.body_sha256 !== 'string' || typeof cred.request.query !== 'string') {
      throw new PayError('malformed-credential', 'credential carries no request commitment');
    }
    if (!verifyCredentialSig(cred)) {
      throw new PayError('verification-failed', 'agent signature invalid');
    }
    if (cred.request.query !== actual.query || cred.request.body_sha256 !== actual.bodySha256) {
      throw new PayError('verification-failed', 'request does not match the signed commitment');
    }
    if (!realmAllowed(cred.mandate, spec.realm)) {
      throw new PayError('mandate-denied', `realm ${spec.realm} not in mandate allow list`);
    }
    const holdId = randomId();
    return store.tx(() => {
      if (!store.redeem(chal.id, now.toISOString())) {
        throw new PayError('invalid-challenge', 'challenge already redeemed');
      }
      const key = checkAndSpend(store, cred.mandate, priceMicro, now);
      const { tx, txHash } = rail.reserveLocal({ cred, chal, priceMicro, holdId, now });
      const hold: HoldRow = {
        id: holdId,
        challenge_id: chal.id,
        amount: priceMicro,
        payer: cred.agent,
        owner: cred.mandate.owner,
        recipient: spec.recipient,
        resource,
        realm: spec.realm,
        rail: rail.name,
        mandate_id: cred.mandate.id,
        window_key: key,
        state: 'reserved',
        ref: null,
        tx,
        tx_hash: txHash ?? null,
        created_at: now.toISOString(),
      };
      try {
        store.createHold(hold);
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) {
          throw new PayError('invalid-challenge', 'payment transaction already used for another call');
        }
        throw err;
      }
      return hold;
    });
  }

  async function releaseHold(hold: HoldRow): Promise<void> {
    await rail.release(hold);
    store.refundSpend(hold.mandate_id, hold.window_key, hold.amount);
    store.setHoldState(hold.id, 'voided');
  }

  async function forwardUpstream(
    req: IncomingMessage,
    body: Buffer,
    match: Match,
    search: string,
    hold: HoldRow | null,
  ): Promise<Response> {
    const url = match.service.upstream.replace(/\/$/, '') + match.rest + search;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'expect', 'keep-alive'].includes(key)) continue;
      headers[key] = Array.isArray(v) ? v.join(', ') : v;
    }
    for (const [k, v] of Object.entries(match.service.upstream_headers ?? {})) headers[k.toLowerCase()] = v;
    if (hold) {
      headers['tab-payer'] = hold.payer;
      headers['tab-owner'] = hold.owner;
      headers['tab-hold'] = hold.id;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    return fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    });
  }

  async function relayResponse(
    res: ServerResponse,
    upstream: Response,
    extra: Record<string, string>,
  ): Promise<void> {
    const headers: Record<string, string> = { ...CORS, ...extra };
    upstream.headers.forEach((v, k) => {
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k)) return;
      headers[k] = v;
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, headers);
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...CORS,
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }

      if (pathname === '/.well-known/tab' && method === 'GET') {
        sendJson(res, 200, discovery());
        return;
      }
      if (pathname.startsWith('/.well-known/tab/wallet/') && method === 'GET') {
        const wallet = pathname.slice('/.well-known/tab/wallet/'.length);
        try {
          const micro = await rail.balance(wallet);
          sendJson(res, 200, { wallet, rail: rail.name, available: microToUsd(micro), micro });
        } catch (err) {
          sendJson(res, 502, { error: `balance lookup failed: ${(err as Error).message}` });
        }
        return;
      }
      if (pathname.startsWith('/.well-known/tab/evm/nonce/') && method === 'GET' && rail.accountNonce) {
        const address = pathname.slice('/.well-known/tab/evm/nonce/'.length);
        try {
          sendJson(res, 200, { address: address.toLowerCase(), nonce: await rail.accountNonce(address) });
        } catch (err) {
          sendJson(res, 502, { error: `nonce lookup failed: ${(err as Error).message}` });
        }
        return;
      }
      if (pathname === '/.well-known/tab/receipts' && method === 'GET') {
        if (!spec.public_receipts) {
          sendJson(res, 404, { error: 'receipts are not public on this gateway' });
          return;
        }
        const limit = Number(u.searchParams.get('limit') ?? 50) || 50;
        sendJson(res, 200, { realm: spec.realm, receipts: store.receipts(limit) });
        return;
      }

      const match = matchRoute(spec, method, pathname);
      if (!match) {
        await respondProblem(res, 'not-found', `no priced route for ${method} ${pathname}`, 404);
        return;
      }
      const priceMicro = usdToMicro(match.route.price);
      const resource = resourceOf(method, pathname);
      const body = await readBody(req);

      if (priceMicro === 0) {
        // free routes are forwarded unpaid
        try {
          const upstream = await forwardUpstream(req, body, match, u.search, null);
          await relayResponse(res, upstream, {});
          log(`${method} ${pathname} -> ${upstream.status} free ${Date.now() - started}ms`);
        } catch (err) {
          await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
        }
        return;
      }

      const auth = req.headers.authorization;
      if (!auth) {
        await respondChallenge(res, 'payment-required', `payment of ${microToUsd(priceMicro)} USD required`, priceMicro, resource);
        return;
      }
      const cred = parseCredentialHeader(auth);
      if (!cred) {
        await respondChallenge(res, 'malformed-credential', 'Authorization header is not a Tab credential', priceMicro, resource);
        return;
      }

      let hold: HoldRow;
      try {
        hold = verifyAndReserve(cred, priceMicro, resource, { query: u.search, bodySha256: sha256b64url(body) }, new Date());
      } catch (err) {
        if (err instanceof PayError) {
          log(`${method} ${pathname} -> 402 ${err.code}: ${err.detail}`);
          await respondChallenge(res, err.code, err.detail, priceMicro, resource);
          return;
        }
        throw err;
      }

      if (rail.reserveRemote) {
        try {
          await rail.reserveRemote(hold);
        } catch (err) {
          store.refundSpend(hold.mandate_id, hold.window_key, hold.amount);
          store.setHoldState(hold.id, 'voided');
          const pe = err instanceof PayError ? err : new PayError('verification-failed', String((err as Error).message));
          log(`${method} ${pathname} -> 402 ${pe.code}: ${pe.detail}`);
          await respondChallenge(res, pe.code, pe.detail, priceMicro, resource);
          return;
        }
      }

      let upstream: Response;
      try {
        upstream = await forwardUpstream(req, body, match, u.search, hold);
      } catch (err) {
        await releaseHold(hold);
        await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
        log(`${method} ${pathname} -> 502 upstream-failed (hold ${hold.id} released)`);
        return;
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        let ref: string;
        try {
          ref = await rail.capture(hold);
        } catch (err) {
          // The buyer got the response; worst case they were not charged.
          await releaseHold(hold);
          await relayResponse(res, upstream, { 'tab-void': hold.id });
          log(`${method} ${pathname} -> ${upstream.status} capture FAILED, voided ${hold.id}: ${(err as Error).message}`);
          return;
        }
        const receipt: Receipt = {
          id: hold.id,
          realm: spec.realm,
          resource,
          amount: String(priceMicro),
          currency: 'USD',
          rail: rail.name,
          payer: hold.payer,
          owner: hold.owner,
          recipient: hold.recipient,
          ref,
          at: new Date().toISOString(),
        };
        store.setHoldState(hold.id, 'captured', ref);
        store.addReceipt(receipt);
        await relayResponse(res, upstream, { 'tab-receipt': encodeReceiptHeader(receipt) });
        log(`${method} ${pathname} -> ${upstream.status} paid ${microToUsd(priceMicro)} ${ref} ${Date.now() - started}ms`);
      } else {
        await releaseHold(hold);
        await relayResponse(res, upstream, { 'tab-void': hold.id });
        log(`${method} ${pathname} -> ${upstream.status} voided ${hold.id}`);
      }
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        if (!res.headersSent) sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
        else res.end();
        return;
      }
      log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  // prune redeemed challenge ids older than one hour, every ten minutes
  const prune = setInterval(() => {
    try {
      store.pruneRedeemed(new Date(Date.now() - 3_600_000).toISOString());
    } catch {
      /* ignore */
    }
  }, 600_000);
  prune.unref();
  server.on('close', () => clearInterval(prune));

  return server;
}

/** Announce this gateway's public origin to a catalog, retrying for ~10 s. */
export async function announce(catalogOrigin: string, origin: string, log: (m: string) => void): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(catalogOrigin.replace(/\/$/, '') + '/v1/announce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin }),
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        log(`announced ${origin} to ${catalogOrigin}`);
        return true;
      }
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      log(`could not announce to ${catalogOrigin}; the gateway keeps running`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
