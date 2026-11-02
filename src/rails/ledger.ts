// The ledger rail: balances in the gateway's own SQLite file. Sandbox money,
// created with `tab mint`, moved instantly, free.

import { PayError, microToUsd, type Challenge } from '../protocol.js';
import type { HoldRow, Store } from '../store.js';
import type { Rail, ReserveContext } from './index.js';

export class LedgerRail implements Rail {
  readonly name = 'ledger' as const;

  constructor(private store: Store) {}

  info(): Record<string, unknown> {
    return {};
  }

  async challengeExtras(_o?: { recipient?: string }): Promise<Partial<Challenge>> {
    return {};
  }

  reserveLocal(ctx: ReserveContext): { tx: string | null } {
    const owner = ctx.cred.mandate.owner;
    if (!this.store.debit(owner, ctx.priceMicro)) {
      throw new PayError(
        'insufficient-funds',
        `owner wallet holds less than ${microToUsd(ctx.priceMicro)} on this gateway`,
      );
    }
    return { tx: null };
  }

  async capture(hold: HoldRow): Promise<string> {
    this.store.credit(hold.recipient, hold.amount);
    return `ledger:${hold.id}`;
  }

  async release(hold: HoldRow): Promise<void> {
    this.store.credit(hold.owner, hold.amount);
  }

  escrowRecipient(): string {
    return 'ledger'; // held money stays a debit on the owner until paid out
  }

  async lock(hold: HoldRow): Promise<string> {
    return `ledger:${hold.id}`;
  }

  async payoutLocked(hold: HoldRow, to: 'seller' | 'buyer', micro: number, key: string): Promise<string | null> {
    if (micro <= 0) return null;
    // the credit and its payout row commit together, so a retry with the same key credits nothing more
    return this.store.tx(() => {
      const prior = this.store.payout(key);
      if (prior?.state === 'confirmed') return prior.ref;
      const wallet = to === 'seller' ? hold.recipient : hold.owner;
      this.store.credit(wallet, micro);
      const at = new Date().toISOString();
      const ref = `ledger:${hold.id}:${to}`;
      this.store.putPayout({ key, hold_id: hold.id, to_addr: wallet, amount: micro, state: 'confirmed', ref, raw: null, hash: null, nonce: null, attempts: prior?.attempts ?? 0, last_error: null, next_try_at: at, created_at: prior?.created_at ?? at, updated_at: at });
      return ref;
    });
  }

  async balance(wallet: string): Promise<number> {
    return this.store.balance(wallet);
  }
}
