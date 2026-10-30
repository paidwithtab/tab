// The gateway: a reverse proxy that issues 402 challenges on priced routes,
// verifies credentials, reserves funds, forwards upstream, and captures on 2xx.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  PayError,
  VERSION,
  encodeChallengeHeader,
  encodeReceiptHeader,
  signReceipt,
  isCurrency,
  makeChallenge,
  microToBaseUnits,
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
import { createRail, EvmRail, type Rail } from './rails/index.js';
import type { KeyPair } from './keys.js';
import { encodeX402, decodeX402, X402_VERSION, type X402PaymentPayload, type X402SettlementResponse } from './x402.js';
import type { HoldRow, Store } from './store.js';
import { homePage } from './home.js';

// ---------------------------------------------------------------------------
// spec

export interface RouteSpec {
  method: string;
  path: string; // supports :param segments; relative to the service prefix
  price: string; // USD, up to six decimals; "0" = free, forwarded unpaid
  description?: string;
  /**
   * Body constraints, so a flat price sells exactly one bounded operation on
   * providers whose cost depends on the request. Both apply to JSON bodies.
   * body_allow: the only top-level keys a buyer may send; anything else is a
   * 400 before any challenge. body_fixed: keys the gateway sets itself before
   * forwarding, overriding whatever the buyer sent.
   */
  body_allow?: string[];
  body_fixed?: Record<string, unknown>;
}

export interface ServiceSpec {
  name: string;
  prefix: string; // matched longest-first; "" is the root
  upstream: string;
  upstream_headers?: Record<string, string>;
  /** Query parameters added to every upstream URL, for providers that take their key in the query string. */
  upstream_query?: Record<string, string>;
  description?: string;
  /**
   * Most upstream calls per minute this gateway makes to the service, for providers that ask for a
   * ceiling (one request a second is common). Every buyer shares the gateway's IP, so the gateway
   * enforces it: a paid call over the limit gets a 429 with Retry-After before any money is held.
   */
  rate_limit_per_minute?: number;
  /**
   * Services with the same group share one rate limit bucket, for providers whose limit covers many
   * hosts (every Wikimedia wiki counts against one budget). The bucket refills at the first such
   * service's rate_limit_per_minute.
   */
  rate_limit_group?: string;
  /** Environment variables the service needs (API keys). If any is unset or empty, loadSpec drops the service and lists it in Spec.skipped. */
  requires?: string[];
  routes: RouteSpec[];
}

export interface Spec {
  realm: string;
  recipient: string;
  rail?: 'ledger' | 'evm';
  /** What prices are denominated in: "USD" (default) or the symbol of the token the evm rail settles in. */
  currency?: string;
  evm?: { rpc: string; chain_id: number; token: string; decimals: number; recipient: string; explorer?: string; eip712?: { name: string; version: string } };
  public_receipts?: boolean;
  services: ServiceSpec[];
  /** Services dropped at load time because a variable in their `requires` list was not set. */
  skipped?: string[];
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
  if (spec.currency === undefined) spec.currency = 'USD';
  if (!isCurrency(spec.currency)) throw new Error(`spec.currency must be 2 to 10 upper-case letters or digits, got ${JSON.stringify(spec.currency)}`);
  if (!Array.isArray(spec.services) || spec.services.length === 0) {
    throw new Error('spec.services is required');
  }
  // a service that needs an API key the environment does not have is dropped, not listed broken
  const skipped: string[] = [];
  spec.services = spec.services.filter((s) => {
    const missing = (s.requires ?? []).filter((name) => !process.env[name]);
    if (missing.length) skipped.push(`${s.name} (needs ${missing.join(', ')})`);
    return missing.length === 0;
  });
  if (skipped.length) spec.skipped = skipped;
  if (spec.services.length === 0) throw new Error(`every service was skipped for missing environment variables: ${skipped.join('; ')}`);
  for (const s of spec.services) {
    if (typeof s.prefix !== 'string' || !s.upstream) throw new Error(`service ${s.name}: prefix and upstream are required`);
    if (s.rate_limit_per_minute !== undefined && !(typeof s.rate_limit_per_minute === 'number' && s.rate_limit_per_minute > 0)) {
      throw new Error(`service ${s.name}: rate_limit_per_minute must be a positive number`);
    }
    if (s.rate_limit_group !== undefined && !s.rate_limit_per_minute) {
      throw new Error(`service ${s.name}: rate_limit_group needs rate_limit_per_minute`);
    }
    for (const r of s.routes) {
      if (r.body_allow !== undefined && (!Array.isArray(r.body_allow) || !r.body_allow.every((k) => typeof k === 'string'))) {
        throw new Error(`service ${s.name} route ${r.path}: body_allow must be a list of key names`);
      }
      if (r.body_fixed !== undefined && (typeof r.body_fixed !== 'object' || r.body_fixed === null || Array.isArray(r.body_fixed))) {
        throw new Error(`service ${s.name} route ${r.path}: body_fixed must be an object`);
      }
      const micro = usdToMicro(r.price); // validate prices early
      // a token with fewer than 6 decimals cannot carry every micro amount
      if (spec.rail === 'evm' && spec.evm && micro > 0) microToBaseUnits(BigInt(micro), spec.evm.decimals);
    }
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

/** Every segment decodes cleanly and none encodes a separator or a dot segment. */
function safePath(path: string): boolean {
  for (const seg of path.split('/')) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { return false; }
    if (d === '.' || d === '..' || /[/\\?#]/.test(d)) return false;
  }
  return true;
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

/**
 * Apply a route's body constraints. Returns the body to forward, or an error
 * message when the buyer sent a key the route does not allow. A route with no
 * constraints forwards the body untouched (any content type). A route with
 * constraints expects JSON: an empty body counts as {}.
 */
export function applyBodyRules(route: RouteSpec, body: Buffer): { body: Buffer; error?: string } {
  if (!route.body_allow && !route.body_fixed) return { body };
  let parsed: unknown = {};
  const text = body.toString('utf8');
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      return { body, error: 'this route takes a JSON object body' };
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body, error: 'this route takes a JSON object body' };
  }
  const obj = parsed as Record<string, unknown>;
  if (route.body_allow) {
    const allowed = new Set([...route.body_allow, ...Object.keys(route.body_fixed ?? {})]);
    const extra = Object.keys(obj).filter((k) => !allowed.has(k));
    if (extra.length) return { body, error: `body keys not allowed on this route: ${extra.join(', ')}` };
  }
  const out = { ...obj, ...(route.body_fixed ?? {}) };
  return { body: Buffer.from(JSON.stringify(out)) };
}

// ---------------------------------------------------------------------------
// server

export interface GatewayOptions {
  store: Store;
  rail?: Rail;
  log?: (msg: string) => void;
  challengeTtlMs?: number; // default 120 s
  upstreamTimeoutMs?: number; // default 60 s
  /**
   * Starter credits, ledger rail only: USD credited once to any wallet that
   * asks via POST /.well-known/tab/faucet. Per-address rate limited. Unset
   * means no faucet.
   */
  faucetUsd?: string;
  faucetPerIpPerDay?: number; // default 20
  /** evm rail only: also take x402 payments (EIP-3009), settled by this key, which pays the gas. */
  x402Settler?: KeyPair;
  /** This gateway's public origin, for the resource URL in x402 requirements. Default: from the Host header. */
  origin?: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Tab-Receipt, Tab-Void, WWW-Authenticate, PAYMENT-REQUIRED, PAYMENT-RESPONSE',
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
  const faucetMicro = opts.faucetUsd != null ? usdToMicro(opts.faucetUsd) : 0;
  if (faucetMicro > 0 && rail.name !== 'ledger') throw new Error('the faucet only works on the ledger rail');
  const faucetPerIpPerDay = opts.faucetPerIpPerDay ?? 20;
  let x402: EvmRail | null = null;
  if (opts.x402Settler) {
    if (!(rail instanceof EvmRail)) throw new Error('x402 needs the evm rail');
    rail.enableX402(opts.x402Settler);
    x402 = rail;
  }
  // the x402 requirements for a priced call, sent next to tab's own challenge on every 402
  const x402Required = (req: IncomingMessage, priceMicro: number, error: string, description?: string): string | null => {
    if (!x402) return null;
    const origin = (opts.origin ?? `http://${req.headers.host ?? 'localhost'}`).replace(/\/$/, '');
    return encodeX402({
      x402Version: X402_VERSION, error,
      resource: { url: origin + (req.url ?? '/'), description, mimeType: 'application/json' },
      accepts: [x402.x402Requirements(priceMicro)],
    });
  };

  const discovery = () => ({
    ver: VERSION,
    realm: spec.realm,
    rail: rail.name,
    rail_info: rail.info(),
    currency: spec.currency,
    recipient: spec.recipient,
    receipt_key: store.receiptKey.publicKey,
    x402: x402?.x402Info() ?? undefined,
    faucet: faucetMicro > 0 ? microToUsd(faucetMicro) : undefined,
    services: spec.services.map((s) => ({
      name: s.name,
      prefix: s.prefix,
      description: s.description,
      ...(s.rate_limit_per_minute ? { rate_limit_per_minute: s.rate_limit_per_minute } : {}),
      ...(s.rate_limit_group ? { rate_limit_group: s.rate_limit_group } : {}),
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
      currency: spec.currency,
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
    extra: Record<string, string> = {},
  ): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/problem+json', ...CORS, ...extra };
    if (challenge) headers['www-authenticate'] = encodeChallengeHeader(challenge);
    res.writeHead(status, headers);
    res.end(problemBody(code, detail, status));
  }

  /** A 402 with a fresh challenge, or 502 if the rail cannot mint one (e.g. dead RPC). */
  async function respondChallenge(
    res: ServerResponse,
    code: ProblemCode,
    detail: string,
    priceMicro: number,
    resource: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    let chal: Challenge;
    try {
      chal = await freshChallenge(priceMicro, resource);
    } catch (err) {
      await respondProblem(res, 'upstream-failed', `payment rail unavailable: ${(err as Error).message}`, 502);
      return;
    }
    const req = (res as ServerResponse & { req?: IncomingMessage }).req;
    const offer = req ? x402Required(req, priceMicro, detail) : null;
    await respondProblem(res, code, detail, 402, chal, { ...(offer ? { 'payment-required': offer } : {}), ...extra });
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
      const { tx, txHash, txSlot } = rail.reserveLocal({ cred, chal, priceMicro, holdId, now });
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
        tx_slot: txSlot ?? null,
        created_at: now.toISOString(),
      };
      try {
        store.createHold(hold);
      } catch (err) {
        const msg = String((err as Error).message);
        if (msg.includes('UNIQUE') && msg.includes('tx_slot')) {
          throw new PayError('payment-expired', 'another payment from this agent at the same nonce is in flight; retry when it settles');
        }
        if (msg.includes('UNIQUE')) {
          throw new PayError('invalid-challenge', 'payment transaction already used for another call');
        }
        throw err;
      }
      return hold;
    });
  }

  // per-service token buckets for rate_limit_per_minute; a bucket holds one second's worth of calls (at least one)
  const buckets = new Map<string, { tokens: number; at: number }>();
  /** Take one upstream call from the service's budget. Returns 0 when allowed, or the seconds to wait. */
  function takeRate(service: ServiceSpec): number {
    const perMinute = service.rate_limit_per_minute;
    if (!perMinute) return 0;
    const perMs = perMinute / 60_000;
    const cap = Math.max(1, perMinute / 60);
    const now = Date.now();
    const key = service.rate_limit_group ? 'group:' + service.rate_limit_group : 'service:' + service.name;
    const b = buckets.get(key) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + (now - b.at) * perMs);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000));
  }
  async function respondRateLimited(res: ServerResponse, service: ServiceSpec, wait: number): Promise<void> {
    res.writeHead(429, { 'content-type': 'application/problem+json', 'retry-after': String(wait), ...CORS });
    const scope = service.rate_limit_group ? `${service.rate_limit_group} services share` : `${service.name} allows`;
    res.end(problemBody('rate-limited', `${scope} ${service.rate_limit_per_minute} calls a minute through this gateway; nothing was charged, retry in ${wait} s`, 429));
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
    // upstream plus the remaining path. A route of "/" on an upstream that already names an
    // endpoint (https://api.example.com/search) forwards to that endpoint as written, since
    // many providers reject a trailing slash.
    const base = match.service.upstream.replace(/\/$/, '');
    const rest = match.rest === '/' && new URL(base).pathname !== '/' ? '' : match.rest;
    let url = base + rest + search;
    const extraQuery = Object.entries(match.service.upstream_query ?? {});
    if (extraQuery.length) {
      const target = new URL(url);
      for (const [k, v] of extraQuery) target.searchParams.set(k, v);
      url = target.toString();
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'expect', 'keep-alive'].includes(key)) continue;
      if (key.startsWith('tab-')) continue; // only the gateway names the payer, owner and hold
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
    read?: Buffer, // the body, when the caller already read it to commit to it
  ): Promise<void> {
    // the upstream may not speak for the gateway: its tab-* headers (a forged receipt) and the
    // hop-by-hop set are dropped, and the gateway's own headers are applied last
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k) || k.startsWith('tab-') || k.startsWith('access-control-')) return;
      headers[k] = v;
    });
    Object.assign(headers, CORS, extra);
    const body = read ?? Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, headers);
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://localhost');
    // routes match and requests forward on the path as sent, still percent-encoded: decoding
    // first let a :param carry ..%2F and walk the upstream to paths nobody priced
    const pathname = u.pathname;
    try {
      if (!safePath(pathname)) {
        sendJson(res, 400, { error: 'path segments may not encode /, \\, ?, #, . or ..' });
        return;
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...CORS,
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, PAYMENT-SIGNATURE',
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
      if (pathname === '/.well-known/tab/faucet' && method === 'POST') {
        if (faucetMicro === 0) {
          sendJson(res, 404, { error: 'this gateway has no faucet' });
          return;
        }
        let wallet = '';
        try {
          wallet = String(JSON.parse((await readBody(req)).toString('utf8') || '{}').wallet ?? '');
        } catch {
          /* fall through to the validation below */
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(wallet)) {
          sendJson(res, 400, { error: 'wallet must be a tab wallet id (base64url public key)' });
          return;
        }
        // forwarded addresses only count from a proxy on this machine; anyone else could invent one per request
        const peer = req.socket.remoteAddress ?? '';
        const viaLocalProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
        const ip = (viaLocalProxy ? String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? peer) : peer)
          .split(',')[0].trim();
        const now = new Date();
        const since = new Date(now.getTime() - 86_400_000).toISOString();
        if (store.faucetClaimsFrom(ip, since) >= faucetPerIpPerDay) {
          sendJson(res, 429, { error: 'too many claims from this address today' });
          return;
        }
        const credited = store.claimFaucet(wallet, ip, faucetMicro, now.toISOString());
        log(`faucet ${wallet} ${credited ? 'credited ' + microToUsd(faucetMicro) : 'already claimed'} (${ip})`);
        sendJson(res, 200, {
          wallet,
          credited: credited ? microToUsd(faucetMicro) : '0.00',
          available: microToUsd(store.balance(wallet)),
          already_claimed: !credited,
        });
        return;
      }
      if (pathname === '/.well-known/tab/receipts' && method === 'GET') {
        if (!spec.public_receipts) {
          sendJson(res, 404, { error: 'receipts are not public on this gateway' });
          return;
        }
        const limit = Number(u.searchParams.get('limit') ?? 50) || 50;
        const payer = u.searchParams.get('payer') ?? undefined;
        const since = u.searchParams.get('since') ?? undefined;
        sendJson(res, 200, { realm: spec.realm, receipts: store.receipts(limit, { payer, since }) });
        return;
      }
      // what one mandate has spent here, by window. A mandate id is the hash of a signed
      // document only its owner and agent hold, so this reveals nothing to anyone else;
      // an owner uses it to attribute spend to the mandate it issued for one job.
      if (pathname.startsWith('/.well-known/tab/mandate/') && pathname.endsWith('/spent') && method === 'GET') {
        const id = pathname.slice('/.well-known/tab/mandate/'.length, -'/spent'.length);
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) {
          sendJson(res, 400, { error: 'mandate id must be a base64url sha256' });
          return;
        }
        const windows = store.spentAll(id);
        const total = windows.reduce((n, w) => n + w.spent, 0);
        sendJson(res, 200, {
          mandate_id: id, realm: spec.realm, currency: spec.currency ?? 'USD',
          spent: microToUsd(total), micro: total,
          windows: windows.map((w) => ({ window_key: w.window_key, spent: microToUsd(w.spent), micro: w.spent })),
        });
        return;
      }

      const match = matchRoute(spec, method, pathname);
      if (!match && method === 'GET' && pathname === '/') {
        // the root, when nothing is priced there: a page for a person, the terms for a program
        const origin = (opts.origin ?? `https://${spec.realm}`).replace(/\/$/, '');
        if (/text\/html/.test(String(req.headers.accept ?? ''))) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=300' });
          res.end(homePage(discovery(), origin));
        } else {
          sendJson(res, 200, { realm: spec.realm, terms: `${origin}/.well-known/tab`, catalog: 'https://paidwithtab.com/catalog', routes: spec.services.reduce((n, sv) => n + sv.routes.length, 0) });
        }
        return;
      }
      if (!match) {
        await respondProblem(res, 'not-found', `no priced route for ${method} ${pathname}`, 404);
        return;
      }
      const priceMicro = usdToMicro(match.route.price);
      const resource = resourceOf(method, pathname);
      const body = await readBody(req);
      // the credential commits to the body the buyer sent; the body forwarded may carry the route's fixed keys
      const rules = applyBodyRules(match.route, body);
      if (rules.error) {
        await respondProblem(res, 'bad-request', rules.error, 400);
        return;
      }
      const forwardBody = rules.body;

      if (priceMicro === 0) {
        // free routes are forwarded unpaid
        const wait = takeRate(match.service);
        if (wait) { await respondRateLimited(res, match.service, wait); return; }
        try {
          const upstream = await forwardUpstream(req, forwardBody, match, u.search, null);
          await relayResponse(res, upstream, {});
          log(`${method} ${pathname} -> ${upstream.status} free ${Date.now() - started}ms`);
        } catch (err) {
          await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
        }
        return;
      }

      // an x402 buyer: a signed EIP-3009 transfer instead of a tab credential
      const x402Header = req.headers['payment-signature'];
      if (x402 && typeof x402Header === 'string' && !req.headers.authorization) {
        const network = x402.x402Requirements(priceMicro).network;
        const refuse = async (code: string, detail: string, status = 402) => {
          const settle: X402SettlementResponse = { success: false, errorReason: code, transaction: '', network };
          const offer = x402Required(req, priceMicro, detail);
          await respondProblem(res, 'verification-failed', detail, status, undefined, { ...(offer ? { 'payment-required': offer } : {}), 'payment-response': encodeX402(settle) });
          log(`${method} ${pathname} -> ${status} x402 ${code}: ${detail}`);
        };
        const payload = decodeX402<X402PaymentPayload>(x402Header);
        if (!payload) { await refuse('invalid_payload', 'PAYMENT-SIGNATURE is not base64 JSON', 400); return; }
        const wait = takeRate(match.service);
        if (wait) { await respondRateLimited(res, match.service, wait); return; }
        let accepted;
        try {
          accepted = await x402.x402Verify(payload, priceMicro);
        } catch (err) {
          const m = /^([a-z0-9_]+): (.*)$/.exec(err instanceof PayError ? err.detail : String((err as Error).message));
          await refuse(m?.[1] ?? 'unexpected_verify_error', m?.[2] ?? String(err));
          return;
        }
        const nonce = accepted.authorization.nonce.toLowerCase();
        const now = new Date();
        const hold: HoldRow = {
          id: randomId(), challenge_id: `x402:${nonce}`, amount: priceMicro, payer: accepted.payer, owner: accepted.payer,
          recipient: spec.recipient, resource, realm: spec.realm, rail: 'evm', mandate_id: 'x402', window_key: '',
          state: 'reserved', ref: null, tx: null, tx_hash: null, tx_slot: `x402:${accepted.payer}:${nonce}`, created_at: now.toISOString(),
        };
        try {
          store.tx(() => {
            if (!store.redeem(`x402:${accepted.payer}:${nonce}`, now.toISOString())) throw new Error('authorization already used');
            store.createHold(hold);
          });
        } catch (err) {
          await refuse('invalid_transaction_state', String((err as Error).message).includes('UNIQUE') ? 'authorization already in flight' : String((err as Error).message));
          return;
        }
        let upstream: Response;
        try {
          upstream = await forwardUpstream(req, forwardBody, match, u.search, hold);
        } catch (err) {
          await releaseHold(hold);
          await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
          return;
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          await releaseHold(hold);
          await relayResponse(res, upstream, { 'tab-void': hold.id });
          log(`${method} ${pathname} -> ${upstream.status} x402 voided ${hold.id}`);
          return;
        }
        let delivered: Buffer;
        try {
          delivered = Buffer.from(await upstream.arrayBuffer());
        } catch (err) {
          await releaseHold(hold);
          await respondProblem(res, 'upstream-failed', `upstream body failed: ${(err as Error).message}`, 502);
          return;
        }
        let hash: string;
        try {
          hash = await x402.x402Settle(accepted);
        } catch (err) {
          // not settled: nothing charged, and the response is withheld, as on the tab path
          await releaseHold(hold);
          res.setHeader('tab-void', hold.id);
          await refuse('invalid_transaction_state', `payment did not settle (${(err as Error).message}); nothing was charged and the response is withheld`);
          return;
        }
        const ref = `evm:${hash}`;
        const receipt: Receipt = signReceipt(store.receiptKey, {
          id: hold.id, realm: spec.realm, resource, amount: String(priceMicro), currency: spec.currency ?? 'USD', rail: 'evm',
          payer: accepted.payer, owner: accepted.payer, recipient: hold.recipient, ref, at: new Date().toISOString(),
          // an x402 buyer has no mandate: the authorization is the policy, its nonce the challenge
          mandate: `x402:${accepted.payer}`, challenge: nonce,
          request: { query: u.search, body_sha256: sha256b64url(body) }, credential: accepted.signature,
          response: { status: upstream.status, body_sha256: sha256b64url(delivered) },
        });
        store.setHoldState(hold.id, 'captured', ref);
        store.addReceipt(receipt);
        const settled: X402SettlementResponse = { success: true, transaction: hash, network, payer: accepted.payer, amount: accepted.amount.toString() };
        await relayResponse(res, upstream, { 'tab-receipt': encodeReceiptHeader(receipt), 'payment-response': encodeX402(settled) }, delivered);
        log(`${method} ${pathname} -> ${upstream.status} x402 paid ${microToUsd(priceMicro)} ${ref} ${Date.now() - started}ms`);
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
      // only a challenge this gateway issued may spend a rate-limit token; the check is stateless
      if (!cred.challenge || typeof cred.challenge.id !== 'string' || !verifyChallengeId(store.secret, cred.challenge)) {
        await respondChallenge(res, 'invalid-challenge', 'challenge was not issued by this gateway', priceMicro, resource);
        return;
      }
      // over the service's upstream rate limit: refuse before any hold, so the buyer pays nothing
      const wait = takeRate(match.service);
      if (wait) { await respondRateLimited(res, match.service, wait); return; }

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
        upstream = await forwardUpstream(req, forwardBody, match, u.search, hold);
      } catch (err) {
        await releaseHold(hold);
        await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
        log(`${method} ${pathname} -> 502 upstream-failed (hold ${hold.id} released)`);
        return;
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        // the receipt commits to the bytes relayed, so read them before any money moves
        let delivered: Buffer;
        try {
          delivered = Buffer.from(await upstream.arrayBuffer());
        } catch (err) {
          await releaseHold(hold);
          await respondProblem(res, 'upstream-failed', `upstream body failed: ${(err as Error).message}`, 502);
          log(`${method} ${pathname} -> 502 upstream body failed (hold ${hold.id} released)`);
          return;
        }
        let ref: string;
        try {
          ref = await rail.capture(hold);
        } catch (err) {
          // The payment did not settle (a broadcast the chain refused, a transfer that reverted):
          // nobody is charged and the response is withheld, so an agent cannot make its own
          // payment fail and keep what it bought.
          await releaseHold(hold);
          res.setHeader('tab-void', hold.id);
          await respondProblem(res, 'payment-expired', `payment did not settle (${(err as Error).message}); nothing was charged and the response is withheld`, 402);
          log(`${method} ${pathname} -> ${upstream.status} capture FAILED, voided ${hold.id}: ${(err as Error).message}`);
          return;
        }
        const receipt: Receipt = signReceipt(store.receiptKey, {
          id: hold.id,
          realm: spec.realm,
          resource,
          amount: String(priceMicro),
          currency: spec.currency ?? 'USD',
          rail: rail.name,
          payer: hold.payer,
          owner: hold.owner,
          recipient: hold.recipient,
          ref,
          at: new Date().toISOString(),
          mandate: hold.mandate_id,
          challenge: hold.challenge_id,
          request: cred.request,
          credential: cred.sig,
          response: { status: upstream.status, body_sha256: sha256b64url(delivered) },
        });
        store.setHoldState(hold.id, 'captured', ref);
        store.addReceipt(receipt);
        await relayResponse(res, upstream, { 'tab-receipt': encodeReceiptHeader(receipt) }, delivered);
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
