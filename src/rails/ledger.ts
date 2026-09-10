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

  async challengeExtras(): Promise<Partial<Challenge>> {
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

  async balance(wallet: string): Promise<number> {
    return this.store.balance(wallet);
  }
}
