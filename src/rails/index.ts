// A rail moves the money. Two ship: ledger (SQLite sandbox balances) and
// evm (ERC-20 stablecoin on Robinhood Chain via a delegated transferFrom).

import type { Challenge, Credential, RailName } from '../protocol.js';
import type { HoldRow, Store } from '../store.js';
import { LedgerRail } from './ledger.js';
import { EvmRail, type EvmRailConfig } from './evm.js';

export interface ReserveContext {
  cred: Credential;
  chal: Challenge;
  priceMicro: number;
  holdId: string;
  now: Date;
}

export interface Rail {
  readonly name: RailName;
  /** rail_info for the discovery document. */
  info(): Record<string, unknown>;
  /** Extra challenge fields (evm: token, payout address, gas params). */
  challengeExtras(): Promise<Partial<Challenge>>;
  /**
   * Synchronous reservation, called inside the gateway's SQLite transaction
   * after budget + redemption checks. Ledger debits the owner; evm verifies
   * the embedded transaction against the challenge. Throws PayError.
   * txHash, when set, is stored UNIQUE so one signed payment can never back
   * two holds.
   */
  reserveLocal(ctx: ReserveContext): { tx: string | null; txHash?: string; txSlot?: string };
  /** Asynchronous reservation step, outside the transaction (simulate / dry run). */
  reserveRemote?(hold: HoldRow): Promise<void>;
  /** Settle a reserved hold after the upstream answered 2xx. Returns the receipt ref. */
  capture(hold: HoldRow): Promise<string>;
  /** Undo a reservation (upstream failed or answered non-2xx). */
  release(hold: HoldRow): Promise<void>;
  /** Available balance of a wallet on this rail, micro-USD. */
  balance(wallet: string): Promise<number>;
  /** evm only: pending nonce of an agent account, proxied by the gateway. */
  accountNonce?(address: string): Promise<number>;
}

export function createRail(
  spec: { rail?: string; evm?: EvmRailConfig },
  store: Store,
): Rail {
  if (!spec.rail || spec.rail === 'ledger') return new LedgerRail(store);
  if (spec.rail === 'evm') {
    if (!spec.evm) throw new Error('spec.rail is "evm" but spec.evm is missing');
    return new EvmRail(spec.evm);
  }
  throw new Error(`unknown rail: ${spec.rail}`);
}

export { LedgerRail, EvmRail };
