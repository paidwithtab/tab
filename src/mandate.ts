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
  sig: string; // owner signature over the canonical body
}

type MandateBody = Omit<Mandate, 'id' | 'sig'>;

function bodyOf(m: Mandate | MandateBody): MandateBody {
  const { ver, owner, agent, budget, window, max_per_call, allow, issued_at, expires_at, evm_owner } =
    m as Mandate;
  return { ver, owner, agent, budget, window, max_per_call, allow, issued_at, expires_at, evm_owner };
}

export interface IssueOptions {
  agent: string; // agent public key
  budgetUsd: string;
  window?: 'total' | 'day';
  maxPerCallUsd?: string;
  allow?: string[];
  days?: number;
  evmOwner?: string; // the owner's 0x address, for the evm rail
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
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
    evm_owner: opts.evmOwner ? opts.evmOwner.toLowerCase() : undefined,
  };
  const canonical = canonicalJson(body);
  return { ...body, id: sha256b64url(canonical), sig: signBytes(owner, Buffer.from(canonical)) };
}

/** Structural + cryptographic validity. Says nothing about realm, budget or expiry. */
export function verifyMandate(m: Mandate): { ok: boolean; error?: string } {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
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
  const canonical = canonicalJson(bodyOf(m));
  if (m.id !== sha256b64url(canonical)) return { ok: false, error: 'id does not match body' };
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
  return m.allow.some((glob) => {
    const re = new RegExp(
      '^' + glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return re.test(realm);
  });
}

export function saveMandate(path: string, m: Mandate): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}

export function loadMandate(path: string): Mandate {
  return JSON.parse(readFileSync(path, 'utf8')) as Mandate;
}
