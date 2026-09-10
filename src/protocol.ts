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

export interface SolanaChallengeInfo {
  mint: string; // base58
  decimals: number;
  fee_payer: string; // base58
  recent_blockhash: string; // base58
}

export interface Challenge {
  ver: string;
  id: string; // HMAC-SHA256 over the canonical challenge minus id, base64url
  realm: string;
  rail: 'ledger' | 'solana';
  amount: string; // micro-USD, decimal string
  currency: 'USD';
  recipient: string; // wallet id (base64url public key)
  resource: string; // "METHOD /path"
  expires_at: string; // ISO 8601
  solana?: SolanaChallengeInfo;
}

export function challengeId(secret: Uint8Array, chal: Omit<Challenge, 'id'>): string {
  return createHmac('sha256', secret).update(canonicalJson({ ...chal, id: undefined })).digest('base64url');
}

export function makeChallenge(
  secret: Uint8Array,
  fields: Omit<Challenge, 'id' | 'ver' | 'currency'>,
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

export interface Credential {
  ver: string;
  agent: string; // wallet id of the paying agent
  challenge: Challenge; // echoed back verbatim
  mandate: Mandate;
  sig: string; // agent signature, see credentialMessage
  solana?: { tx: string }; // base64 partially-signed legacy transaction
}

/** What the agent signs: a canonical binding of challenge, mandate and payer. */
export function credentialMessage(agent: string, chal: Challenge, mandateId: string): Uint8Array {
  return Buffer.from(
    canonicalJson({
      agent,
      amount: chal.amount,
      challenge: chal.id,
      mandate: mandateId,
      realm: chal.realm,
      recipient: chal.recipient,
      resource: chal.resource,
    }),
  );
}

export function signCredential(
  agent: KeyPair,
  chal: Challenge,
  mandate: Mandate,
  solana?: { tx: string },
): Credential {
  const sig = signBytes(agent, credentialMessage(agent.publicKey, chal, mandate.id));
  return { ver: VERSION, agent: agent.publicKey, challenge: chal, mandate, sig, solana };
}

export function verifyCredentialSig(cred: Credential): boolean {
  return verifyBytes(cred.agent, credentialMessage(cred.agent, cred.challenge, cred.mandate.id), cred.sig);
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
  amount: string; // micro-USD
  currency: 'USD';
  rail: 'ledger' | 'solana';
  payer: string; // agent wallet id
  owner: string; // owner wallet id (whose funds moved)
  recipient: string;
  ref: string; // "ledger:<hold>" or "solana:<signature>"
  at: string; // ISO 8601
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
  | 'upstream-failed';

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
