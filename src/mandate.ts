// The mandate: a signed spending grant the owner issues once, offline. The agent
// carries it with every payment; the gateway enforces it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256b64url, usdToMicro, VERSION } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

export interface Mandate {
  ver: string;
  id: string; // sha256 of the canonical body, base64url
  owner: string; // wallet id that signs and whose funds move
  agent: string; // wallet id allowed to spend
  budget: string; // micro-USD, decimal string
  window: 'total' | 'day'; // lifetime budget, or per UTC calendar day
  max_per_call: string | null; // micro-USD, decimal string
  allow: string[]; // realm globs; ["*"] means any
  issued_at: string; // ISO 8601
  expires_at: string; // ISO 8601
  /**
   * The owner's EVM account (0x hex, lowercase), attested by the owner's
   * signature. Required by the evm rail: payments may only transferFrom this
   * address, so an agent cannot point a mandate at someone else's allowance.
   */
  evm_owner?: string;
  /**
   * 3.0: payments above this many micro units need a fresh approval signed by the
   * owner (approval.ts). Absent means no approval is ever needed.
   */
  approve_above?: string;
  /**
   * 3.0: a sub-mandate. The parent mandate, whole; this one is signed by
   * parent.agent instead of the owner and must sit inside every parent limit.
   */
  parent?: Mandate;
  sig: string; // owner signature over the canonical body (the parent's agent for a sub-mandate)
}

/** How many delegations deep a chain may go: owner -> agent -> sub -> sub -> sub. */
export const MAX_DELEGATION_DEPTH = 3;

type MandateBody = Omit<Mandate, 'id' | 'sig'>;

function bodyOf(m: Mandate | MandateBody): MandateBody {
  const { ver, owner, agent, budget, window, max_per_call, allow, issued_at, expires_at, evm_owner, approve_above, parent } =
    m as Mandate;
  return { ver, owner, agent, budget, window, max_per_call, allow, issued_at, expires_at, evm_owner, approve_above, parent };
}

export interface IssueOptions {
  agent: string; // agent public key
  budgetUsd: string;
  window?: 'total' | 'day';
  maxPerCallUsd?: string;
  allow?: string[];
  days?: number;
  expiresInMs?: number; // overrides days: a mandate for one run lives as long as the run may
  evmOwner?: string; // the owner's 0x address, for the evm rail
  approveAboveUsd?: string; // payments above this need a fresh owner approval
  now?: Date;
}

export function issueMandate(owner: KeyPair, opts: IssueOptions): Mandate {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const body: MandateBody = {
    ver: VERSION,
    owner: owner.publicKey,
    agent: opts.agent,
    budget: String(usdToMicro(opts.budgetUsd)),
    window: opts.window ?? 'total',
    max_per_call: opts.maxPerCallUsd != null ? String(usdToMicro(opts.maxPerCallUsd)) : null,
    allow: opts.allow && opts.allow.length ? opts.allow : ['*'],
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (opts.expiresInMs ?? days * 86_400_000)).toISOString(),
    evm_owner: opts.evmOwner ? opts.evmOwner.toLowerCase() : undefined,
    approve_above: opts.approveAboveUsd != null ? String(usdToMicro(opts.approveAboveUsd)) : undefined,
  };
  const canonical = canonicalJson(body);
  return { ...body, id: sha256b64url(canonical), sig: signBytes(owner, Buffer.from(canonical)) };
}

/**
 * A sub-mandate: the agent holding `parent` hands part of it to another agent key.
 * Signed by that agent; the owner and evm_owner stay the parent's, since the money
 * is still the owner's. Limits default to the parent's and may only narrow. Throws
 * when a limit would exceed the parent or the chain would be too deep.
 */
export function delegateMandate(parentAgent: KeyPair, parent: Mandate, opts: Partial<IssueOptions> & { agent: string }): Mandate {
  if (parentAgent.publicKey !== parent.agent) throw new Error('only the agent a mandate names can delegate it');
  const now = opts.now ?? new Date();
  const expires = opts.expiresInMs != null || opts.days != null
    ? new Date(Math.min(now.getTime() + (opts.expiresInMs ?? (opts.days ?? 7) * 86_400_000), Date.parse(parent.expires_at)))
    : new Date(parent.expires_at);
  const body: MandateBody = {
    ver: VERSION,
    owner: parent.owner,
    agent: opts.agent,
    budget: opts.budgetUsd != null ? String(usdToMicro(opts.budgetUsd)) : parent.budget,
    window: opts.window ?? parent.window,
    max_per_call: opts.maxPerCallUsd != null ? String(usdToMicro(opts.maxPerCallUsd)) : parent.max_per_call,
    allow: opts.allow && opts.allow.length ? opts.allow : parent.allow,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    evm_owner: parent.evm_owner,
    approve_above: opts.approveAboveUsd != null ? String(usdToMicro(opts.approveAboveUsd)) : parent.approve_above,
    parent,
  };
  const narrower = withinParent(body, parent);
  if (narrower) throw new Error(`sub-mandate ${narrower}`);
  if (depthOf(parent) + 1 > MAX_DELEGATION_DEPTH) throw new Error(`a chain may delegate at most ${MAX_DELEGATION_DEPTH} times`);
  const canonical = canonicalJson(body);
  return { ...body, id: sha256b64url(canonical), sig: signBytes(parentAgent, Buffer.from(canonical)) };
}

/** Delegations above this mandate: 0 for one the owner signed. */
export function depthOf(m: Mandate): number {
  let n = 0;
  for (let p = m.parent; p; p = p.parent) n++;
  return n;
}

/** The mandate and every ancestor, leaf first, root last. */
export function mandateChain(m: Mandate): Mandate[] {
  const out: Mandate[] = [];
  for (let p: Mandate | undefined = m; p; p = p.parent) out.push(p);
  return out;
}

/** Who signed a mandate: the owner, or for a sub-mandate the agent of its parent. */
export function issuerOf(m: Mandate): string {
  return m.parent ? m.parent.agent : m.owner;
}

/** The lowest approval threshold in the chain, in micro units; null when nothing needs approval. */
export function approvalThreshold(m: Mandate): number | null {
  let t: number | null = null;
  for (const x of mandateChain(m)) {
    if (x.approve_above !== undefined) t = t === null ? Number(x.approve_above) : Math.min(t, Number(x.approve_above));
  }
  return t;
}

/** The tightest per-call cap in the chain, in micro units; null when no level caps a call. */
export function perCallCap(m: Mandate): number | null {
  let t: number | null = null;
  for (const x of mandateChain(m)) {
    if (x.max_per_call !== null && x.max_per_call !== undefined) t = t === null ? Number(x.max_per_call) : Math.min(t, Number(x.max_per_call));
  }
  return t;
}

/** Why a child body is not inside its parent, or null when every limit is. */
export function withinParent(child: MandateBody, parent: Mandate): string | null {
  if (child.owner !== parent.owner) return 'names a different owner than its parent';
  if (child.evm_owner !== parent.evm_owner) return 'names a different evm_owner than its parent';
  if (Number(child.budget) > Number(parent.budget)) return 'budget exceeds its parent';
  if (parent.max_per_call !== null) {
    if (child.max_per_call === null || Number(child.max_per_call) > Number(parent.max_per_call)) return 'per-call cap exceeds its parent';
  }
  if (parent.approve_above !== undefined) {
    if (child.approve_above === undefined || Number(child.approve_above) > Number(parent.approve_above)) return 'approval threshold exceeds its parent';
  }
  if (!child.allow.every((g) => parent.allow.some((p) => typeof p === 'string' && globMatch(p, g)))) return 'allows a realm its parent does not';
  const ce = Date.parse(child.expires_at), pe = Date.parse(parent.expires_at);
  if (!Number.isFinite(ce) || ce > pe) return 'outlives its parent';
  if (child.window !== parent.window && child.window !== 'total') return 'resets daily under a parent that does not';
  return null;
}

/**
 * Structural + cryptographic validity, of the whole chain for a sub-mandate: every
 * signature, every child inside its parent, the depth bound. Says nothing about
 * realm, budget spent or expiry.
 */
export function verifyMandate(m: Mandate, depth = 0): { ok: boolean; error?: string } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  if (depth > MAX_DELEGATION_DEPTH) return { ok: false, error: `chain deeper than ${MAX_DELEGATION_DEPTH} delegations` };
  if (m.ver !== VERSION) return { ok: false, error: `unsupported version ${m.ver}` };
  for (const k of ['id', 'owner', 'agent', 'budget', 'sig', 'issued_at', 'expires_at'] as const) {
    if (typeof m[k] !== 'string') return { ok: false, error: `missing ${k}` };
  }
  if (m.window !== 'total' && m.window !== 'day') return { ok: false, error: 'bad window' };
  if (!Array.isArray(m.allow) || !m.allow.every((a) => typeof a === 'string')) {
    return { ok: false, error: 'bad allow list' };
  }
  if (!/^\d+$/.test(m.budget)) return { ok: false, error: 'bad budget' };
  if (m.max_per_call !== null && !/^\d+$/.test(String(m.max_per_call))) {
    return { ok: false, error: 'bad max_per_call' };
  }
  if (m.evm_owner !== undefined && !/^0x[0-9a-f]{40}$/.test(m.evm_owner)) {
    return { ok: false, error: 'bad evm_owner' };
  }
  if (m.approve_above !== undefined && !/^\d+$/.test(String(m.approve_above))) {
    return { ok: false, error: 'bad approve_above' };
  }
  const canonical = canonicalJson(bodyOf(m));
  if (m.id !== sha256b64url(canonical)) return { ok: false, error: 'id does not match body' };
  if (m.parent !== undefined) {
    if (!m.parent || typeof m.parent !== 'object') return { ok: false, error: 'bad parent' };
    const pv = verifyMandate(m.parent, depth + 1);
    if (!pv.ok) return { ok: false, error: `parent: ${pv.error}` };
    const narrower = withinParent(bodyOf(m), m.parent);
    if (narrower) return { ok: false, error: `sub-mandate ${narrower}` };
    if (!verifyBytes(m.parent.agent, Buffer.from(canonical), m.sig)) {
      return { ok: false, error: 'delegating agent signature invalid' };
    }
    return { ok: true };
  }
  if (!verifyBytes(m.owner, Buffer.from(canonical), m.sig)) {
    return { ok: false, error: 'owner signature invalid' };
  }
  return { ok: true };
}

export function mandateExpired(m: Mandate, now = new Date()): boolean {
  const t = Date.parse(m.expires_at);
  return !Number.isFinite(t) || t <= now.getTime();
}

/** Glob over realms: *, *.example.com, quotes.local. */
export function realmAllowed(m: Mandate, realm: string): boolean {
  return m.allow.some((glob) => typeof glob === 'string' && globMatch(glob, realm));
}

/** * matches any run of characters. Linear time: a regex here let one signed mandate with a
 *  long run of stars hold a gateway's event loop for minutes. */
function globMatch(glob: string, s: string): boolean {
  if (glob.length > 253) return false;
  const parts = glob.split('*');
  if (parts.length === 1) return glob === s;
  const first = parts[0], last = parts[parts.length - 1];
  if (!s.startsWith(first) || s.length < first.length + last.length || !s.endsWith(last)) return false;
  let at = first.length;
  const end = s.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue;
    const j = s.indexOf(parts[i], at);
    if (j < 0 || j + parts[i].length > end) return false;
    at = j + parts[i].length;
  }
  return true;
}

export function saveMandate(path: string, m: Mandate): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}

export function loadMandate(path: string): Mandate {
  return JSON.parse(readFileSync(path, 'utf8')) as Mandate;
}
