// Instant revoke (3.0): a signed statement that a mandate is dead. Gateways keep
// every revocation they verify, refuse any chain that contains a revoked mandate,
// and pass revocations to their peers, so one publish reaches all of them within
// seconds. Revoking a mandate kills every sub-mandate under it.

import { canonicalJson, VERSION } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';
import { issuerOf, mandateChain, type Mandate } from './mandate.js';

export interface Revocation {
  ver: string;
  mandate: string; // the revoked mandate's id
  by: string; // wallet id of the signer
  revoked_at: string; // ISO 8601
  reason?: string;
  sig: string; // by's signature over the canonical body minus sig
}

const bodyOf = (r: Revocation) => ({ ver: r.ver, mandate: r.mandate, by: r.by, revoked_at: r.revoked_at, reason: r.reason });

export function signRevocation(key: KeyPair, mandateId: string, reason?: string, now = new Date()): Revocation {
  const body = { ver: VERSION, mandate: mandateId, by: key.publicKey, revoked_at: now.toISOString(), reason: reason ? reason.slice(0, 500) : undefined };
  return { ...body, sig: signBytes(key, Buffer.from(canonicalJson(body))) };
}

/** Shape and signature. Whether `by` may revoke a given mandate is revokedBy's question. */
export function verifyRevocation(r: Revocation): boolean {
  if (!r || typeof r !== 'object' || r.ver !== VERSION) return false;
  if (typeof r.mandate !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.mandate)) return false;
  if (typeof r.by !== 'string' || typeof r.sig !== 'string' || typeof r.revoked_at !== 'string' || Number.isNaN(Date.parse(r.revoked_at))) return false;
  if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 500)) return false;
  return verifyBytes(r.by, Buffer.from(canonicalJson(bodyOf(r))), r.sig);
}

/**
 * Who may revoke a mandate: the root owner, whoever signed it (the delegating agent for a
 * sub-mandate), and the agent it names, which may give it up.
 */
export function mayRevoke(m: Mandate, signer: string): boolean {
  const root = mandateChain(m).at(-1)!;
  return signer === root.owner || signer === issuerOf(m) || signer === m.agent;
}

/**
 * The first mandate in the chain (leaf first) with a revocation its rightful signer made,
 * given a lookup from mandate id to the signers of the revocations held for it.
 */
export function revokedIn(m: Mandate, signersOf: (mandateId: string) => string[]): Mandate | null {
  for (const x of mandateChain(m)) {
    if (signersOf(x.id).some((by) => mayRevoke(x, by))) return x;
  }
  return null;
}
