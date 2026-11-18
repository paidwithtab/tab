// 3.3 (draft 1.0): flags. A buyer that paid for a result it could not use (wrong, empty, an error
// dressed as a 200) flags the receipt, signed by the agent that paid. The gateway keeps one flag
// per receipt, counts them per route in discovery (`stats.flags_7d`), and shows them to the seller.
// The catalog ranks flagged routes lower. A flag moves no money: it is reputation, not a refund.

import { canonicalJson, type Receipt } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

export const FLAGS_PATH = '/.well-known/tab/flags';
export const FLAG_REASONS = ['wrong', 'empty', 'error', 'slow', 'other'] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export interface Flag {
  ver: 'tab/0';
  kind: 'flag';
  receipt: string; // the receipt's id
  realm: string;
  reason: FlagReason;
  note?: string; // at most 300 characters, shown to the seller
  at: string; // ISO time; must be within 10 minutes of the gateway's clock
  by: string; // the agent that paid: the receipt's payer
  sig: string; // by `by`, over the canonical flag minus sig
}

export const FLAG_LIMITS = { noteMax: 300, maxAgeDays: 30, skewMs: 10 * 60_000, perIpPerHour: 30 };

export function flagMessage(f: Omit<Flag, 'sig'> | Flag): Uint8Array {
  return Buffer.from(canonicalJson({ ...f, sig: undefined }));
}

/** A flag on a receipt this agent paid for. */
export function signFlag(agent: KeyPair, receipt: Receipt, reason: FlagReason, note?: string, at = new Date()): Flag {
  const body: Omit<Flag, 'sig'> = {
    ver: 'tab/0', kind: 'flag', receipt: receipt.id, realm: receipt.realm, reason,
    ...(note ? { note: note.slice(0, FLAG_LIMITS.noteMax) } : {}), at: at.toISOString(), by: agent.publicKey,
  };
  return { ...body, sig: signBytes(agent, flagMessage(body)) };
}

/** Why a flag cannot be taken, or null. `receipt` is the gateway's own record of it. */
export function flagProblem(f: Flag, o: { realm: string; receipt: Receipt | undefined; now?: Date }): string | null {
  if (!f || typeof f !== 'object' || f.ver !== 'tab/0' || f.kind !== 'flag') return 'not a tab/0 flag';
  if (typeof f.by !== 'string' || typeof f.sig !== 'string' || !verifyBytes(f.by, flagMessage(f), f.sig)) return 'flag signature does not verify';
  if (f.realm !== o.realm) return `flag is for ${f.realm}, not ${o.realm}`;
  if (!FLAG_REASONS.includes(f.reason)) return `reason must be one of ${FLAG_REASONS.join(', ')}`;
  if (f.note !== undefined && (typeof f.note !== 'string' || f.note.length > FLAG_LIMITS.noteMax)) return `note must be at most ${FLAG_LIMITS.noteMax} characters`;
  const now = (o.now ?? new Date()).getTime();
  const at = Date.parse(f.at);
  if (!Number.isFinite(at) || Math.abs(now - at) > FLAG_LIMITS.skewMs) return 'flag time is more than 10 minutes off; sign it again';
  if (!o.receipt) return 'no such receipt at this gateway';
  if (o.receipt.payer !== f.by) return 'only the agent that paid can flag a receipt';
  if (now - Date.parse(o.receipt.at) > FLAG_LIMITS.maxAgeDays * 86_400_000) return `receipts older than ${FLAG_LIMITS.maxAgeDays} days cannot be flagged`;
  if (o.receipt.channel?.kind && o.receipt.channel.kind !== 'call') return 'only a paid call can be flagged';
  return null;
}
