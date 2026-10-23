// The wire format: canonical JSON, USD/micro-USD amounts, challenges (HMAC-bound
// to the gateway's per-database secret), credentials, receipts, problem codes.
// See SPEC.md for the protocol itself.

import { createHmac, createHash, randomBytes } from 'node:crypto';
import type { Mandate } from './mandate.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

export const VERSION = 'tab/0';

// ---------------------------------------------------------------------------
// canonical JSON: recursively sorted keys, no whitespace, undefined dropped

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  throw new Error(`cannot canonicalize a ${typeof v}`);
}

export function sha256b64url(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('base64url');
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// amounts: USD strings with up to six decimals <-> integer micro-USD

export function usdToMicro(usd: string): number {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd).trim());
  if (!m) throw new Error(`bad USD amount: ${JSON.stringify(usd)}`);
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0') || '0');
  if (!Number.isSafeInteger(micro)) throw new Error(`USD amount out of range: ${usd}`);
  return micro;
}

/** Currency codes a gateway may charge in: USD (the default) or a token symbol, 2 to 10 upper-case letters or digits. */
export function isCurrency(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z0-9]{2,10}$/.test(code);
}

/** "$0.01" for USD, "0.01 TTT" for anything else. */
export function formatAmount(micro: number, currency = 'USD'): string {
  const n = microToUsd(micro);
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

/** Token decimals the evm rail accepts. */
export function assertDecimals(decimals: unknown): asserts decimals is number {
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
    throw new Error(`token decimals must be an integer from 0 to 18, got ${JSON.stringify(decimals)}`);
  }
}

/**
 * Wire amounts are micro units (6 decimals) of the gateway's currency. On chain
 * a token has its own decimals; these convert exactly or throw. Tokens with fewer
 * than 6 decimals can only carry prices that are whole in their own base unit.
 */
export function microToBaseUnits(micro: bigint, decimals: number): bigint {
  assertDecimals(decimals);
  if (decimals >= 6) return micro * 10n ** BigInt(decimals - 6);
  const div = 10n ** BigInt(6 - decimals);
  if (micro % div !== 0n) throw new Error(`amount ${micro} micro is not representable with ${decimals} decimals`);
  return micro / div;
}

export function baseUnitsToMicro(base: bigint, decimals: number): bigint {
  assertDecimals(decimals);
  if (decimals >= 6) return base / 10n ** BigInt(decimals - 6);
  return base * 10n ** BigInt(6 - decimals);
}

export function microToUsd(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const n = Math.abs(micro);
  const whole = Math.floor(n / 1_000_000);
  let frac = String(n % 1_000_000).padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${sign}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// challenges

export type RailName = 'ledger' | 'evm';

export interface EvmChallengeInfo {
  chain_id: number; // Robinhood Chain: 46630 testnet, 4663 mainnet
  token: string; // ERC-20 contract, 0x hex
  decimals: number; // the token's decimals; on-chain amount = micro units scaled to them
  recipient: string; // seller payout address, 0x hex
  max_fee_per_gas: string; // 0x hex wei
  max_priority_fee_per_gas: string; // 0x hex wei
  gas_limit: number;
}

export interface Challenge {
  ver: string;
  id: string; // HMAC-SHA256 over the canonical challenge minus id, base64url
  realm: string;
  rail: RailName;
  amount: string; // micro units of `currency`, decimal string
  currency: string; // "USD", or a token symbol on a gateway that charges in its own token
  recipient: string; // wallet id (base64url public key)
  resource: string; // "METHOD /path"
  expires_at: string; // ISO 8601
  evm?: EvmChallengeInfo;
}

export function challengeId(secret: Uint8Array, chal: Omit<Challenge, 'id'>): string {
  return createHmac('sha256', secret).update(canonicalJson({ ...chal, id: undefined })).digest('base64url');
}

export function makeChallenge(
  secret: Uint8Array,
  fields: Omit<Challenge, 'id' | 'ver' | 'currency'> & { currency?: string },
): Challenge {
  const body: Omit<Challenge, 'id'> = { ver: VERSION, currency: 'USD', ...fields };
  return { ...body, id: challengeId(secret, body) };
}

export function verifyChallengeId(secret: Uint8Array, chal: Challenge): boolean {
  const { id, ...rest } = chal;
  return typeof id === 'string' && id === challengeId(secret, rest);
}

export function resourceOf(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

// WWW-Authenticate: Tab challenge="<base64url of the challenge JSON>"
export function encodeChallengeHeader(chal: Challenge): string {
  return `Tab challenge="${Buffer.from(JSON.stringify(chal)).toString('base64url')}"`;
}

export function parseChallengeHeader(header: string | null | undefined): Challenge | null {
  if (!header) return null;
  const m = /^\s*Tab\s+challenge="([A-Za-z0-9_-]+)"\s*$/.exec(header);
  if (!m) return null;
  try {
    const chal = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (chal && typeof chal === 'object' && typeof chal.id === 'string') return chal as Challenge;
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// credentials

/**
 * Draft 0.1: the credential commits to the exact request, not just the priced
 * resource. `query` is the URL search string as sent (may be ""), `body_sha256`
 * is the SHA-256 of the request body (of zero bytes for bodyless requests),
 * base64url. The gateway recomputes both from the request it actually received.
 */
export interface RequestCommitment {
  query: string;
  body_sha256: string;
}

export function bodyDigest(body?: string | Uint8Array | null): string {
  return sha256b64url(body == null ? new Uint8Array(0) : body);
}

export interface Credential {
  ver: string;
  agent: string; // wallet id of the paying agent
  challenge: Challenge; // echoed back verbatim
  mandate: Mandate;
  request: RequestCommitment;
  sig: string; // agent signature, see credentialMessage
  evm?: { tx: string }; // 0x hex fully-signed type-2 transaction
}

/** What the agent signs: a canonical binding of challenge, mandate, payer and request. */
export function credentialMessage(
  agent: string,
  chal: Challenge,
  mandateId: string,
  request: RequestCommitment,
): Uint8Array {
  return Buffer.from(
    canonicalJson({
      agent,
      amount: chal.amount,
      body: request.body_sha256,
      challenge: chal.id,
      mandate: mandateId,
      query: request.query,
      realm: chal.realm,
      recipient: chal.recipient,
      resource: chal.resource,
    }),
  );
}

export interface SignCredentialOptions {
  query?: string;
  body?: string | Uint8Array | null;
  evm?: { tx: string };
}

export function signCredential(
  agent: KeyPair,
  chal: Challenge,
  mandate: Mandate,
  opts: SignCredentialOptions = {},
): Credential {
  const request: RequestCommitment = { query: opts.query ?? '', body_sha256: bodyDigest(opts.body) };
  const sig = signBytes(agent, credentialMessage(agent.publicKey, chal, mandate.id, request));
  return {
    ver: VERSION, agent: agent.publicKey, challenge: chal, mandate, request, sig,
    evm: opts.evm,
  };
}

export function verifyCredentialSig(cred: Credential): boolean {
  if (!cred.request || typeof cred.request.query !== 'string' || typeof cred.request.body_sha256 !== 'string') {
    return false;
  }
  return verifyBytes(
    cred.agent,
    credentialMessage(cred.agent, cred.challenge, cred.mandate.id, cred.request),
    cred.sig,
  );
}

// Authorization: Tab <base64url of the credential JSON>
export function encodeCredentialHeader(cred: Credential): string {
  return `Tab ${Buffer.from(JSON.stringify(cred)).toString('base64url')}`;
}

export function parseCredentialHeader(header: string | null | undefined): Credential | null {
  if (!header) return null;
  const m = /^\s*Tab\s+([A-Za-z0-9_-]+)\s*$/.exec(header);
  if (!m) return null;
  try {
    const cred = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (cred && typeof cred === 'object' && cred.challenge && cred.mandate && typeof cred.sig === 'string') {
      return cred as Credential;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// receipts

export interface Receipt {
  id: string; // hold id
  realm: string;
  resource: string;
  amount: string; // micro units of `currency`
  currency: string;
  rail: RailName;
  payer: string; // agent wallet id
  owner: string; // owner wallet id (whose funds moved)
  recipient: string;
  ref: string; // "ledger:<hold>" or "evm:<tx hash>"
  at: string; // ISO 8601
  // signed receipts (draft 0.5); absent on receipts from older gateways
  mandate?: string; // the mandate id the payment ran under
  challenge?: string; // the challenge id, which commits to price, route and recipient
  request?: RequestCommitment; // what the agent signed: query string and body digest
  credential?: string; // the agent's signature over that commitment
  response?: ResponseCommitment; // what the gateway delivered
  gateway?: string; // the gateway's receipt key, as published in discovery
  sig?: string; // gateway signature over the canonical receipt minus sig
}

/** What a paid call delivered: the upstream status and the SHA-256 of the body bytes relayed, base64url. */
export interface ResponseCommitment {
  status: number;
  body_sha256: string;
}

export function receiptMessage(r: Receipt): Uint8Array {
  return Buffer.from(canonicalJson({ ...r, sig: undefined }));
}

/** Sign a receipt with the gateway's receipt key; sets `gateway` and `sig`. */
export function signReceipt(key: KeyPair, r: Receipt): Receipt {
  const body = { ...r, gateway: key.publicKey, sig: undefined };
  return { ...body, sig: signBytes(key, receiptMessage(body)) };
}

export interface ReceiptExpectations {
  key?: string | null; // the receipt key the gateway publishes; null fails, and leaving it out checks only that the receipt is self-consistent
  body?: string | Uint8Array; // the response body as received
  status?: number;
  mandate?: string; // the mandate id this client paid under
  request?: RequestCommitment; // what this client sent
}

/**
 * Check a receipt against what the caller knows. Never throws. `ok` means the
 * gateway's published key signed exactly this receipt and every expectation
 * given matched; `reason` names the first thing that did not.
 */
export function verifyReceipt(r: Receipt, want: ReceiptExpectations = {}): { ok: boolean; reason?: string } {
  const fail = (reason: string) => ({ ok: false, reason });
  if (!r || typeof r.sig !== 'string' || typeof r.gateway !== 'string') return fail('unsigned receipt');
  if (!r.response || !r.request || !r.mandate || !r.challenge) return fail('receipt lacks its commitments');
  if (!verifyBytes(r.gateway, receiptMessage(r), r.sig)) return fail('receipt signature does not verify');
  if (want.key === null) return fail('the gateway publishes no receipt key');
  if (want.key !== undefined && want.key !== r.gateway) return fail('receipt was signed by a key the gateway does not publish');
  if (want.mandate !== undefined && want.mandate !== r.mandate) return fail('receipt names a different mandate');
  if (want.request && (want.request.query !== r.request.query || want.request.body_sha256 !== r.request.body_sha256)) {
    return fail('receipt commits to a different request');
  }
  if (want.status !== undefined && want.status !== r.response.status) return fail('receipt names a different status');
  if (want.body !== undefined && bodyDigest(want.body) !== r.response.body_sha256) return fail('response body does not match the receipt');
  return { ok: true };
}

export function encodeReceiptHeader(r: Receipt): string {
  return Buffer.from(JSON.stringify(r)).toString('base64url');
}

export function parseReceiptHeader(header: string | null | undefined): Receipt | null {
  if (!header) return null;
  try {
    const r = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (r && typeof r === 'object' && typeof r.ref === 'string') return r as Receipt;
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// problems (RFC 9457, type urn:tab:problem:<code>)

export type ProblemCode =
  | 'payment-required'
  | 'malformed-credential'
  | 'invalid-challenge'
  | 'payment-expired'
  | 'verification-failed'
  | 'mandate-invalid'
  | 'mandate-denied'
  | 'mandate-exceeded'
  | 'insufficient-funds'
  | 'not-found'
  | 'bad-request'
  | 'upstream-failed'
  | 'rate-limited';

export class PayError extends Error {
  constructor(
    public code: ProblemCode,
    public detail: string,
    public status = 402,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PayError';
  }
}

export function problemBody(code: ProblemCode, detail: string, status: number): string {
  return JSON.stringify({ type: `urn:tab:problem:${code}`, title: code, status, detail });
}
