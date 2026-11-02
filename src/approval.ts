// Approval above a threshold (3.0). A mandate may carry approve_above; a payment
// larger than that needs an approval the owner signed for exactly that payment.
// The gateway answers such a call with an approval-required problem naming the
// request; the owner signs an approval for it (CLI, tab OS); the agent retries
// with it attached, or the gateway finds it already posted to it. One use each.

import { canonicalJson, sha256b64url, VERSION } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

/** What the gateway says needs approving. `id` is the hash of the rest. */
export interface ApprovalRequest {
  ver: string;
  id: string;
  owner: string; // the root owner, who must sign
  payer: string; // the agent paying
  realm: string;
  resource: string;
  amount: string; // micro units of currency
  currency: string;
  query: string;
  body_sha256: string;
}

export interface Approval {
  ver: string;
  request: string; // ApprovalRequest id
  realm: string;
  resource: string;
  amount: string;
  issued_at: string;
  expires_at: string; // at most an hour after issued_at
  by: string; // the owner
  sig: string;
}

/** An approval lives at most this long. */
export const APPROVAL_MAX_MS = 3_600_000;
/** How far ahead of the gateway's clock an approval's issued_at may be: an owner's clock a little fast, not hours. */
export const APPROVAL_SKEW_MS = 120_000;

export function approvalRequest(fields: Omit<ApprovalRequest, 'ver' | 'id'>): ApprovalRequest {
  const body = { ver: VERSION, ...fields };
  return { ...body, id: sha256b64url(canonicalJson(body)) };
}

export function approvalRequestValid(r: ApprovalRequest): boolean {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return false;
  const { id, ...rest } = r;
  return id === sha256b64url(canonicalJson(rest));
}

export function signApproval(owner: KeyPair, req: ApprovalRequest, ttlMs = 15 * 60_000, now = new Date()): Approval {
  if (req.owner !== owner.publicKey) throw new Error('this approval request is for another owner');
  const body = {
    ver: VERSION, request: req.id, realm: req.realm, resource: req.resource, amount: req.amount,
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + Math.min(ttlMs, APPROVAL_MAX_MS)).toISOString(), by: owner.publicKey,
  };
  return { ...body, sig: signBytes(owner, Buffer.from(canonicalJson(body))) };
}

/**
 * What makes an approval this approval, for spent-once sets: the hash of its canonical signed body.
 * Not the signature string, which could be spelled more than one way.
 */
export function approvalKey(a: Approval): string {
  const { sig: _sig, ...body } = a;
  return sha256b64url(canonicalJson(body));
}

/** Does this approval cover this request, signed by its owner and in date? Returns the reason it does not, or null. */
export function approvalProblem(a: Approval | undefined | null, req: ApprovalRequest, now = new Date()): string | null {
  if (!a || typeof a !== 'object' || typeof a.sig !== 'string') return 'no approval';
  if (a.ver !== VERSION || a.request !== req.id || a.realm !== req.realm || a.resource !== req.resource || a.amount !== req.amount) {
    return 'approval is for a different payment';
  }
  if (a.by !== req.owner) return 'approval was not signed by the owner';
  const issued = Date.parse(a.issued_at), expires = Date.parse(a.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > APPROVAL_MAX_MS) return 'approval lifetime is out of range';
  if (issued > now.getTime() + APPROVAL_SKEW_MS) return 'approval is dated in the future';
  if (expires <= now.getTime()) return 'approval expired';
  const { sig, ...body } = a;
  if (!verifyBytes(a.by, Buffer.from(canonicalJson(body)), sig)) return 'approval signature invalid';
  return null;
}
