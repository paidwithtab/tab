// 3.2: a cache of paid results. The same request inside the cache window returns the result
// already bought, for nothing, from its proof folder: the bytes, the signed receipt and the
// mandate are all still there, so `tab verify` checks a cached answer like a fresh one. Kept in
// the proof folder root: .cache.json maps a request to its proof, .cache-hits.jsonl records
// every hit and what it saved.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Receipt } from './protocol.js';

export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;

interface Entry { dir: string; expires: number; amount: string; currency: string; at: string }

/** The cache key of a request: method, URL and body. */
export function cacheKey(method: string, url: string, body?: string | null): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${url}\n`).update(body ?? '').digest('base64url');
}

/**
 * How long a response may be reused: its Cache-Control when it sets one (no-store means never), else
 * the default. Only for GET and HEAD by default: a repeated POST may be meant to act twice (send, book,
 * charge), so its answer is reused only when the seller marks it with an explicit max-age.
 */
export function ttlOf(cacheControl: string | null, defaultMs: number, method = 'GET'): number {
  const cc = (cacheControl ?? '').toLowerCase();
  if (/(^|,)\s*(no-store|no-cache|private)\b/.test(cc)) return 0;
  const m = /(?:^|,)\s*max-age=(\d+)/.exec(cc);
  if (m) return Math.min(Number(m[1]) * 1000, 24 * 3_600_000);
  return ['GET', 'HEAD'].includes(method.toUpperCase()) ? defaultMs : 0;
}

export class PaidCache {
  private file: string;
  private hits: string;
  constructor(private root: string, private ttlMs = DEFAULT_CACHE_TTL_MS) {
    this.file = join(root, '.cache.json');
    this.hits = join(root, '.cache-hits.jsonl');
  }

  private read(): Record<string, Entry> {
    try { return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>) : {}; } catch { return {}; }
  }

  private write(map: Record<string, Entry>): void {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      writeFileSync(this.file + '.tmp', JSON.stringify(map));
      renameSync(this.file + '.tmp', this.file);
    } catch { /* a cache that cannot be written is only a cache */ }
  }

  /** A live entry for this request whose proof folder still has its body, or null. */
  get(key: string, now = Date.now()): (Entry & { body: Buffer; receipt: Receipt }) | null {
    if (this.ttlMs <= 0) return null;
    const e = this.read()[key];
    if (!e || e.expires <= now) return null;
    try {
      const body = readFileSync(join(e.dir, 'body'));
      const receipt = JSON.parse(readFileSync(join(e.dir, 'receipt.json'), 'utf8')) as Receipt;
      return { ...e, body, receipt };
    } catch {
      return null;
    }
  }

  /** Remember a paid result for the window its response allows. */
  put(key: string, dir: string, receipt: Receipt, cacheControl: string | null, method = 'GET', now = Date.now()): void {
    if (this.ttlMs <= 0) return;
    const ttl = ttlOf(cacheControl, this.ttlMs, method);
    if (ttl <= 0) return;
    const map = this.read();
    for (const [k, v] of Object.entries(map)) if (v.expires <= now) delete map[k];
    const keys = Object.keys(map);
    if (keys.length >= MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES + 1)) delete map[k];
    map[key] = { dir, expires: now + ttl, amount: receipt.amount, currency: receipt.currency ?? 'USD', at: receipt.at };
    this.write(map);
  }

  /** Record a hit: what it would have cost, under which task. */
  noteHit(e: Entry, task: string | null): void {
    try { appendFileSync(this.hits, JSON.stringify({ at: new Date().toISOString(), dir: e.dir, saved: e.amount, currency: e.currency, ...(task ? { task } : {}) }) + '\n'); } catch { /* best effort */ }
  }

  /** Every hit recorded, oldest first. */
  hitLog(): Array<{ at: string; dir: string; saved: string; currency: string; task?: string }> {
    try {
      return readFileSync(this.hits, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
