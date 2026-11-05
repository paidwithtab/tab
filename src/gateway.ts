// The gateway: a reverse proxy that issues 402 challenges on priced routes,
// verifies credentials, reserves funds, forwards upstream, and captures on 2xx.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PayError,
  VERSION,
  formatAmount,
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
  normalizeUsd,
  verifyChallengeId,
  verifyCredentialSig,
  type Challenge,
  type Credential,
  type ProblemCode,
  type Receipt,
} from './protocol.js';
import { mandateExpired, realmAllowed, verifyMandate, mandateChain, approvalThreshold, perCallCap, type Mandate } from './mandate.js';
import { checkAndSpendChain, refundChain } from './rails/budget.js';
import { revokedIn, verifyRevocation, mayRevoke, type Revocation } from './revoke.js';
import { approvalRequest, approvalProblem, approvalRequestValid, approvalKey, type Approval, type ApprovalRequest } from './approval.js';
import { CHANNEL_PATH, parseVoucherHeader, verifyVoucher, closeMessage } from './channel.js';
import { verifyBytes } from './keys.js';
import { createRail, EvmRail, PayoutPending, PayoutUnknown, LockTimeout, type Rail } from './rails/index.js';
import type { KeyPair } from './keys.js';
import { encodeX402, decodeX402, X402_VERSION, type X402PaymentPayload, type X402SettlementResponse } from './x402.js';
import { channelState, type HoldRow, type Store, type ChannelRow } from './store.js';
import { homePage } from './home.js';
import { EvmRpc } from './evm/rpc.js';
import { evmSend, evmAddressOfKey } from './evm/send.js';
import { erc20, selector, parseTx, hexToBytes, bytesToHex } from './evm/tx.js';

// chains where a faucet would give away real money
const MAINNETS = new Set([1, 10, 56, 137, 4663, 8453, 42161, 43114]);

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
  /**
   * 3.0, pay on delivery: a buyer may opt in to having its payment held until the upstream
   * delivers. An upstream that answers 202 delivers later, by POSTing the result to the URL the
   * gateway sends it in Tab-Deliver; undelivered after timeout_s (default 3600), the money goes back.
   */
  escrow?: { timeout_s?: number } | boolean;
  /**
   * 3.0, metered: on a payment channel the call costs per_unit times the units the upstream
   * reports in a Tab-Units response header, never more than `price`, which per-call buyers pay.
   */
  meter?: { unit: string; per_unit: string };
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
  /** 3.0: take payment channels: one deposit, then signed vouchers per call, settled at close. */
  channels?: { min_deposit?: string; max_ttl_s?: number };
  /** What this gateway is for, in plain words, for people reading its home page and discovery. Blank lines separate paragraphs. */
  about?: string;
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
  if (!isCurrency(spec.currency)) throw new Error(`spec.currency must be 2 to 10 upper-case letters or digits, after at most two lowercase ones (USD, USDG, tTAB), got ${JSON.stringify(spec.currency)}`);
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
      if (r.escrow !== undefined && typeof r.escrow !== 'boolean') {
        const t = (r.escrow as { timeout_s?: unknown }).timeout_s;
        if (typeof r.escrow !== 'object' || r.escrow === null || (t !== undefined && !(typeof t === 'number' && t >= 1 && t <= 30 * 86_400))) {
          throw new Error(`service ${s.name} route ${r.path}: escrow must be true or {"timeout_s": 1 to 2592000}`);
        }
      }
      if (r.meter !== undefined) {
        if (!r.meter || typeof r.meter.unit !== 'string' || !r.meter.unit || typeof r.meter.per_unit !== 'string') {
          throw new Error(`service ${s.name} route ${r.path}: meter needs {"unit": "token", "per_unit": "0.000002"}`);
        }
        if (usdToMicro(r.meter.per_unit) <= 0) throw new Error(`service ${s.name} route ${r.path}: meter.per_unit must be above zero`);
      }
      const micro = usdToMicro(r.price); // validate prices early
      // a token with fewer than 6 decimals cannot carry every micro amount
      if (spec.rail === 'evm' && spec.evm && micro > 0) microToBaseUnits(BigInt(micro), spec.evm.decimals);
    }
  }
  if (spec.channels !== undefined) {
    if (!spec.channels || typeof spec.channels !== 'object') throw new Error('spec.channels must be an object, {} for the defaults');
    if (spec.channels.min_deposit !== undefined) usdToMicro(spec.channels.min_deposit);
    const t = spec.channels.max_ttl_s;
    if (t !== undefined && !(typeof t === 'number' && t >= 60)) throw new Error('spec.channels.max_ttl_s must be at least 60');
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
  /** Largest upstream response body relayed, in bytes; a bigger one is cut off, its payment voided, 502. Default 32 MB. */
  maxUpstreamBytes?: number;
  /**
   * Starter funds: credited once to any wallet that asks via POST /.well-known/tab/faucet, in the gateway's
   * currency. Per-address rate limited. Unset means no faucet. On the ledger rail it is a credit; on the evm
   * rail (testnets only) faucetKey mints the token to the wallet, or transfers it when the token has no open
   * mint, and sends faucetGas of the chain's coin so the wallet can pay for its own transactions.
   */
  faucetUsd?: string;
  faucetKey?: KeyPair;
  faucetGas?: string; // evm: whole ETH, default 0.001
  faucetPerIpPerDay?: number; // default 20
  /** evm rail only: also take x402 payments (EIP-3009), settled by this key, which pays the gas. */
  x402Settler?: KeyPair;
  /** This gateway's public origin, for the resource URL in x402 requirements. Default: from the Host header. */
  origin?: string;
  /**
   * 3.0: other gateways to share revocations with. Each new revocation is pushed to them at once,
   * and their lists are polled every revocationPollMs (default 5 s), so a revoke reaches all within seconds.
   */
  revocationPeers?: string[];
  revocationPollMs?: number;
  /** 3.0, evm rail: the key of the escrow address that holds pay-on-delivery orders and channel deposits, and pays gas to pay them out. */
  escrowKey?: KeyPair;
  /** Revocation and approval posts per minute per client address; default 60. */
  revocationPostsPerMinute?: number;
  /** How many client addresses the post limiter remembers; the least recently seen go first. Default 10000. */
  rateBucketCap?: number;
  /** Wallet balance and evm nonce lookups per minute per client address on an evm-rail gateway (each is an RPC call); default 300. */
  lookupsPerMinute?: number;
  /** Pending revocations (for mandates this gateway never saw) held at once; past it new ones are refused, none evicted. Default 200,000. */
  pendingRevocationCap?: number;
  /** Approvals one owner may have waiting at this gateway at once; default 200. */
  approvalsPerOwner?: number;
  /** How often overdue escrows are refunded and expired channels settled; default 5 s. */
  sweepMs?: number;
  /** A payout that did not settle is tried again after this, doubling each time up to an hour; default 10 s. */
  payoutRetryMs?: number;
  /** Tries before a payout is marked stuck for the operator; default 12. */
  maxPayoutTries?: number;
}

/** Escrow terms of a route, or null when it does not take pay on delivery. */
function escrowTerms(route: RouteSpec): { timeout_s: number } | null {
  if (!route.escrow) return null;
  const t = typeof route.escrow === 'object' ? route.escrow.timeout_s : undefined;
  return { timeout_s: t ?? 3600 };
}

/** A pending revocation (for a mandate this gateway never saw) is held at most this long. */
const PENDING_DEFAULT_MS = 30 * 24 * 3_600_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Tab-Receipt, Tab-Void, Tab-Escrow, Tab-Channel, WWW-Authenticate, PAYMENT-REQUIRED, PAYMENT-RESPONSE',
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
  const maxUpstreamBytes = opts.maxUpstreamBytes ?? 32 * 1024 * 1024;

  /** An upstream body, read with a running cap: one huge answer must not take the gateway's memory with it. */
  async function readUpstream(upstream: Response): Promise<Buffer> {
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxUpstreamBytes) {
      void upstream.body?.cancel().catch(() => {});
      throw new Error(`upstream body is over the ${maxUpstreamBytes} byte cap`);
    }
    if (!upstream.body) return Buffer.alloc(0);
    const reader = upstream.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxUpstreamBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`upstream body is over the ${maxUpstreamBytes} byte cap`);
      }
      parts.push(value);
    }
    return Buffer.concat(parts, total);
  }
  const faucetMicro = opts.faucetUsd != null ? usdToMicro(opts.faucetUsd) : 0;
  if (faucetMicro > 0 && rail.name !== 'ledger') {
    if (!opts.faucetKey) throw new Error('a faucet on the evm rail needs --faucet-key: the wallet that sends the tokens and the gas');
    if (MAINNETS.has(Number(spec.evm?.chain_id))) throw new Error(`the evm faucet is for testnets; chain ${spec.evm?.chain_id} is a mainnet`);
  }
  const faucetRpc = faucetMicro > 0 && rail.name === 'evm' && spec.evm ? new EvmRpc(spec.evm.rpc) : null;
  const faucetGasWei = BigInt(Math.round(Number(opts.faucetGas ?? '0.001') * 1e6)) * 10n ** 12n;
  let faucetQueue: Promise<unknown> = Promise.resolve(); // one faucet transaction at a time, so nonces never collide
  const faucetPerIpPerDay = opts.faucetPerIpPerDay ?? 20;
  const fmt = (micro: number) => formatAmount(micro, spec.currency ?? 'USD');
  if (opts.escrowKey) {
    if (!(rail instanceof EvmRail)) throw new Error('an escrow key is for the evm rail; the ledger rail holds escrow itself');
    rail.enableEscrow(opts.escrowKey, store);
  }
  // pay on delivery and channels need somewhere to hold money: the ledger always has it, evm with an escrow key
  const canHold = rail.escrowRecipient() !== null;
  const channelsOn = !!spec.channels && canHold;
  const minDeposit = spec.channels?.min_deposit ? usdToMicro(spec.channels.min_deposit) : 10_000;
  // the seller's delivery URL and every escrow token derive from the origin; a Host header would let a buyer name its own
  if (canHold && (channelsOn || spec.services.some((s) => s.routes.some((r) => r.escrow))) && !opts.origin) {
    throw new Error('pay on delivery and payment channels need this gateway\'s public origin: start it with --origin https://...');
  }
  const maxChannelTtl = (spec.channels?.max_ttl_s ?? 7 * 86_400) * 1000;
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
    about: spec.about || undefined,
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
        ...(escrowTerms(r) && canHold ? { escrow: escrowTerms(r) } : {}),
        ...(r.meter && channelsOn ? { meter: r.meter } : {}),
      })),
    })),
    // 3.0: what this gateway takes beyond a plain paid call, and where
    features: ['revoke', 'delegation', 'approval', ...(spec.services.some((s) => s.routes.some((r) => r.escrow)) && canHold ? ['escrow'] : []), ...(channelsOn ? ['channels'] : [])],
    revocations: '/.well-known/tab/revocations',
    approvals: '/.well-known/tab/approvals',
    ...(channelsOn ? { channels: { open: CHANNEL_PATH, min_deposit: microToUsd(minDeposit), max_ttl_s: maxChannelTtl / 1000 } } : {}),
  });

  interface ChallengeTerms { escrow?: { timeout_s: number }; recipient?: string }

  async function freshChallenge(priceMicro: number, resource: string, terms: ChallengeTerms = {}): Promise<Challenge> {
    const extras = await rail.challengeExtras(terms.recipient ? { recipient: terms.recipient } : undefined);
    const held = rail.escrowRecipient();
    return makeChallenge(store.secret, {
      realm: spec.realm,
      rail: rail.name,
      amount: String(priceMicro),
      currency: spec.currency,
      recipient: spec.recipient,
      resource,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      nonce: randomId(9),
      ...extras,
      ...(terms.escrow && held !== null ? { escrow: { timeout_s: terms.escrow.timeout_s, ...(rail.name === 'evm' ? { recipient: held } : {}) } } : {}),
    });
  }

  async function respondProblem(
    res: ServerResponse,
    code: ProblemCode,
    detail: string,
    status: number,
    challenge?: Challenge,
    extra: Record<string, string> = {},
    members?: Record<string, unknown>,
  ): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/problem+json', ...CORS, ...extra };
    if (challenge) headers['www-authenticate'] = encodeChallengeHeader(challenge);
    res.writeHead(status, headers);
    res.end(problemBody(code, detail, status, members));
  }

  /** A 402 with a fresh challenge, or 502 if the rail cannot mint one (e.g. dead RPC). */
  async function respondChallenge(
    res: ServerResponse,
    code: ProblemCode,
    detail: string,
    priceMicro: number,
    resource: string,
    extra: Record<string, string> = {},
    terms: ChallengeTerms = {},
    members?: Record<string, unknown>,
  ): Promise<void> {
    let chal: Challenge;
    try {
      chal = await freshChallenge(priceMicro, resource, terms);
    } catch (err) {
      await respondProblem(res, 'upstream-failed', `payment rail unavailable: ${(err as Error).message}`, 502);
      return;
    }
    const req = (res as ServerResponse & { req?: IncomingMessage }).req;
    // a channel deposit is paid to escrow, which x402 cannot express
    const offer = req && !terms.recipient ? x402Required(req, priceMicro, detail) : null;
    await respondProblem(res, code, detail, 402, chal, { ...(offer ? { 'payment-required': offer } : {}), ...extra }, members);
  }

  /** How long a pending revocation posted here is held: until the mandate expires, at most 30 days. */
  function pendingUntil(expiresAt: string): string {
    const cap = Date.now() + PENDING_DEFAULT_MS;
    const t = Date.parse(expiresAt);
    return new Date(Number.isNaN(t) ? cap : Math.min(t, cap)).toISOString();
  }

  /** The first revoked mandate in a chain, as a PayError; null when none is. */
  function revocationError(m: Mandate): PayError | null {
    const revoked = revokedIn(m, (id) => [...store.revocationSigners(id), ...store.pendingRevocations(id).map((p) => p.revocation.by)]);
    if (!revoked) return null;
    // a pending revocation whose mandate is now presented here becomes a full one, shared with peers
    for (const p of store.pendingRevocations(revoked.id)) {
      if (mayRevoke(revoked, p.revocation.by)) { takeRevocations([{ revocation: p.revocation, mandate: revoked }]); store.dropPendingRevocation(revoked.id, p.revocation.by); }
    }
    return new PayError('mandate-revoked', revoked.id === m.id ? `mandate ${m.id} was revoked` : `mandate ${m.id} sits under ${revoked.id}, which was revoked`);
  }

  /**
   * A payment above the chain's approval threshold needs the owner's approval for exactly this
   * request, attached to the credential or posted to this gateway. Returns the key that spends
   * the approval, or null when no approval is needed. Throws approval-required.
   */
  function approvalNeeded(m: Mandate, attached: Approval | undefined, priceMicro: number, resource: string, actual: { query: string; bodySha256: string }, now: Date): { sig: string; expires_at: string; request: string } | null {
    const threshold = approvalThreshold(m);
    if (threshold === null || priceMicro <= threshold) return null;
    const req = approvalRequest({
      owner: mandateChain(m).at(-1)!.owner, payer: m.agent, realm: spec.realm, resource, amount: String(priceMicro),
      currency: spec.currency ?? 'USD', query: actual.query, body_sha256: actual.bodySha256,
    });
    // an approval pays for one call: one already spent counts as none, so the owner is asked again
    const unused = (a: Approval | undefined) => (a && typeof a.sig === 'string' && !store.approvalSpent(approvalKey(a)) ? a : undefined);
    const approval = unused(attached) ?? unused(store.approvalFor(req.id));
    const why = approvalProblem(approval, req, now);
    if (why) {
      throw new PayError('approval-required', `${fmt(priceMicro)} is above the mandate's approval threshold ${fmt(threshold)}: ${why === 'no approval' ? 'the owner must approve this payment, then retry the same request' : why}`, 402, {
        approval_request: req, approvals: '/.well-known/tab/approvals',
      });
    }
    return { sig: approvalKey(approval!), expires_at: approval!.expires_at, request: req.id };
  }

  interface ReserveMode {
    perCall?: boolean; // false for a channel deposit
    payTo?: string; // evm: the escrow address, for a pay-on-delivery order
  }

  /** All the checks before money moves. Throws PayError. Returns the hold. */
  function verifyAndReserve(
    cred: Credential,
    priceMicro: number,
    resource: string,
    actual: { query: string; bodySha256: string },
    now: Date,
    mode: ReserveMode = {},
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
    const revoked = revocationError(cred.mandate);
    if (revoked) throw revoked;
    const approvalId = approvalNeeded(cred.mandate, cred.approval, priceMicro, resource, actual, now);
    const holdId = randomId();
    return store.tx(() => {
      if (!store.redeem(chal.id, now.toISOString())) {
        throw new PayError('invalid-challenge', 'challenge already redeemed');
      }
      // an approval pays for one call; the redeemed set outlives every approval (an hour at most)
      if (approvalId) {
        if (!store.spendApproval(approvalId.sig, approvalId.expires_at)) throw new PayError('approval-required', 'this approval was already used; the owner must approve again');
        store.deleteApproval(approvalId.request); // posted or attached, it is spent: nothing stays to find
      }
      const { key, chain } = checkAndSpendChain(store, cred.mandate, priceMicro, now, { currency: spec.currency, perCall: mode.perCall });
      const { tx, txHash, txSlot } = rail.reserveLocal({ cred, chal, priceMicro, holdId, now, payTo: mode.payTo });
      store.rememberMandates(mandateChain(cred.mandate)); // so a revocation can later be checked against it
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
        chain,
        refund_to: cred.mandate.evm_owner ?? null,
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
    refundChain(store, hold.mandate_id, hold.window_key, hold.chain, hold.amount);
    store.setHoldState(hold.id, 'voided');
  }

  async function forwardUpstream(
    req: IncomingMessage,
    body: Buffer,
    match: Match,
    search: string,
    hold: HoldRow | null,
    extraHeaders: Record<string, string> = {},
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
      // payment-signature and x-payment carry the buyer's x402 authorization: an upstream holding it could settle it first
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'expect', 'keep-alive', 'payment-signature', 'x-payment'].includes(key)) continue;
      if (key.startsWith('tab-')) continue; // only the gateway names the payer, owner and hold
      headers[key] = Array.isArray(v) ? v.join(', ') : v;
    }
    for (const [k, v] of Object.entries(match.service.upstream_headers ?? {})) headers[k.toLowerCase()] = v;
    if (hold) {
      headers['tab-payer'] = hold.payer;
      headers['tab-owner'] = hold.owner;
      headers['tab-hold'] = hold.id;
    }
    Object.assign(headers, extraHeaders);
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
    redact?: string, // a secret no relayed header may carry (the seller's delivery token)
  ): Promise<void> {
    // the upstream may not speak for the gateway: its tab-* headers (a forged receipt) and the
    // hop-by-hop set are dropped, and the gateway's own headers are applied last
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k) || k.startsWith('tab-') || k.startsWith('access-control-')) return;
      if (redact && v.includes(redact)) return;
      headers[k] = v;
    });
    Object.assign(headers, CORS, extra);
    let body: Buffer;
    try {
      body = read ?? await readUpstream(upstream);
    } catch (err) {
      await respondProblem(res, 'upstream-failed', `upstream body failed: ${(err as Error).message}`, 502, undefined, extra);
      return;
    }
    res.writeHead(upstream.status, headers);
    res.end(body);
  }

  // -- 3.0: escrow, channels, revocations ---------------------------------------------------

  /** The client's address: forwarded ones only count from a proxy on this machine; anyone else could invent one per request. */
  function clientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? '';
    const viaLocalProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    return (viaLocalProxy ? String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? peer) : peer).split(',')[0].trim();
  }

  /**
   * This gateway's public origin, as configured. Pay on delivery and channels refuse to start
   * without one (above): the URL the seller delivers to, and every token, must never come from a
   * request header a buyer controls.
   */
  const publicOrigin = () => (opts.origin ?? '').replace(/\/$/, '');

  /** Bearer tokens for one escrow, from the database secret and bound to this origin: the buyer's reads the result, the seller's delivers it. */
  const escrowToken = (side: 'buyer' | 'seller', holdId: string) =>
    createHmac('sha256', store.secret).update(`escrow-${side}:${publicOrigin()}:${holdId}`).digest('base64url');
  const tokenOk = (side: 'buyer' | 'seller', holdId: string, given: unknown) => {
    if (typeof given !== 'string' || !given) return false;
    const want = Buffer.from(escrowToken(side, holdId));
    const got = Buffer.from(given);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const encodeEscrowHeader = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v)).toString('base64url');

  // -- payouts: once per key, never reopened -------------------------------------------------

  const MAX_PAYOUT_TRIES = opts.maxPayoutTries ?? 12;
  const RETRY_MS = opts.payoutRetryMs ?? 10_000;
  const backoffMs = (tries: number) => Math.min(3_600_000, RETRY_MS * 2 ** Math.max(0, tries - 1));

  /**
   * Pay part of a held amount out, once per key. The outcome (seller or buyer) is decided before
   * this is called and is never undone: a payout that fails or does not confirm stays owed under
   * its key and the sweeper settles that same payout later, backing off, and marks it stuck after
   * MAX_PAYOUT_TRIES. Returns the ref as soon as one is known, and whether it is confirmed.
   */
  async function payout(hold: HoldRow, to: 'seller' | 'buyer', micro: number, key: string): Promise<{ ref: string | null; done: boolean }> {
    if (micro <= 0) return { ref: null, done: true };
    const now = new Date();
    let p = store.payout(key);
    if (p?.state === 'confirmed') return { ref: p.ref, done: true };
    if (p?.state === 'stuck') return { ref: p.ref, done: false };
    if (!p) {
      const at = now.toISOString();
      // written first, due a little later, so the sweeper never races the first try
      store.putPayout({ key, hold_id: hold.id, to_addr: to, amount: micro, state: 'pending', ref: null, raw: null, hash: null, nonce: null, attempts: 0, last_error: null, next_try_at: new Date(now.getTime() + RETRY_MS * 6).toISOString(), created_at: at, updated_at: at });
    }
    try {
      const ref = await rail.payoutLocked(hold, to, micro, key);
      const row = store.payout(key)!;
      store.putPayout({ ...row, state: 'confirmed', ref: ref ?? row.ref, updated_at: new Date().toISOString() });
      afterPayout(key, ref, true);
      return { ref, done: true };
    } catch (err) {
      p = store.payout(key)!;
      // the rail recorded the payout as done before the error surfaced: it is done, whatever the error says
      if (p.state === 'confirmed') { afterPayout(key, p.ref, true); return { ref: p.ref, done: true }; }
      const tries = p.attempts + 1;
      const pendingRef = err instanceof PayoutPending ? err.ref : p.ref;
      // a spent nonce no node can account for is the operator's to look at, at once
      const stuck = tries >= MAX_PAYOUT_TRIES || err instanceof PayoutUnknown;
      store.putPayout({ ...p, state: stuck ? 'stuck' : p.state === 'sent' || err instanceof PayoutPending ? 'sent' : 'pending', ref: pendingRef, attempts: tries,
        last_error: String((err as Error).message).slice(0, 500), next_try_at: new Date(Date.now() + backoffMs(tries)).toISOString(), updated_at: new Date().toISOString() });
      log(`payout ${key} ${stuck ? 'STUCK after ' + tries + ' tries, needs the operator' : `not settled (try ${tries}), retrying later`}: ${(err as Error).message}`);
      if (pendingRef) afterPayout(key, pendingRef, false);
      if (stuck) afterPayout(key, null, false, true);
      return { ref: pendingRef, done: false };
    }
  }

  /** Record what a payout did on whatever it pays out: a delivered escrow, a refund, a channel, a late lock. */
  function afterPayout(key: string, ref: string | null, done: boolean, stuck = false): void {
    const [kind, id, side] = key.split(':');
    if (kind === 'escrow') {
      if (stuck) { store.setEscrowPayout(id, 'stuck'); return; }
      if (side === 'seller' && ref) finishDelivery(id, ref);
      if (side === 'buyer' && ref) store.setEscrowRefund(id, { refund_ref: ref, reason: store.escrow(id)?.reason ?? 'refunded' });
      if (done) store.setEscrowPayout(id, 'done');
    } else if (kind === 'channel' && ref) {
      const c = store.channel(id);
      if (c) store.setChannelRefs(id, side === 'seller' ? ref : c.settle_ref, side === 'buyer' ? ref : c.refund_ref);
    } else if (kind === 'lock' && ref) {
      store.setHoldState(id, 'voided', ref);
    }
  }

  /** The delivery receipt, signed once the seller's payout has a ref. */
  function finishDelivery(holdId: string, ref: string): Receipt | null {
    const e = store.escrow(holdId);
    const hold = store.getHold(holdId);
    if (!e || !hold || e.state !== 'delivered' || !e.result) return null;
    if (e.receipt) return e.receipt;
    const receipt: Receipt = signReceipt(store.receiptKey, {
      id: hold.id, realm: spec.realm, resource: e.resource, amount: String(hold.amount), currency: spec.currency ?? 'USD', rail: rail.name,
      payer: hold.payer, owner: hold.owner, recipient: hold.recipient, ref, at: e.settled_at ?? new Date().toISOString(),
      mandate: hold.mandate_id, challenge: hold.challenge_id, request: e.request, credential: e.credential,
      response: { status: e.result_status ?? 200, body_sha256: sha256b64url(e.result) },
      escrow: { deadline: e.deadline, held_ref: e.held_ref ?? undefined, delivered_at: e.settled_at ?? undefined },
    });
    store.setHoldState(hold.id, 'captured', ref);
    store.addReceipt(receipt);
    store.setEscrowDelivery(holdId, { result: e.result, result_type: e.result_type, result_status: e.result_status ?? 200, receipt });
    return receipt;
  }

  /**
   * The seller delivered: the order is delivered for good, the result kept, and the held money paid
   * to the seller. Returns the delivery receipt, or null while the payout has no ref yet (the
   * sweeper finishes it). Throws only when the escrow was not held.
   */
  async function deliverEscrow(holdId: string, status: number, contentType: string | null, result: Buffer): Promise<Receipt | null> {
    const e = store.escrow(holdId);
    const hold = store.getHold(holdId);
    if (!e || !hold) throw new Error('no such escrow');
    if (!store.settleEscrow(holdId, 'delivered', new Date().toISOString())) throw new Error(`escrow is ${e.state}`);
    store.setEscrowDelivery(holdId, { result, result_type: contentType, result_status: status, receipt: null });
    store.setEscrowPayout(holdId, 'pending');
    const { ref } = await payout(hold, 'seller', hold.amount, `escrow:${holdId}:seller`);
    return ref ? finishDelivery(holdId, ref) : null;
  }

  /** Undelivered (deadline passed, or the seller gave up): refunded for good, the money back to the owner and the budget. */
  async function refundEscrow(holdId: string, reason: string): Promise<boolean> {
    const hold = store.getHold(holdId);
    if (!hold || !store.settleEscrow(holdId, 'refunded', new Date().toISOString())) return false;
    refundChain(store, hold.mandate_id, hold.window_key, hold.chain, hold.amount);
    store.setHoldState(hold.id, 'voided');
    store.setEscrowRefund(holdId, { refund_ref: null, reason });
    store.setEscrowPayout(holdId, 'pending');
    await payout(hold, 'buyer', hold.amount, `escrow:${holdId}:buyer`);
    log(`escrow ${holdId} refunded ${fmt(hold.amount)}: ${reason}`);
    return true;
  }

  function escrowView(holdId: string) {
    const e = store.escrow(holdId)!;
    return {
      id: e.hold_id, state: e.state, realm: e.realm, resource: e.resource, amount: microToUsd(e.amount), micro: e.amount,
      currency: spec.currency ?? 'USD', payer: e.payer, owner: e.owner, mandate: e.mandate_id, deadline: e.deadline,
      held_ref: e.held_ref, created_at: e.created_at, settled_at: e.settled_at, receipt: e.receipt, refund_ref: e.refund_ref, reason: e.reason,
      payout: e.payout_state ?? 'none',
      result: e.state === 'delivered' ? `${publicOrigin()}/.well-known/tab/escrow/${e.hold_id}/result` : null,
    };
  }

  /**
   * Close a channel: the spent part to the seller, the rest back to the owner and the budget,
   * and a signed settlement receipt. Throws when it is not open or a call is in flight.
   */
  async function settleChannel(id: string, reason: string, close: { body?: Buffer; sig?: string } = {}): Promise<{ channel: ChannelRow; receipt: Receipt }> {
    const at = new Date().toISOString();
    if (!store.closeChannel(id, at)) {
      const c = store.channel(id);
      throw new PayError('channel-invalid', !c ? 'no such channel' : c.state !== 'open' ? 'channel is already closed' : 'a call is in flight on this channel; close it when that call is done', c && c.state === 'open' ? 409 : 404);
    }
    const c = store.channel(id)!;
    const hold = store.getHold(c.hold_id)!;
    refundChain(store, hold.mandate_id, hold.window_key, hold.chain, c.deposit - c.spent);
    store.setHoldState(hold.id, 'captured', `channel:${id}`);
    const settle = await payout(hold, 'seller', c.spent, `channel:${id}:seller`);
    const refund = await payout(hold, 'buyer', c.deposit - c.spent, `channel:${id}:buyer`);
    if (c.spent <= 0 || c.deposit - c.spent <= 0) {
      const now = store.channel(id)!;
      store.setChannelRefs(id, c.spent <= 0 ? 'none' : now.settle_ref, c.deposit - c.spent <= 0 ? 'none' : now.refund_ref);
    }
    const fresh = store.channel(id)!;
    const receipt = signReceipt(store.receiptKey, {
      id: randomId(), realm: spec.realm, resource: `CLOSE ${CHANNEL_PATH}/${id}`, amount: String(c.spent), currency: spec.currency ?? 'USD',
      rail: rail.name, payer: c.agent, owner: c.owner, recipient: spec.recipient, ref: settle.ref ?? fresh.settle_ref ?? `channel:${id}`, at,
      mandate: c.mandate_id, challenge: `close:${id}`,
      // the close request: the agent's signed close, or nothing when the channel ran out its time
      request: { query: '', body_sha256: sha256b64url(close.body ?? '') }, credential: close.sig ?? '',
      response: { status: 200, body_sha256: '' },
      channel: { id, kind: 'settle', spent: String(c.spent), deposit: String(c.deposit) },
    });
    store.addReceipt(receipt);
    log(`channel ${id} closed (${reason}): ${fmt(c.spent)} to the seller over ${c.calls} calls, ${fmt(c.deposit - c.spent)} back${settle.done && refund.done ? '' : ' (payout owed, the sweeper settles it)'}`);
    return { channel: fresh, receipt };
  }

  /**
   * A lock (the buyer's transfer into escrow) that did not confirm in time: the call failed and
   * nothing opened, but the transfer may still land. The hold is watched; landed money goes back.
   */
  function watchLock(hold: HoldRow, err: unknown): void {
    refundChain(store, hold.mandate_id, hold.window_key, hold.chain, hold.amount);
    store.setHoldState(hold.id, 'lockwatch', err instanceof LockTimeout ? err.ref : null);
    log(`hold ${hold.id}: the payment into escrow did not confirm; watching for it to land, to send it back`);
  }

  /**
   * Lock a hold into escrow. On the evm rail the hold is marked `locking`, with its transaction already
   * on record, before anything is broadcast, so a process killed while the transfer is in flight is
   * found again at the next start (recoverHolds) and its money sent back if it landed.
   */
  const locking = new Set<string>(); // in flight in this process: the sweeper leaves these alone
  async function lockHold(hold: HoldRow): Promise<string> {
    if (rail.name === 'evm' && hold.tx) store.setHoldState(hold.id, 'locking', `evm:${parseTx(hexToBytes(hold.tx)).hash}`);
    locking.add(hold.id);
    try { return await rail.lock(hold); } finally { locking.delete(hold.id); }
  }

  /**
   * At start: holds a previous process left mid-flight. A `locking` hold may have put money in escrow
   * with nothing owning it: it is watched, and refunded if it landed. A `reserved` hold never reached
   * its outcome: on the ledger the owner's debit goes back; on the evm rail its payment is watched
   * (a transfer into escrow like a lock, a direct one to the seller to see whether it was paid).
   */
  function recoverHolds(): void {
    const held = rail.escrowRecipient();
    for (const h of store.holdsInState('locking')) {
      refundChain(store, h.mandate_id, h.window_key, h.chain, h.amount);
      store.setHoldState(h.id, 'lockwatch', h.ref);
      log(`hold ${h.id}: found locking at start; watching its transfer into escrow`);
    }
    for (const h of store.holdsInState('reserved')) {
      if (rail.name === 'ledger') {
        store.credit(h.owner, h.amount);
        refundChain(store, h.mandate_id, h.window_key, h.chain, h.amount);
        store.setHoldState(h.id, 'voided');
        log(`hold ${h.id}: found reserved at start; released`);
        continue;
      }
      if (!h.tx) { store.setHoldState(h.id, 'voided'); refundChain(store, h.mandate_id, h.window_key, h.chain, h.amount); continue; }
      const tx = parseTx(hexToBytes(h.tx));
      const toEscrow = held !== null && bytesToHex(tx.data).includes(held.slice(2));
      if (toEscrow) { refundChain(store, h.mandate_id, h.window_key, h.chain, h.amount); store.setHoldState(h.id, 'lockwatch', `evm:${tx.hash}`); }
      else store.setHoldState(h.id, 'capturewatch', `evm:${tx.hash}`);
      log(`hold ${h.id}: found reserved at start; watching its payment`);
    }
  }

  /** A priced call paid by a channel voucher. */
  async function payByVoucher(
    req: IncomingMessage, res: ServerResponse, auth: string, match: Match, priceMicro: number, resource: string,
    body: Buffer, forwardBody: Buffer, search: string, started: number,
  ): Promise<void> {
    const label = `${req.method} ${resource.split(' ')[1]}`;
    let known: string | null = null; // the channel, once found: its state rides on every refusal so a client can resync
    const refuse = async (code: ProblemCode, detail: string, status = 402) => {
      log(`${label} -> ${status} voucher ${code}: ${detail}`);
      const st = known ? store.channel(known) : undefined;
      await respondProblem(res, code, detail, status, undefined, st ? { 'tab-channel': Buffer.from(JSON.stringify(channelState(st, spec.realm, spec.currency ?? 'USD'))).toString('base64url') } : {});
    };
    if (!channelsOn) return refuse('channel-invalid', 'this gateway takes no payment channels');
    const v = parseVoucherHeader(auth);
    if (!v) return refuse('malformed-credential', 'Authorization header is not a Tab voucher');
    const c = store.channel(v.channel);
    if (!c) return refuse('channel-invalid', 'no such channel');
    known = c.id;
    if (c.state !== 'open') return refuse('channel-invalid', 'channel is closed');
    const now = new Date();
    if (Date.parse(c.expires_at) <= now.getTime()) return refuse('channel-invalid', 'channel expired; open a new one');
    if (!verifyVoucher(v, c.agent)) return refuse('verification-failed', 'voucher signature invalid');
    if (v.resource !== resource || v.query !== search || v.body_sha256 !== sha256b64url(body)) {
      return refuse('verification-failed', 'request does not match the signed voucher');
    }
    const mandate = JSON.parse(c.mandate) as Mandate;
    const revoked = revocationError(mandate);
    if (revoked) return refuse(revoked.code, revoked.detail);
    if (mandateExpired(mandate, now)) return refuse('mandate-invalid', 'mandate expired');
    const cap = perCallCap(mandate);
    if (cap !== null && priceMicro > cap) return refuse('mandate-exceeded', `amount ${fmt(priceMicro)} exceeds the mandate per-call cap ${fmt(cap)}`);
    const threshold = approvalThreshold(mandate);
    if (threshold !== null && priceMicro > threshold) {
      return refuse('approval-required', `${fmt(priceMicro)} is above the mandate's approval threshold ${fmt(threshold)}; pay this call per call so the owner can approve it`);
    }
    const wait = takeRate(match.service);
    if (wait) { await respondRateLimited(res, match.service, wait); return; }
    const amount = Number(v.amount);
    try {
      store.tx(() => {
        if (!store.useVoucher(c.id, v.nonce)) throw new PayError('invalid-challenge', 'voucher already used');
        if (!store.channelReserve(c.id, amount, priceMicro)) {
          const now = store.channel(c.id)!;
          throw new PayError('channel-exhausted', amount > now.deposit
            ? `voucher ${fmt(amount)} is above the deposit ${fmt(now.deposit)}`
            : `voucher must be at least ${fmt(Math.max(now.authorized, now.spent + now.held + priceMicro))} (spent ${fmt(now.spent)}, in flight ${fmt(now.held)}, deposit ${fmt(now.deposit)})`);
        }
      });
    } catch (err) {
      if (err instanceof PayError) return refuse(err.code, err.detail);
      throw err;
    }
    const stateHeader = () => Buffer.from(JSON.stringify(channelState(store.channel(c.id)!, spec.realm, spec.currency ?? 'USD'))).toString('base64url');
    const holdLike = { payer: c.agent, owner: c.owner, id: c.id } as HoldRow;
    let upstream: Response;
    let delivered: Buffer;
    try {
      upstream = await forwardUpstream(req, forwardBody, match, search, holdLike, { 'tab-channel': c.id });
      delivered = await readUpstream(upstream);
    } catch (err) {
      store.channelSettleCall(c.id, priceMicro, 0);
      await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
      return;
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      store.channelSettleCall(c.id, priceMicro, 0);
      await relayResponse(res, upstream, { 'tab-void': c.id, 'tab-channel': stateHeader() }, delivered);
      log(`${label} -> ${upstream.status} voucher voided (channel ${c.id})`);
      return;
    }
    // metered: what the upstream says it used, at the route's unit price, never above the price
    let units: number | undefined;
    let charged = priceMicro;
    const meter = match.route.meter;
    const reported = upstream.headers.get('tab-units');
    if (meter && reported !== null && /^\d+(\.\d+)?$/.test(reported.trim())) {
      units = Number(reported);
      charged = Math.min(priceMicro, Math.ceil(units * usdToMicro(meter.per_unit)));
    }
    store.channelSettleCall(c.id, priceMicro, charged);
    const after = store.channel(c.id)!;
    const receipt = signReceipt(store.receiptKey, {
      id: randomId(), realm: spec.realm, resource, amount: String(charged), currency: spec.currency ?? 'USD', rail: rail.name,
      payer: c.agent, owner: c.owner, recipient: spec.recipient, ref: `channel:${c.id}`, at: new Date().toISOString(),
      mandate: c.mandate_id, challenge: `voucher:${v.nonce}`, request: { query: search, body_sha256: v.body_sha256 }, credential: v.sig,
      response: { status: upstream.status, body_sha256: sha256b64url(delivered) },
      channel: { id: c.id, kind: 'call', spent: String(after.spent), ...(units !== undefined ? { units } : {}) },
    });
    store.addReceipt(receipt);
    await relayResponse(res, upstream, { 'tab-receipt': encodeReceiptHeader(receipt), 'tab-channel': stateHeader() }, delivered);
    log(`${label} -> ${upstream.status} voucher ${fmt(charged)}${units !== undefined ? ` (${units} ${meter!.unit})` : ''} on channel ${c.id} ${Date.now() - started}ms`);
  }

  /**
   * Check one revocation: its signature, and that a real mandate (supplied with it, or one this
   * gateway was paid under) names its signer as someone who may revoke it. Only such revocations are
   * kept, so a stranger's cannot fill the table. Returns the mandate it was checked against, or why not.
   */
  function checkRevocation(r: Revocation, supplied?: unknown): { mandate: Mandate } | { error: string } {
    if (!verifyRevocation(r)) return { error: 'revocation does not verify' };
    const doc = (supplied ?? store.seenMandate(r.mandate)) as Mandate | undefined;
    if (!doc) return { error: 'this gateway has not seen that mandate: post {"revocation": ..., "mandate": <the mandate, or one under it>}' };
    if (!verifyMandate(doc).ok) return { error: 'the mandate sent with it does not verify' };
    const target = mandateChain(doc).find((x) => x.id === r.mandate);
    if (!target) return { error: 'the mandate sent with it is not the one revoked, nor under it' };
    if (!mayRevoke(target, r.by)) return { error: 'the signer may not revoke that mandate' };
    return { mandate: target };
  }

  /** Keep checked revocations in one transaction; tell the peers about the new ones. Returns which were new. */
  function takeRevocations(items: Array<{ revocation: Revocation; mandate: Mandate }>, push = true): boolean[] {
    const at = new Date().toISOString();
    const fresh = store.tx(() => items.map((x) => store.addRevocation(x.revocation, at, x.mandate)));
    const pushed = items.filter((_, i) => fresh[i]);
    for (const x of pushed) log(`revocation of mandate ${x.revocation.mandate} by ${x.revocation.by}`);
    if (push && pushed.length) for (const peer of opts.revocationPeers ?? []) {
      void fetch(`${peer.replace(/\/$/, '')}/.well-known/tab/revocations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pushed), signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* the peer polls us too */ });
    }
    return fresh;
  }

  // revocation intake per client address: a bucket of revocationPostsPerMinute
  const revBuckets = new Map<string, { tokens: number; at: number }>();
  function revocationAllowed(ip: string): boolean {
    const perMinute = opts.revocationPostsPerMinute ?? 60;
    const now = Date.now();
    const b = revBuckets.get(ip) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) * perMinute) / 60_000);
    b.at = now;
    revBuckets.delete(ip); // re-inserted last: the map stays ordered by last use
    revBuckets.set(ip, b);
    // past the cap the least recently used address goes, never everyone's limit at once
    while (revBuckets.size > (opts.rateBucketCap ?? 10_000)) revBuckets.delete(revBuckets.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // wallet and nonce lookups on the evm rail are RPC calls: a bucket per client address keeps one client from spending the quota
  const lookupBuckets = new Map<string, { tokens: number; at: number }>();
  function lookupAllowed(ip: string): boolean {
    if (rail.name !== 'evm') return true;
    const perMinute = opts.lookupsPerMinute ?? 300;
    const now = Date.now();
    const b = lookupBuckets.get(ip) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) * perMinute) / 60_000);
    b.at = now;
    lookupBuckets.delete(ip);
    lookupBuckets.set(ip, b);
    while (lookupBuckets.size > (opts.rateBucketCap ?? 10_000)) lookupBuckets.delete(lookupBuckets.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // poll the peers' revocation lists, from the last sequence number read from each
  const peerCursor = new Map<string, number>();
  async function pollPeers(): Promise<void> {
    for (const peer of opts.revocationPeers ?? []) {
      const origin = peer.replace(/\/$/, '');
      try {
        for (let page = 0; page < 20; page++) {
          const after = peerCursor.get(origin) ?? 0;
          const r = await fetch(`${origin}/.well-known/tab/revocations?after=${after}`, { signal: AbortSignal.timeout(5_000) });
          if (!r.ok) break;
          const doc = (await r.json()) as { revocations?: Array<Revocation & { seq?: number; expires_at?: string | null }> };
          const rows = doc.revocations ?? [];
          const ok: Array<{ revocation: Revocation; mandate: Mandate }> = [];
          const at = new Date().toISOString();
          for (const x of rows) {
            // a peer serves the revocation alone: kept in full when this gateway was paid under that mandate
            // (checked against it here), otherwise pending, checked against the mandate when it is presented
            const rev: Revocation = { ver: x.ver, mandate: x.mandate, by: x.by, revoked_at: x.revoked_at, ...(x.reason !== undefined ? { reason: x.reason } : {}), sig: x.sig };
            if (!verifyRevocation(rev)) continue;
            if (store.seenMandate(rev.mandate)) {
              const c = checkRevocation(rev);
              if ('mandate' in c) ok.push({ revocation: rev, mandate: c.mandate });
              continue;
            }
            const until = typeof x.expires_at === 'string' && !Number.isNaN(Date.parse(x.expires_at)) ? x.expires_at : new Date(Date.now() + PENDING_DEFAULT_MS).toISOString();
            if (store.addPendingRevocation(rev, until, at, opts.pendingRevocationCap) === null) log(`pending revocation table full: dropped ${rev.mandate} from ${origin}`);
          }
          if (ok.length) takeRevocations(ok, false);
          const last = rows.at(-1)?.seq;
          if (typeof last === 'number' && last > after) peerCursor.set(origin, last);
          if (rows.length < 500) break;
        }
      } catch { /* try again next round */ }
    }
  }

  /** Refund overdue escrows, settle expired or revoked channels, retry payouts that failed. */
  let sweeping = false;
  let lastReconcile = 0;
  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = new Date();
      for (const e of store.overdueEscrows(now.toISOString())) await refundEscrow(e.hold_id, 'not delivered by the deadline');
      for (const c of store.openChannels()) {
        const revoked = revocationError(JSON.parse(c.mandate) as Mandate);
        if (Date.parse(c.expires_at) <= now.getTime() || revoked) {
          try { await settleChannel(c.id, revoked ? 'mandate revoked' : 'expired'); } catch { /* a call in flight: next round */ }
        }
      }
      // payouts still owed, each settled under its own key: the same payout, never a second one
      for (const p of store.duePayouts(now.toISOString())) {
        const hold = store.getHold(p.hold_id);
        if (hold) await payout(hold, p.key.endsWith(':seller') ? 'seller' : 'buyer', p.amount, p.key);
      }
      // stuck payouts whose transaction landed after all go back to the books, once a minute
      if (rail.reconcilePayout && Date.now() - lastReconcile > 60_000) {
        lastReconcile = Date.now();
        for (const p of store.stuckPayouts()) {
          try { if (await rail.reconcilePayout(p)) { afterPayout(p.key, p.ref, true); log(`payout ${p.key} was stuck and has landed: ${p.ref}`); } } catch { /* next time */ }
        }
      }
      // locks that timed out: landed money goes back, a transfer that cannot land any more closes the watch
      if (rail.lockStatus) for (const h of store.holdsInState('capturewatch')) {
        // a direct payment a crashed process left: paid means the seller has it; failed means it never moved
        let st: 'landed' | 'failed' | 'pending';
        try { st = await rail.lockStatus(h); } catch { continue; }
        if (st === 'landed') store.setHoldState(h.id, 'captured', h.ref);
        else if (st === 'failed') { refundChain(store, h.mandate_id, h.window_key, h.chain, h.amount); store.setHoldState(h.id, 'voided', h.ref); }
      }
      if (rail.lockStatus) for (const h of store.lockWatches()) {
        if (locking.has(h.id)) continue;
        let st: 'landed' | 'failed' | 'pending';
        try { st = await rail.lockStatus(h); } catch { continue; }
        if (st === 'failed') store.setHoldState(h.id, 'voided', h.ref);
        else if (st === 'landed') {
          const out = await payout(h, 'buyer', h.amount, `lock:${h.id}:buyer`);
          if (out.ref) store.setHoldState(h.id, 'voided', out.ref);
        }
      }
      store.pruneApprovals(new Date(now.getTime() - 3_600_000).toISOString());
      store.prunePendingRevocations(now.toISOString());
    } catch (err) {
      log(`sweep error: ${(err as Error).message}`);
    } finally {
      sweeping = false;
    }
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
          'access-control-allow-headers': 'Authorization, Content-Type, PAYMENT-SIGNATURE, Tab-Escrow-Token',
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
        if (!lookupAllowed(clientIp(req))) { sendJson(res, 429, { error: 'too many lookups from this address; retry in a minute' }); return; }
        try {
          const micro = await rail.balance(wallet);
          sendJson(res, 200, { wallet, rail: rail.name, currency: spec.currency ?? 'USD', available: microToUsd(micro), micro });
        } catch (err) {
          sendJson(res, 502, { error: `balance lookup failed: ${(err as Error).message}` });
        }
        return;
      }
      if (pathname.startsWith('/.well-known/tab/evm/nonce/') && method === 'GET' && rail.accountNonce) {
        const address = pathname.slice('/.well-known/tab/evm/nonce/'.length);
        if (!lookupAllowed(clientIp(req))) { sendJson(res, 429, { error: 'too many lookups from this address; retry in a minute' }); return; }
        try {
          sendJson(res, 200, { address: address.toLowerCase(), nonce: await rail.accountNonce(address) });
        } catch (err) {
          sendJson(res, 502, { error: `nonce lookup failed: ${(err as Error).message}` });
        }
        return;
      }
      if (pathname === '/.well-known/tab/faucet' && method === 'GET') {
        // what the faucet gives and how much is left, for the claim form on the home page
        if (faucetMicro === 0) {
          sendJson(res, 404, { error: 'this gateway has no faucet' });
          return;
        }
        const status: Record<string, unknown> = { amount: microToUsd(faucetMicro), currency: spec.currency ?? 'USD', claimed: store.faucetClaimCount() };
        if (faucetRpc) {
          const address = evmAddressOfKey(opts.faucetKey!);
          let eth: bigint | null = null;
          try { eth = await faucetRpc.balance(address); } catch { /* unknown: the form stays open */ }
          // each claim may send the gas gift plus two transactions' fees; count it as 1.1 gifts
          Object.assign(status, { gas: opts.faucetGas ?? '0.001', address, claims_left: eth === null || faucetGasWei === 0n ? null : Number((eth * 10n) / (faucetGasWei * 11n)) });
        }
        sendJson(res, 200, status);
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
        const evmFaucet = faucetRpc !== null;
        if (evmFaucet ? !/^0x[0-9a-fA-F]{40}$/.test(wallet) : !/^[A-Za-z0-9_-]{43}$/.test(wallet)) {
          sendJson(res, 400, { error: evmFaucet ? 'wallet must be a 0x address on this chain (tab evm address <key> prints yours)' : 'wallet must be a tab wallet id (base64url public key)' });
          return;
        }
        if (evmFaucet) wallet = wallet.toLowerCase();
        const ip = clientIp(req);
        const now = new Date();
        const since = new Date(now.getTime() - 86_400_000).toISOString();
        if (store.faucetClaimsFrom(ip, since) >= faucetPerIpPerDay) {
          sendJson(res, 429, { error: 'too many claims from this address today' });
          return;
        }
        if (evmFaucet) {
          if (!store.recordFaucetClaim(wallet, ip, faucetMicro, now.toISOString())) {
            sendJson(res, 200, { wallet, credited: '0.00', already_claimed: true });
            return;
          }
          const ev = spec.evm!;
          const key = opts.faucetKey!;
          const run = faucetQueue.then(async () => {
            const txs: Array<{ kind: string; hash: string }> = [];
            const amount = microToBaseUnits(BigInt(faucetMicro), ev.decimals);
            // an open-mint test token mints to the wallet; any other token comes out of the faucet's own balance
            const mint = new Uint8Array([...selector('mint(address,uint256)'), ...erc20.transfer(wallet, amount).slice(4)]);
            let canMint = true;
            try { await faucetRpc!.ethCall(ev.token.toLowerCase(), mint, evmAddressOfKey(key)); } catch { canMint = false; }
            txs.push({ kind: canMint ? 'mint' : 'transfer', hash: await evmSend(faucetRpc!, key, ev.token.toLowerCase(), 0n, canMint ? mint : erc20.transfer(wallet, amount)) });
            if (faucetGasWei > 0n && (await faucetRpc!.balance(wallet)) < faucetGasWei / 2n) txs.push({ kind: 'gas', hash: await evmSend(faucetRpc!, key, wallet, faucetGasWei, new Uint8Array(0)) });
            return txs;
          });
          faucetQueue = run.catch(() => {});
          try {
            const txs = await run;
            log(`faucet ${wallet} sent ${microToUsd(faucetMicro)} ${spec.currency ?? 'USD'} (${ip})`);
            sendJson(res, 200, { wallet, credited: microToUsd(faucetMicro), currency: spec.currency ?? 'USD', gas: txs.some((t) => t.kind === 'gas') ? opts.faucetGas ?? '0.001' : '0', txs, explorer: ev.explorer ?? null, already_claimed: false });
          } catch (err) {
            store.dropFaucetClaim(wallet);
            log(`faucet ${wallet} failed: ${(err as Error).message}`);
            sendJson(res, 502, { error: 'the faucet could not send right now; try again later' });
          }
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

      // -- 3.0: revocations --------------------------------------------------------------
      if (pathname === '/.well-known/tab/revocations' && method === 'POST') {
        if (!revocationAllowed(clientIp(req))) { sendJson(res, 429, { error: 'too many revocation posts from this address; retry in a minute' }); return; }
        const raw = await readBody(req);
        if (raw.length > 512 * 1024) { sendJson(res, 413, { error: 'post at most 512 KB of revocations at a time' }); return; }
        let doc: unknown;
        try { doc = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { error: 'body must be a revocation, {revocation, mandate}, or a list of them' }); return; }
        const list = (Array.isArray(doc) ? doc : [doc]).slice(0, 100) as Array<Revocation | { revocation: Revocation; mandate?: unknown }>;
        const checked = list.map((x) => {
          const r = (x && typeof x === 'object' && 'revocation' in x ? x.revocation : x) as Revocation;
          const supplied = x && typeof x === 'object' && 'revocation' in x ? x.mandate : undefined;
          return { r, c: checkRevocation(r, supplied) };
        });
        // a revocation of a mandate this gateway was paid under is kept and shared; one for a mandate it never
        // saw (anyone can mint mandates, and sub-mandates under a paid one, and revoke them) is held pending, not
        // shared, until that mandate is presented here
        const valid = checked.filter((x) => 'mandate' in x.c).map((x) => ({ revocation: x.r, mandate: (x.c as { mandate: Mandate }).mandate }));
        const known = valid.filter((x) => store.seenMandate(x.mandate.id));
        const fresh = known.length ? takeRevocations(known) : [];
        const at = new Date().toISOString();
        let full = false;
        const results = checked.map((x) => {
          if (!('mandate' in x.c)) return { mandate: x.r?.mandate ?? null, error: (x.c as { error: string }).error };
          const k = known.findIndex((y) => y.revocation === x.r);
          if (k >= 0) return { mandate: x.r.mandate, by: x.r.by, new: fresh[k] };
          const m = (x.c as { mandate: Mandate }).mandate;
          const added = store.addPendingRevocation(x.r, pendingUntil(m.expires_at), at, opts.pendingRevocationCap);
          if (added === null) { full = true; return { mandate: x.r.mandate, by: x.r.by, error: 'this gateway holds too many pending revocations; post it with the mandate at a gateway that was paid under it' }; }
          return { mandate: x.r.mandate, by: x.r.by, new: added, pending: true };
        });
        sendJson(res, full ? 503 : results.some((x) => 'error' in x) && list.length === 1 ? 400 : 200, { results });
        return;
      }
      if (pathname === '/.well-known/tab/revocations' && method === 'GET') {
        const after = Number(u.searchParams.get('after') ?? 0) || 0;
        const rows = store.revocationsAfter(after, Number(u.searchParams.get('limit') ?? 500) || 500);
        // the revoked mandate's terms stay here: its keys, limits and parent chain are nobody else's business
        sendJson(res, 200, { realm: spec.realm, revocations: rows.map((r) => ({ ...r.revocation, seq: r.seq, received_at: r.received_at, expires_at: (r.mandate as Mandate | null)?.expires_at ?? null })) });
        return;
      }
      if (pathname.startsWith('/.well-known/tab/revocations/') && method === 'GET') {
        const id = pathname.slice('/.well-known/tab/revocations/'.length);
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) { sendJson(res, 400, { error: 'mandate id must be a base64url sha256' }); return; }
        // every one held was checked on intake against a mandate naming its signer, so revoked means revoked
        // pending ones (for a mandate never paid under here) count too: they are checked at payment
        const pending = store.pendingRevocations(id).map((p) => p.revocation);
        const revocations = [...store.revocationsOf(id), ...pending];
        sendJson(res, 200, { mandate: id, revoked: revocations.length > 0, signers: revocations.map((r) => r.by), revocations, ...(pending.length ? { pending: pending.length } : {}) });
        return;
      }

      // -- 3.0: approvals the owner posts, for an agent's retry to find --------------------
      if (pathname === '/.well-known/tab/approvals' && method === 'POST') {
        if (!revocationAllowed(clientIp(req))) { sendJson(res, 429, { error: 'too many posts from this address; retry in a minute' }); return; }
        let doc: { approval?: Approval; request?: ApprovalRequest } = {};
        try { doc = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* checked below */ }
        if (!doc.request || !approvalRequestValid(doc.request) || doc.request.realm !== spec.realm) {
          sendJson(res, 400, { error: 'post {"request": <the approval_request this gateway sent>, "approval": <the owner\'s approval>}' });
          return;
        }
        const why = approvalProblem(doc.approval, doc.request);
        if (why) { sendJson(res, 400, { error: why }); return; }
        // only for an owner whose mandates this gateway was paid under, and never more than a bounded number at once
        if (!store.ownerSeen(doc.request.owner)) { sendJson(res, 400, { error: 'this gateway has not been paid under any mandate of that owner; attach the approval to the retry instead' }); return; }
        store.pruneApprovals(new Date().toISOString());
        if (store.approvalCount() >= 5_000) { sendJson(res, 503, { error: 'too many approvals waiting here; attach this one to the retry instead' }); return; }
        // and one owner cannot take the whole table: a few hundred waiting approvals each
        if (!store.approvalFor(doc.request.id) && store.approvalCountOf(doc.request.owner) >= (opts.approvalsPerOwner ?? 200)) { sendJson(res, 503, { error: 'too many of this owner\'s approvals are waiting here; attach this one to the retry instead' }); return; }
        store.putApproval(doc.request.id, doc.approval!);
        log(`approval for ${doc.request.resource} ${fmt(Number(doc.request.amount))} by ${doc.request.owner}`);
        sendJson(res, 200, { ok: true, request: doc.request.id, expires_at: doc.approval!.expires_at });
        return;
      }
      if (pathname.startsWith('/.well-known/tab/approvals/') && method === 'GET') {
        const id = pathname.slice('/.well-known/tab/approvals/'.length);
        const a = /^[A-Za-z0-9_-]{43}$/.test(id) ? store.approvalFor(id) : undefined;
        sendJson(res, 200, { request: id, approved: !!a && Date.parse(a.expires_at) > Date.now(), expires_at: a?.expires_at ?? null });
        return;
      }

      // -- 3.0: pay on delivery ----------------------------------------------------------
      if (pathname === '/.well-known/tab/escrow' && method === 'GET') {
        // a payer's orders, like receipts: only where receipts are public
        if (!spec.public_receipts) { sendJson(res, 404, { error: 'orders are not public on this gateway' }); return; }
        const list = store.escrowsOf({ payer: u.searchParams.get('payer') ?? undefined, since: u.searchParams.get('since') ?? undefined, limit: Number(u.searchParams.get('limit') ?? 50) || 50 });
        sendJson(res, 200, { realm: spec.realm, orders: list.map((e) => escrowView(e.hold_id)) });
        return;
      }
      const em = /^\/\.well-known\/tab\/escrow\/([A-Za-z0-9_-]{8,64})(?:\/(result|deliver|fail))?$/.exec(pathname);
      if (em) {
        const [, id, action] = em;
        const e = store.escrow(id);
        if (!e) { sendJson(res, 404, { error: 'no such escrow' }); return; }
        if (!action && method === 'GET') {
          if (!tokenOk('buyer', id, u.searchParams.get('token') ?? req.headers['tab-escrow-token']) && !tokenOk('seller', id, req.headers['tab-delivery-token'])) {
            sendJson(res, 403, { error: 'the escrow token from the Tab-Escrow header is required' });
            return;
          }
          // a deadline that passed refunds now, not at the next sweep
          if (e.state === 'held' && Date.parse(e.deadline) <= Date.now()) await refundEscrow(id, 'not delivered by the deadline');
          sendJson(res, 200, escrowView(id));
          return;
        }
        if (action === 'result' && method === 'GET') {
          if (!tokenOk('buyer', id, u.searchParams.get('token') ?? req.headers['tab-escrow-token'])) { sendJson(res, 403, { error: 'the escrow token is required' }); return; }
          if (e.state !== 'delivered' || !e.result) { sendJson(res, 409, { error: `escrow is ${e.state}`, state: e.state }); return; }
          // the seller's bytes, served from the gateway's origin: never rendered or sniffed as a page of that origin
          res.writeHead(e.result_status ?? 200, {
            'content-type': e.result_type ?? 'application/octet-stream', ...CORS,
            'x-content-type-options': 'nosniff', 'content-disposition': 'attachment', 'content-security-policy': "sandbox; default-src 'none'",
            ...(e.receipt ? { 'tab-receipt': encodeReceiptHeader(e.receipt) } : {}),
          });
          res.end(e.result);
          return;
        }
        if ((action === 'deliver' || action === 'fail') && method === 'POST') {
          if (!tokenOk('seller', id, req.headers['tab-delivery-token'])) { sendJson(res, 403, { error: 'the Tab-Delivery-Token the gateway sent upstream is required' }); return; }
          const result = await readBody(req);
          if (e.state !== 'held') { sendJson(res, 409, { error: `escrow is ${e.state}`, state: e.state }); return; }
          if (Date.parse(e.deadline) <= Date.now()) {
            await refundEscrow(id, 'not delivered by the deadline');
            sendJson(res, 410, { error: 'past the deadline; the buyer was refunded', state: 'refunded' });
            return;
          }
          if (action === 'fail') {
            const ok = await refundEscrow(id, `the seller could not deliver${req.headers['tab-reason'] ? `: ${String(req.headers['tab-reason']).slice(0, 200)}` : ''}`);
            sendJson(res, ok ? 200 : 409, ok ? { state: 'refunded' } : { error: 'the order is no longer held' });
            return;
          }
          const status = Number(req.headers['tab-result-status'] ?? 200);
          if (!Number.isInteger(status) || status < 200 || status > 299 || status === 202) { sendJson(res, 400, { error: 'Tab-Result-Status must be a 2xx other than 202' }); return; }
          try {
            const receipt = await deliverEscrow(id, status, (req.headers['content-type'] as string | undefined) ?? null, result);
            log(`escrow ${id} delivered: ${fmt(e.amount)} to the seller ${receipt?.ref ?? '(payout owed)'}`);
            sendJson(res, 200, { state: 'delivered', receipt, ...(receipt ? {} : { payout: 'owed; the gateway settles it and signs the receipt' }) });
          } catch (err) {
            sendJson(res, 409, { error: (err as Error).message });
          }
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      // -- 3.0: payment channels ---------------------------------------------------------
      if (pathname === CHANNEL_PATH && method === 'POST') {
        if (!channelsOn) { await respondProblem(res, 'not-found', 'this gateway takes no payment channels', 404); return; }
        const raw = await readBody(req);
        let deposit = 0;
        let ttlMs = maxChannelTtl;
        try {
          const doc = JSON.parse(raw.toString('utf8')) as { deposit?: unknown; ttl_s?: unknown };
          deposit = usdToMicro(normalizeUsd(String(doc.deposit ?? '')));
          if (doc.ttl_s !== undefined) ttlMs = Math.min(maxChannelTtl, Math.max(60, Number(doc.ttl_s) || 0) * 1000);
        } catch {
          await respondProblem(res, 'bad-request', 'body must be {"deposit": "1.00", "ttl_s": 86400}', 400);
          return;
        }
        if (deposit < minDeposit) { await respondProblem(res, 'bad-request', `the smallest deposit is ${fmt(minDeposit)}`, 400); return; }
        if (rail.name === 'evm' && spec.evm) { try { microToBaseUnits(BigInt(deposit), spec.evm.decimals); } catch (err) { await respondProblem(res, 'bad-request', (err as Error).message, 400); return; } }
        const resource = resourceOf('POST', CHANNEL_PATH);
        const terms: ChallengeTerms = rail.name === 'evm' ? { recipient: rail.escrowRecipient()! } : {};
        const auth = req.headers.authorization;
        if (!auth) { await respondChallenge(res, 'payment-required', `a deposit of ${fmt(deposit)} opens the channel`, deposit, resource, {}, terms); return; }
        const cred = parseCredentialHeader(auth);
        if (!cred || !cred.challenge || !verifyChallengeId(store.secret, cred.challenge)) {
          await respondChallenge(res, cred ? 'invalid-challenge' : 'malformed-credential', 'pay the deposit with a Tab credential for a challenge this gateway issued', deposit, resource, {}, terms);
          return;
        }
        const now = new Date();
        let hold: HoldRow;
        try {
          hold = verifyAndReserve(cred, deposit, resource, { query: u.search, bodySha256: sha256b64url(raw) }, now, { perCall: false });
          if (rail.reserveRemote) {
            try { await rail.reserveRemote(hold); } catch (err) {
              refundChain(store, hold.mandate_id, hold.window_key, hold.chain, hold.amount);
              store.setHoldState(hold.id, 'voided');
              throw err instanceof PayError ? err : new PayError('verification-failed', String((err as Error).message));
            }
          }
        } catch (err) {
          if (err instanceof PayError) { await respondChallenge(res, err.code, err.detail, deposit, resource, {}, terms, err.extra); return; }
          throw err;
        }
        let heldRef: string;
        try {
          heldRef = await lockHold(hold);
        } catch (err) {
          if (err instanceof LockTimeout) watchLock(hold, err);
          else await releaseHold(hold);
          await respondProblem(res, 'payment-expired', `deposit did not settle (${(err as Error).message}); no channel was opened${err instanceof LockTimeout ? ', and if it lands it is sent back' : ''}`, 402);
          return;
        }
        const id = randomId(16);
        const expires = Math.min(now.getTime() + ttlMs, Date.parse(cred.mandate.expires_at));
        // escrowed and the channel that owns the money, together: no crash can leave one without the other
        store.tx(() => {
          store.setHoldState(hold.id, 'escrowed', heldRef);
          store.createChannel({
            id, hold_id: hold.id, agent: cred.agent, owner: cred.mandate.owner, mandate: JSON.stringify(cred.mandate), mandate_id: cred.mandate.id,
            deposit, state: 'open', opened_at: now.toISOString(), expires_at: new Date(expires).toISOString(),
          });
        });
        const receipt = signReceipt(store.receiptKey, {
          id: hold.id, realm: spec.realm, resource, amount: String(deposit), currency: spec.currency ?? 'USD', rail: rail.name,
          payer: cred.agent, owner: cred.mandate.owner, recipient: spec.recipient, ref: heldRef, at: now.toISOString(),
          mandate: cred.mandate.id, challenge: hold.challenge_id, request: cred.request, credential: cred.sig,
          response: { status: 201, body_sha256: '' }, channel: { id, kind: 'deposit', deposit: String(deposit) },
        });
        store.addReceipt(receipt);
        const state = channelState(store.channel(id)!, spec.realm, spec.currency ?? 'USD');
        res.writeHead(201, { 'content-type': 'application/json', ...CORS, 'tab-receipt': encodeReceiptHeader(receipt), 'tab-channel': Buffer.from(JSON.stringify(state)).toString('base64url') });
        res.end(JSON.stringify({ channel: state, receipt }, null, 1));
        log(`channel ${id} opened by ${cred.agent}: ${fmt(deposit)} held (${heldRef})`);
        return;
      }
      if (pathname === CHANNEL_PATH && method === 'GET') {
        const agent = u.searchParams.get('agent') ?? undefined;
        const owner = u.searchParams.get('owner') ?? undefined;
        if (!spec.public_receipts) { sendJson(res, 404, { error: 'channels are not listed on this gateway' }); return; }
        if (!agent && !owner) { sendJson(res, 400, { error: 'name an agent or an owner wallet id' }); return; }
        sendJson(res, 200, { realm: spec.realm, channels: store.channelsOf({ agent, owner }).map((c) => channelState(c, spec.realm, spec.currency ?? 'USD')) });
        return;
      }
      const chm = /^\/\.well-known\/tab\/channels\/([A-Za-z0-9_-]{8,64})(?:\/(close))?$/.exec(pathname);
      if (chm) {
        const [, id, action] = chm;
        const c = store.channel(id);
        if (!c) { sendJson(res, 404, { error: 'no such channel' }); return; }
        if (!action && method === 'GET') { sendJson(res, 200, { channel: channelState(c, spec.realm, spec.currency ?? 'USD') }); return; }
        if (action === 'close' && method === 'POST') {
          let sig = '';
          const closeBody = await readBody(req);
          try { sig = String(JSON.parse(closeBody.toString('utf8') || '{}').sig ?? ''); } catch { /* checked below */ }
          const expired = Date.parse(c.expires_at) <= Date.now();
          if (!expired && !verifyBytes(c.agent, closeMessage(id), sig)) { sendJson(res, 403, { error: 'closing early takes the channel agent\'s signature: {"sig": ...}' }); return; }
          try {
            const out = await settleChannel(id, expired ? 'expired' : 'closed by the agent', expired ? {} : { body: closeBody, sig });
            sendJson(res, 200, { channel: channelState(out.channel, spec.realm, spec.currency ?? 'USD'), receipt: out.receipt });
          } catch (err) {
            if (err instanceof PayError) { sendJson(res, err.status, { error: err.detail }); return; }
            throw err;
          }
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      const match = matchRoute(spec, method, pathname);
      if (!match && method === 'GET' && pathname === '/') {
        // the root, when nothing is priced there: a page for a person, the terms for a program
        const origin = (opts.origin ?? `https://${spec.realm}`).replace(/\/$/, '');
        if (/text\/html/.test(String(req.headers.accept ?? ''))) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=300', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin' });
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
      const routeEscrow = canHold ? escrowTerms(match.route) : null;
      const terms: ChallengeTerms = routeEscrow ? { escrow: routeEscrow } : {};
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
          delivered = await readUpstream(upstream);
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
        await respondChallenge(res, 'payment-required', `payment of ${fmt(priceMicro)} required`, priceMicro, resource, {}, terms);
        return;
      }
      // 3.0: a voucher from an open payment channel instead of a per-call payment
      if (/^\s*TabVoucher\s/.test(auth)) {
        await payByVoucher(req, res, auth, match, priceMicro, resource, body, forwardBody, u.search, started);
        return;
      }
      const cred = parseCredentialHeader(auth);
      if (!cred) {
        await respondChallenge(res, 'malformed-credential', 'Authorization header is not a Tab credential', priceMicro, resource, {}, terms);
        return;
      }
      // only a challenge this gateway issued may spend a rate-limit token; the check is stateless
      if (!cred.challenge || typeof cred.challenge.id !== 'string' || !verifyChallengeId(store.secret, cred.challenge)) {
        await respondChallenge(res, 'invalid-challenge', 'challenge was not issued by this gateway', priceMicro, resource, {}, terms);
        return;
      }
      // pay on delivery: the buyer opted in, under a challenge that offered it
      const escrow = cred.escrow === true;
      if (escrow && (!terms.escrow || !cred.challenge.escrow)) {
        await respondChallenge(res, 'invalid-challenge', 'this route does not take pay on delivery', priceMicro, resource, {}, terms);
        return;
      }
      // over the service's upstream rate limit: refuse before any hold, so the buyer pays nothing
      const wait = takeRate(match.service);
      if (wait) { await respondRateLimited(res, match.service, wait); return; }

      let hold: HoldRow;
      try {
        hold = verifyAndReserve(cred, priceMicro, resource, { query: u.search, bodySha256: sha256b64url(body) }, new Date(), {
          payTo: escrow && rail.name === 'evm' ? cred.challenge.escrow?.recipient : undefined,
        });
      } catch (err) {
        if (err instanceof PayError) {
          log(`${method} ${pathname} -> 402 ${err.code}: ${err.detail}`);
          await respondChallenge(res, err.code, err.detail, priceMicro, resource, {}, terms, err.extra);
          return;
        }
        throw err;
      }

      if (rail.reserveRemote) {
        try {
          await rail.reserveRemote(hold);
        } catch (err) {
          refundChain(store, hold.mandate_id, hold.window_key, hold.chain, hold.amount);
          store.setHoldState(hold.id, 'voided');
          const pe = err instanceof PayError ? err : new PayError('verification-failed', String((err as Error).message));
          log(`${method} ${pathname} -> 402 ${pe.code}: ${pe.detail}`);
          await respondChallenge(res, pe.code, pe.detail, priceMicro, resource, {}, terms);
          return;
        }
      }

      const deadline = escrow ? new Date(Date.now() + terms.escrow!.timeout_s * 1000).toISOString() : null;
      let upstream: Response;
      try {
        upstream = await forwardUpstream(req, forwardBody, match, u.search, hold, escrow ? {
          'tab-escrow-deadline': deadline!,
          'tab-deliver': `${publicOrigin()}/.well-known/tab/escrow/${hold.id}/deliver`,
          'tab-delivery-token': escrowToken('seller', hold.id),
        } : undefined);
      } catch (err) {
        await releaseHold(hold);
        await respondProblem(res, 'upstream-failed', `upstream unreachable: ${(err as Error).message}`, 502);
        log(`${method} ${pathname} -> 502 upstream-failed (hold ${hold.id} released)`);
        return;
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        // the receipt commits to the bytes relayed, so read them before any money moves
        let delivered: Buffer;
        void 0;
        try {
          delivered = await readUpstream(upstream);
        } catch (err) {
          await releaseHold(hold);
          await respondProblem(res, 'upstream-failed', `upstream body failed: ${(err as Error).message}`, 502);
          log(`${method} ${pathname} -> 502 upstream body failed (hold ${hold.id} released)`);
          return;
        }
        let redact: string | undefined;
        if (escrow) {
          // an upstream that echoes its request headers must not hand the seller's delivery token to the buyer
          const sellerToken = escrowToken('seller', hold.id);
          if (delivered.includes(sellerToken)) delivered = Buffer.from(delivered.toString('latin1').split(sellerToken).join('[redacted]'), 'latin1');
          redact = sellerToken;
          // into escrow first: on the evm rail the buyer's transfer lands in the escrow address, confirmed
          let heldRef: string;
          try {
            heldRef = await lockHold(hold);
          } catch (err) {
            if (err instanceof LockTimeout) watchLock(hold, err);
            else await releaseHold(hold);
            res.setHeader('tab-void', hold.id);
            await respondProblem(res, 'payment-expired', `payment did not settle (${(err as Error).message}); nothing was charged and the response is withheld`, 402);
            log(`${method} ${pathname} -> ${upstream.status} escrow lock FAILED, voided ${hold.id}: ${(err as Error).message}`);
            return;
          }
          // escrowed and the order that owns the money, together
          store.tx(() => {
            store.setHoldState(hold.id, 'escrowed', heldRef);
            store.createEscrow({
              hold_id: hold.id, state: 'held', deadline: deadline!, realm: spec.realm, resource, amount: priceMicro, payer: hold.payer, owner: hold.owner,
              mandate_id: hold.mandate_id, request: cred.request, credential: cred.sig, held_ref: heldRef, created_at: new Date().toISOString(),
            });
          });
          const status = (state: string) => encodeEscrowHeader({
            id: hold.id, state, deadline: deadline!, token: escrowToken('buyer', hold.id), status: `${publicOrigin()}/.well-known/tab/escrow/${hold.id}`,
          });
          if (upstream.status === 202) {
            // accepted, not delivered: the money waits for the result or the deadline
            await relayResponse(res, upstream, { 'tab-escrow': status('held') }, delivered, redact);
            log(`${method} ${pathname} -> 202 escrow held ${fmt(priceMicro)} until ${deadline} (${hold.id})`);
            return;
          }
          // delivered at once; if the payout has no ref yet the receipt follows from the sweeper, and the result stays readable
          const receipt = await deliverEscrow(hold.id, upstream.status, upstream.headers.get('content-type'), delivered);
          await relayResponse(res, upstream, { ...(receipt ? { 'tab-receipt': encodeReceiptHeader(receipt) } : {}), 'tab-escrow': status('delivered') }, delivered, redact);
          log(`${method} ${pathname} -> ${upstream.status} escrow delivered at once ${fmt(priceMicro)} ${receipt?.ref ?? '(payout owed)'}`);
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
        log(`${method} ${pathname} -> ${upstream.status} paid ${fmt(priceMicro)} ${ref} ${Date.now() - started}ms`);
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
  recoverHolds();
  const sweeper = setInterval(() => void sweep(), opts.sweepMs ?? 5_000);
  sweeper.unref();
  const poller = opts.revocationPeers?.length ? setInterval(() => void pollPeers(), opts.revocationPollMs ?? 5_000) : null;
  poller?.unref();
  server.on('close', () => { clearInterval(prune); clearInterval(sweeper); if (poller) clearInterval(poller); });

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
