// Board actions: anything that changes what a company may do (hire, budget,
// approve, pause, publish) is a document signed by the company owner key and
// appended to a per-company log with a sequence number. The server verifies
// the log on read, so a tampered database shows up as unverified entries, and
// an owner who exported the key can sign actions offline and submit them.

import { canonicalJson, sha256b64url } from '../protocol.js';
import { signBytes, verifyBytes, type KeyPair } from '../keys.js';

export const BOARD_VERSION = 'tab-board/0';

export const BOARD_ACTIONS = ['hire', 'retire', 'budget', 'approve', 'reject', 'pause', 'resume', 'publish', 'cancel', 'charter', 'configure'] as const;
export type BoardActionKind = (typeof BOARD_ACTIONS)[number];

export interface BoardBody {
  ver: string;
  company: string; // company id
  seq: number; // previous seq + 1; replaying an old action fails
  action: BoardActionKind;
  payload: unknown;
  at: string; // ISO 8601
}

export interface SignedBoardAction extends BoardBody {
  id: string; // sha256 of the canonical body, base64url
  sig: string; // owner signature over the canonical body
}

function bodyOf(a: BoardBody | SignedBoardAction): BoardBody {
  const { ver, company, seq, action, payload, at } = a;
  return { ver, company, seq, action, payload: payload ?? null, at };
}

export function signBoardAction(owner: KeyPair, body: Omit<BoardBody, 'ver'>): SignedBoardAction {
  const full: BoardBody = { ver: BOARD_VERSION, ...body, payload: body.payload ?? null };
  const canonical = canonicalJson(bodyOf(full));
  return { ...full, id: sha256b64url(canonical), sig: signBytes(owner, Buffer.from(canonical)) };
}

/** Structural and cryptographic validity against the company owner key; also pins company and seq when given. */
export function verifyBoardAction(
  ownerPub: string,
  a: SignedBoardAction,
  expect?: { company?: string; seq?: number },
): { ok: boolean; error?: string } {
  if (!a || typeof a !== 'object') return { ok: false, error: 'not an object' };
  if (a.ver !== BOARD_VERSION) return { ok: false, error: `unsupported version ${a.ver}` };
  if (typeof a.company !== 'string' || typeof a.at !== 'string' || typeof a.sig !== 'string' || typeof a.id !== 'string') {
    return { ok: false, error: 'missing fields' };
  }
  if (!Number.isInteger(a.seq) || a.seq < 1) return { ok: false, error: 'bad seq' };
  if (!(BOARD_ACTIONS as readonly string[]).includes(a.action)) return { ok: false, error: `unknown action ${a.action}` };
  if (expect?.company !== undefined && a.company !== expect.company) return { ok: false, error: 'action is for another company' };
  if (expect?.seq !== undefined && a.seq !== expect.seq) return { ok: false, error: `expected seq ${expect.seq}, got ${a.seq}` };
  const canonical = canonicalJson(bodyOf(a));
  if (a.id !== sha256b64url(canonical)) return { ok: false, error: 'id does not match body' };
  if (!verifyBytes(ownerPub, Buffer.from(canonical), a.sig)) return { ok: false, error: 'owner signature invalid' };
  return { ok: true };
}
