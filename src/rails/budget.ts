// Mandate budget enforcement, shared by both rails. The spend counter lives in
// the gateway's SQLite file and is updated in the same transaction that
// reserves funds. A sub-mandate's payment counts against its own counter and
// against every ancestor's, so delegating can never spend past the parent.

import { PayError, formatAmount } from '../protocol.js';
import { mandateChain, type Mandate } from '../mandate.js';
import type { Store } from '../store.js';

export function windowKey(m: Mandate, now: Date): string {
  return m.window === 'day' ? now.toISOString().slice(0, 10) : '';
}

export interface SpendOptions {
  currency?: string; // for the messages: "0.05 TTT" on a token gateway, "$0.05" on a USD one
  perCall?: boolean; // false for a channel deposit, which is not one call; default true
}

/**
 * Throws mandate-exceeded, otherwise records the spend against the mandate and every
 * ancestor. Call inside store.tx (a throw rolls back counters already raised). Returns the
 * leaf's window key and the ancestors' [mandate id, window key] pairs.
 */
export function checkAndSpend(store: Store, m: Mandate, amountMicro: number, now: Date, o: SpendOptions = {}): string {
  return checkAndSpendChain(store, m, amountMicro, now, o).key;
}

export function checkAndSpendChain(store: Store, m: Mandate, amountMicro: number, now: Date, o: SpendOptions = {}): { key: string; chain: Array<[string, string]> } {
  const fmt = (n: number) => formatAmount(n, o.currency ?? 'USD');
  const chain = mandateChain(m);
  const keys: Array<[string, string]> = [];
  for (const [i, x] of chain.entries()) {
    const who = i === 0 ? 'mandate' : 'parent mandate';
    if (o.perCall !== false && x.max_per_call !== null && amountMicro > Number(x.max_per_call)) {
      throw new PayError('mandate-exceeded', `amount ${fmt(amountMicro)} exceeds the ${who} per-call cap ${fmt(Number(x.max_per_call))}`);
    }
    const key = windowKey(x, now);
    if (!store.addSpend(x.id, key, amountMicro, Number(x.budget))) {
      const scope = x.window === 'day' ? `for ${key}` : 'lifetime';
      throw new PayError('mandate-exceeded', `${who} budget ${fmt(Number(x.budget))} ${scope} would be exceeded`);
    }
    keys.push([x.id, key]);
  }
  return { key: keys[0][1], chain: keys.slice(1) };
}

/** Give a refunded amount back to the leaf and every ancestor counter. */
export function refundChain(store: Store, mandateId: string, windowKey: string, chain: Array<[string, string]> | null | undefined, micro: number): void {
  if (micro <= 0) return;
  store.refundSpend(mandateId, windowKey, micro);
  for (const [id, key] of chain ?? []) store.refundSpend(id, key, micro);
}
