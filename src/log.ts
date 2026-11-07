// 3.2: the public receipt log. Every signed receipt a gateway issues becomes a leaf of an
// append-only Merkle tree (the RFC 9162 construction Certificate Transparency uses). The
// gateway signs the tree's size and root; anyone can then ask for proof that a receipt is
// in the tree (inclusion) and that a later tree still contains an earlier one (consistency).
// A gateway that hid, changed or reordered a charge after signing a tree head would have to
// sign two heads no consistency proof can join, and either head is evidence.

import { createHash } from 'node:crypto';
import { canonicalJson, type Receipt } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

/** The leaf hash of a receipt: SHA-256(0x00 || canonical JSON of the signed receipt). */
export function receiptLeaf(r: Receipt): Buffer {
  return sha(LEAF, Buffer.from(canonicalJson(r)));
}

const nodeHash = (l: Uint8Array, r: Uint8Array): Buffer => sha(NODE, l, r);

/** Largest power of two smaller than n (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle tree hash of leaf hashes; the empty tree hashes to SHA-256 of nothing. */
export function treeHash(leaves: Uint8Array[]): Buffer {
  if (leaves.length === 0) return sha();
  // bottom up, so a large log does not recurse deeply
  let level: Buffer[] = leaves.map((l) => Buffer.from(l));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

/** The audit path for leaf `index` in the tree of `leaves` (RFC 9162 section 2.1.3.1). */
export function inclusionProof(index: number, leaves: Uint8Array[]): Buffer[] {
  if (index < 0 || index >= leaves.length) throw new Error('index outside the tree');
  const path = (m: number, d: Uint8Array[]): Buffer[] => {
    if (d.length <= 1) return [];
    const k = split(d.length);
    return m < k ? [...path(m, d.slice(0, k)), treeHash(d.slice(k))] : [...path(m - k, d.slice(k)), treeHash(d.slice(0, k))];
  };
  return path(index, leaves);
}

/** The proof that the first `m` leaves are a prefix of `leaves` (RFC 9162 section 2.1.4.1). */
export function consistencyProof(m: number, leaves: Uint8Array[]): Buffer[] {
  const n = leaves.length;
  if (m < 0 || m > n) throw new Error('old size outside the tree');
  if (m === 0 || m === n) return [];
  const sub = (mm: number, d: Uint8Array[], whole: boolean): Buffer[] => {
    if (mm === d.length) return whole ? [] : [treeHash(d)];
    const k = split(d.length);
    return mm <= k ? [...sub(mm, d.slice(0, k), whole), treeHash(d.slice(k))] : [...sub(mm - k, d.slice(k), false), treeHash(d.slice(0, k))];
  };
  return sub(m, leaves, true);
}

/** Check an audit path (RFC 9162 section 2.1.3.2). */
export function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], root: Uint8Array): boolean {
  if (index < 0 || index >= size) return false;
  let fn = index, sn = size - 1;
  let r: Buffer = Buffer.from(leaf);
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && r.equals(Buffer.from(root));
}

/** Check a consistency proof between two tree heads (RFC 9162 section 2.1.4.2). */
export function verifyConsistency(m: number, n: number, proof: Uint8Array[], oldRoot: Uint8Array, newRoot: Uint8Array): boolean {
  if (m < 0 || m > n) return false;
  if (m === n) return proof.length === 0 && Buffer.from(oldRoot).equals(Buffer.from(newRoot));
  if (m === 0) return proof.length === 0;
  const p = proof.map((x) => Buffer.from(x));
  // m a power of two: the old root is itself the first node of the path
  if ((m & (m - 1)) === 0) p.unshift(Buffer.from(oldRoot));
  if (!p.length) return false;
  let fn = m - 1, sn = n - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr: Buffer = p[0], sr: Buffer = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && fr.equals(Buffer.from(oldRoot)) && sr.equals(Buffer.from(newRoot));
}

/** A signed tree head: the log's size and root at a time, signed with the gateway's receipt key. */
export interface TreeHead {
  ver: 'tab-log-1';
  realm: string;
  size: number;
  root: string; // base64url SHA-256
  at: string;
  key: string; // the gateway's receipt key
  sig: string;
}

const headMessage = (h: Omit<TreeHead, 'sig'>): Buffer => Buffer.from('tab-log-head\n' + canonicalJson(h));

export function signTreeHead(key: KeyPair, realm: string, size: number, root: Uint8Array, at = new Date()): TreeHead {
  const body: Omit<TreeHead, 'sig'> = { ver: 'tab-log-1', realm, size, root: Buffer.from(root).toString('base64url'), at: at.toISOString(), key: key.publicKey };
  return { ...body, sig: signBytes(key, headMessage(body)) };
}

export function verifyTreeHead(h: TreeHead, key?: string): boolean {
  if (!h || h.ver !== 'tab-log-1' || !Number.isSafeInteger(h.size) || h.size < 0 || typeof h.root !== 'string') return false;
  if (key !== undefined && h.key !== key) return false;
  const { sig, ...body } = h;
  return verifyBytes(h.key, headMessage(body), sig);
}

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const unb64 = (s: string): Buffer => Buffer.from(String(s), 'base64url');
