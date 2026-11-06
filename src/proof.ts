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

export interface ProofRequest {
  url: string;
  method: string;
  body?: string; // the request body as sent, when it was text
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
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ url: req.url, method: req.method, status: res.status, content_type: res.contentType, ...(req.body != null ? { body: req.body } : {}) }, null, 2) + '\n');
    writeFileSync(join(dir, 'mandate.json'), JSON.stringify(mandate, null, 2) + '\n');
    return { dir, receipt };
  } catch {
    return null;
  }
}

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
  o: { bodyPath?: string; key?: string; publishedKey?: (realm: string) => Promise<string | null> } = {},
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
    const chal = { id: receipt.challenge, amount: receipt.amount, realm: receipt.realm, recipient: receipt.recipient, resource: receipt.resource } as Challenge;
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

  const ok = checks.every((c) => c.ok !== false) && checks.find((c) => c.name === 'gateway signature')?.ok === true;
  return {
    ok,
    dir: basename(dir),
    summary: { realm: receipt.realm, resource: receipt.resource, amount: receipt.amount, currency: receipt.currency, at: receipt.at, ref: receipt.ref, status: receipt.response?.status, body_bytes: bodyBytes?.length },
    checks,
  };
}
