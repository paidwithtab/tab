// Mandate budget enforcement, shared by both rails. The spend counter lives in
// the gateway's SQLite file and is updated in the same transaction that
// reserves funds.

import { PayError, microToUsd } from '../protocol.js';
import type { Mandate } from '../mandate.js';
import type { Store } from '../store.js';

export function windowKey(m: Mandate, now: Date): string {
  return m.window === 'day' ? now.toISOString().slice(0, 10) : '';
}

/** Throws mandate-exceeded, otherwise records the spend. Call inside store.tx. */
export function checkAndSpend(store: Store, m: Mandate, amountMicro: number, now: Date): string {
  if (m.max_per_call !== null && amountMicro > Number(m.max_per_call)) {
    throw new PayError(
      'mandate-exceeded',
      `amount ${microToUsd(amountMicro)} exceeds the mandate per-call cap ${microToUsd(Number(m.max_per_call))}`,
    );
  }
  const key = windowKey(m, now);
  if (!store.addSpend(m.id, key, amountMicro, Number(m.budget))) {
    const scope = m.window === 'day' ? `for ${key}` : 'lifetime';
    throw new PayError(
      'mandate-exceeded',
      `mandate budget ${microToUsd(Number(m.budget))} ${scope} would be exceeded`,
    );
  }
  return key;
}
