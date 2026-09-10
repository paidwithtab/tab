// A rail moves the money. Two ship: ledger (SQLite sandbox balances) and
// solana (SPL stablecoin via delegated TransferChecked).

import type { Challenge, Credential } from '../protocol.js';
import type { HoldRow, Store } from '../store.js';
import { LedgerRail } from './ledger.js';
import { SolanaRail, type SolanaRailConfig } from './solana.js';

export interface ReserveContext {
  cred: Credential;
  chal: Challenge;
  priceMicro: number;
  holdId: string;
  now: Date;
}

export interface Rail {
  readonly name: 'ledger' | 'solana';
  /** rail_info for the discovery document. */
  info(): Record<string, unknown>;
  /** Extra challenge fields (solana: mint, fee payer, recent blockhash). */
  challengeExtras(): Promise<Partial<Challenge>>;
  /**
   * Synchronous reservation, called inside the gateway's SQLite transaction
   * after budget + redemption checks. Ledger debits the owner; solana verifies
   * the embedded transaction byte-for-byte and co-signs it. Throws PayError.
   */
  reserveLocal(ctx: ReserveContext): { tx: string | null };
  /** Asynchronous reservation step, outside the transaction (solana: simulate). */
  reserveRemote?(hold: HoldRow): Promise<void>;
  /** Settle a reserved hold after the upstream answered 2xx. Returns the receipt ref. */
  capture(hold: HoldRow): Promise<string>;
  /** Undo a reservation (upstream failed or answered non-2xx). */
  release(hold: HoldRow): Promise<void>;
  /** Available balance of a wallet on this rail, micro-USD. */
  balance(wallet: string): Promise<number>;
}

export function createRail(
  spec: { rail?: string; solana?: SolanaRailConfig },
  store: Store,
): Rail {
  if (!spec.rail || spec.rail === 'ledger') return new LedgerRail(store);
  if (spec.rail === 'solana') {
    if (!spec.solana) throw new Error('spec.rail is "solana" but spec.solana is missing');
    return new SolanaRail(spec.solana);
  }
  throw new Error(`unknown rail: ${spec.rail}`);
}

export { LedgerRail, SolanaRail };
