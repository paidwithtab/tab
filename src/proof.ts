// Proof of purchase. Every paid response can be kept as a folder: the bytes the agent got,
// the gateway's signed receipt, what the agent asked for and the mandate it paid under.
// verifyProof checks the folder offline (and the gateway's published key, when online):
// the receipt is signed by the gateway, the body is the one it signed for, the request is
// the one the agent signed, the agent's own signature authorizes the payment, and the
// mandate is signed by its owner. Anyone can run it; nothing in the folder is secret.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { bodyDigest, credentialMessage, verifyReceipt, type Receipt, type Challenge } from './protocol.js';
import { verifyMandate, type Mandate } from './mandate.js';
import { verifyBytes } from './keys.js';
import { receiptLeaf, verifyInclusion, verifyTreeHead, unb64, type TreeHead } from './log.js';

export interface ProofRequest {
  url: string;
  method: string;
  body?: string; // the request body as sent, when it was text
  task?: string; // 3.2: what the agent was working on (TAB_TASK, a tool argument, or the git branch)
}

export interface SavedProof {
  dir: string;
  receipt: Receipt;
}

/** Write a proof folder under `root` and return where. Never throws: a proof that cannot be written is skipped. */
export function saveProof(root: string, req: ProofRequest, res: { status: number; contentType: string | null }, body: Uint8Array, receipt: Receipt, mandate: Mandate): SavedProof | null {
  try {
    const stamp = receipt.at.replace(/[:.]/g, '-');
    const dir = join(root, `${stamp}-${receipt.id.slice(0, 12)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'body'), body);
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ url: req.url, method: req.method, status: res.status, content_type: res.contentType, ...(req.body != null ? { body: req.body } : {}), ...(req.task ? { task: req.task } : {}) }, null, 2) + '\n');
    writeFileSync(join(dir, 'mandate.json'), JSON.stringify(mandate, null, 2) + '\n');
    return { dir, receipt };
  } catch {
    return null;
  }
}

/** A gateway's answer to /.well-known/tab/log/proof. */
export interface LogProof { receipt: string; index: number; size: number; leaf: string; proof: string[]; head: TreeHead }

export interface ProofCheck {
  name: string;
  ok: boolean | null; // null: not checked (and why is in detail)
  detail?: string;
}

export interface ProofReport {
  ok: boolean;
  dir: string;
  summary: { realm: string; resource: string; amount: string; currency: string; at: string; ref: string; status?: number; body_bytes?: number };
  checks: ProofCheck[];
}

/** Proof folders under `root`, newest first. */
export function listProofs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => { try { return statSync(d).isDirectory() && existsSync(join(d, 'receipt.json')); } catch { return false; } })
    .sort()
    .reverse();
}

/**
 * Check a proof folder (or a receipt.json, with the body next to it or passed as bodyPath).
 * publishedKey: the gateway's receipt key from its discovery document; a function is asked
 * with the receipt's realm, and null means it could not be found.
 */
export async function verifyProof(
  path: string,
  o: { bodyPath?: string; key?: string; publishedKey?: (realm: string) => Promise<string | null>; logProof?: (origin: string, receiptId: string) => Promise<LogProof | null> } = {},
): Promise<ProofReport> {
  const dir = path.endsWith('.json') ? dirname(path) : path;
  const receiptFile = path.endsWith('.json') ? path : join(dir, 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as Receipt;
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null);
  const bodyBytes = o.bodyPath ? readFileSync(o.bodyPath) : read('body');
  const request = (() => { const b = read('request.json'); return b ? (JSON.parse(b.toString('utf8')) as ProofRequest & { status?: number }) : null; })();
  const mandate = (() => { const b = read('mandate.json'); return b ? (JSON.parse(b.toString('utf8')) as Mandate) : null; })();
  const checks: ProofCheck[] = [];
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  // 1. the gateway signed this receipt, with the key it publishes
  const self = verifyReceipt(receipt);
  add('gateway signature', self.ok, self.ok ? `key ${receipt.gateway}` : self.reason);
  if (o.key) add('gateway key', o.key === receipt.gateway, o.key === receipt.gateway ? 'matches the key given' : 'signed by a different key than the one given');
  else if (o.publishedKey) {
    const published = await o.publishedKey(receipt.realm).catch(() => null);
    if (published === null) add('gateway key', null, `could not read the receipt key ${receipt.realm} publishes`);
    else add('gateway key', published === receipt.gateway, published === receipt.gateway ? `${receipt.realm} publishes this key` : `${receipt.realm} publishes ${published}, not the key that signed`);
  } else add('gateway key', null, 'not compared with the published key (offline)');

  // 2. the body is the one the gateway signed for
  if (!bodyBytes) add('response body', null, 'no body saved next to the receipt');
  else {
    const same = receipt.response ? bodyDigest(bodyBytes) === receipt.response.body_sha256 : false;
    add('response body', same, same ? `${bodyBytes.length} bytes, SHA-256 ${receipt.response!.body_sha256}` : 'the body does not hash to what the receipt names');
  }
  if (request?.status !== undefined && receipt.response) add('response status', request.status === receipt.response.status, `HTTP ${receipt.response.status}`);

  // 3. the request is the one the agent committed to
  if (request && receipt.request) {
    const u = new URL(request.url);
    const sameQuery = u.search === receipt.request.query;
    const sameBody = bodyDigest(request.body ?? null) === receipt.request.body_sha256;
    // a gateway on a loopback address (a test, a local sandbox) may name any realm, as the client allows
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname) || u.hostname.endsWith('.local');
    const sameRoute = local || u.host === receipt.realm || u.hostname === receipt.realm;
    add('request', sameQuery && sameBody && sameRoute,
      sameQuery && sameBody && sameRoute ? `${request.method} ${request.url}` : !sameRoute ? `saved URL is not at ${receipt.realm}` : !sameQuery ? 'saved query differs from the one signed' : 'saved request body differs from the one signed');
  } else add('request', null, 'no request saved');

  // 4. the agent itself authorized this payment: its signature over price, route, recipient and request
  if (receipt.channel || receipt.mandate === 'x402' || !receipt.request || !receipt.challenge || !receipt.credential) {
    add('agent authorization', null, receipt.channel ? 'paid by channel voucher' : receipt.mandate === 'x402' ? 'paid by x402 authorization (on chain)' : 'receipt carries no credential');
  } else {
    const chal = { id: receipt.challenge, amount: receipt.authorized ?? receipt.amount, realm: receipt.realm, recipient: receipt.recipient, resource: receipt.resource } as Challenge;
    const msg = credentialMessage(receipt.payer, chal, receipt.mandate!, receipt.request, receipt.escrow ? true : undefined);
    const ok = verifyBytes(receipt.payer, msg, receipt.credential);
    add('agent authorization', ok, ok ? `signed by agent ${receipt.payer}` : 'the credential is not the agent\'s signature over this payment');
  }

  // 5. the mandate it ran under is signed by the owner, and names this agent and owner
  if (!mandate) add('mandate', null, 'no mandate saved');
  else {
    const mv = verifyMandate(mandate);
    const matches = mandate.id === receipt.mandate && mandate.agent === receipt.payer;
    add('mandate', mv.ok && matches, !mv.ok ? `mandate: ${mv.error}` : !matches ? 'saved mandate is not the one the receipt names' : `owner ${mandate.owner} signed it for this agent`);
  }

  // 6. 3.2: the receipt is in the gateway's public log, under a tree head signed by the same key
  if (o.logProof) {
    const origin = request ? new URL(request.url).origin : `https://${receipt.realm}`;
    const lp = await o.logProof(origin, receipt.id).catch(() => null);
    if (!lp) add('public log', null, `${receipt.realm} has no log entry for it (a gateway before 3.2, or offline)`);
    else {
      const headOk = verifyTreeHead(lp.head, receipt.gateway);
      const inOk = headOk && lp.size === lp.head.size && verifyInclusion(receiptLeaf(receipt), lp.index, lp.size, lp.proof.map(unb64), unb64(lp.head.root));
      add('public log', inOk, inOk ? `entry ${lp.index} of ${lp.size}, in a tree head signed ${lp.head.at}` : !headOk ? 'the tree head is not signed by the receipt key' : 'the inclusion proof does not lead to the signed root');
    }
  }

  const ok = checks.every((c) => c.ok !== false) && checks.find((c) => c.name === 'gateway signature')?.ok === true;
  return {
    ok,
    dir: basename(dir),
    summary: { realm: receipt.realm, resource: receipt.resource, amount: receipt.amount, currency: receipt.currency, at: receipt.at, ref: receipt.ref, status: receipt.response?.status, body_bytes: bodyBytes?.length },
    checks,
  };
}

// -- 3.2: what an agent spent, per task, day, realm or route, from its proof folders ---------------

export type CostBy = 'task' | 'day' | 'realm' | 'route';

export interface CostRow {
  key: string;
  calls: number;
  spent: number; // micro units
  free: number; // calls a route gave free
  cached: number; // calls answered from the cache
  saved: number; // micro units the cache saved
}

export interface CostReport {
  by: CostBy;
  currency: string;
  since: string | null;
  rows: CostRow[];
  total: CostRow;
}

/** Sum the proof folders under `root` (and the cache's hit log) by task, day, realm or route. */
export function costReport(root: string, o: { by?: CostBy; since?: string; task?: string; currency?: string } = {}): CostReport {
  const by = o.by ?? 'task';
  const currency = o.currency ?? 'USD';
  const rows = new Map<string, CostRow>();
  const row = (key: string) => { let r = rows.get(key); if (!r) { r = { key, calls: 0, spent: 0, free: 0, cached: 0, saved: 0 }; rows.set(key, r); } return r; };
  const keyOf = (rec: { at: string; realm?: string; resource?: string }, task: string | undefined) =>
    by === 'task' ? task ?? '(no task)' : by === 'day' ? rec.at.slice(0, 10) : by === 'realm' ? rec.realm ?? '(unknown)' : `${rec.realm ?? ''} ${rec.resource ?? ''}`.trim();
  const since = o.since ? Date.parse(o.since) : null;
  for (const dir of listProofs(root)) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as Receipt;
      if ((rec.currency ?? 'USD') !== currency) continue;
      if (since !== null && Date.parse(rec.at) < since) continue;
      const req = existsSync(join(dir, 'request.json')) ? (JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) as ProofRequest) : null;
      if (o.task && req?.task !== o.task) continue;
      const r = row(keyOf(rec, req?.task));
      r.calls++;
      r.spent += Number(rec.amount) || 0;
      if (rec.free) r.free++;
    } catch { /* a folder that does not parse is skipped */ }
  }
  // cache hits: the proof they came from says where; the hit says when and under which task
  const hitsFile = join(root, '.cache-hits.jsonl');
  if (existsSync(hitsFile)) {
    for (const line of readFileSync(hitsFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const h = JSON.parse(line) as { at: string; dir: string; saved: string; currency: string; task?: string };
        if (h.currency !== currency || (since !== null && Date.parse(h.at) < since) || (o.task && h.task !== o.task)) continue;
        let rec: Partial<Receipt> = {};
        try { rec = JSON.parse(readFileSync(join(h.dir, 'receipt.json'), 'utf8')); } catch { /* the proof was removed; the hit still counts */ }
        const r = row(keyOf({ at: h.at, realm: rec.realm, resource: rec.resource }, h.task));
        r.cached++;
        r.saved += Number(h.saved) || 0;
      } catch { /* skip */ }
    }
  }
  const list = [...rows.values()].sort((a, b) => b.spent - a.spent || b.calls - a.calls);
  const total = list.reduce((t, r) => ({ key: 'total', calls: t.calls + r.calls, spent: t.spent + r.spent, free: t.free + r.free, cached: t.cached + r.cached, saved: t.saved + r.saved }), { key: 'total', calls: 0, spent: 0, free: 0, cached: 0, saved: 0 });
  return { by, currency, since: o.since ?? null, rows: list, total };
}
