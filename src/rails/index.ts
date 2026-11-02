// A rail moves the money. Two ship: ledger (SQLite sandbox balances) and
// evm (ERC-20 stablecoin on Robinhood Chain via a delegated transferFrom).

import type { Challenge, Credential, RailName } from '../protocol.js';
import type { HoldRow, Store, PayoutRow } from '../store.js';
import { LedgerRail } from './ledger.js';
import { EvmRail, type EvmRailConfig } from './evm.js';

export interface ReserveContext {
  cred: Credential;
  chal: Challenge;
  priceMicro: number;
  holdId: string;
  now: Date;
  /** 3.0, evm: the address the payment must go to when not the challenge's evm.recipient (the escrow address). */
  payTo?: string;
}

export interface Rail {
  readonly name: RailName;
  /** rail_info for the discovery document. */
  info(): Record<string, unknown>;
  /** Extra challenge fields (evm: token, payout address, gas params). `recipient` overrides the evm payout address (a channel deposit pays escrow). */
  challengeExtras(o?: { recipient?: string }): Promise<Partial<Challenge>>;
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

  // -- 3.0: money the gateway holds for a while (escrow, channel deposits) --

  /** Where held money sits, for challenges (evm: the escrow address); null when this rail cannot hold money. */
  escrowRecipient(): string | null;
  /**
   * Move a reserved hold into the gateway's keeping. Ledger: the owner was debited at reserve, so
   * nothing moves. Evm: broadcast the payment into the escrow address and wait for it to confirm;
   * throws LockTimeout when it did not confirm in time (it may still land; see lockStatus).
   */
  lock(hold: HoldRow): Promise<string>;
  /**
   * Pay out part of a locked hold, to the seller or back to the buyer's owner, once per `key`: a
   * second call with the same key settles the same payout, never a new one. Returns the ref, or null
   * for a zero amount. Throws PayoutPending (with the ref) when the payout went out but has not
   * confirmed yet; any other throw means nothing went out on this try.
   */
  payoutLocked(hold: HoldRow, to: 'seller' | 'buyer', micro: number, key: string): Promise<string | null>;
  /** evm: what became of a lock that timed out. */
  lockStatus?(hold: HoldRow): Promise<'landed' | 'failed' | 'pending'>;
  /** evm: a payout marked stuck whose transaction landed after all; true when it is now confirmed. */
  reconcilePayout?(p: PayoutRow): Promise<boolean>;
}

/** The payout was sent and may still land: its outcome is fixed, only its confirmation is outstanding. */
export class PayoutPending extends Error {
  constructor(public ref: string, message: string) {
    super(message);
    this.name = 'PayoutPending';
  }
}

/** A payout whose transaction no node shows, though its nonce is spent: never signed again, left for the operator. */
export class PayoutUnknown extends PayoutPending {
  constructor(ref: string, message: string) {
    super(ref, message);
    this.name = 'PayoutUnknown';
  }
}

/** The buyer's transfer into escrow did not confirm in time. */
export class LockTimeout extends Error {
  constructor(public ref: string, message: string) {
    super(message);
    this.name = 'LockTimeout';
  }
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
