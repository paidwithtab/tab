// The solana rail: USDC (or any 6-decimal SPL stablecoin), no custom program.
// The owner approved the agent as SPL delegate once; the agent signs a
// TransferChecked; the gateway co-signs as fee payer and broadcasts only after
// the upstream answered 2xx.

import { PayError, type Challenge } from '../protocol.js';
import { pubBytes, verifyBytes, loadKey, type KeyPair } from '../keys.js';
import type { HoldRow } from '../store.js';
import type { Rail, ReserveContext } from './index.js';
import { b58encode, b58decode32 } from '../solana/base58.js';
import { ata } from '../solana/pda.js';
import { SolanaRpc } from '../solana/rpc.js';
import { buildPaymentMessage } from '../solana/pay.js';
import {
  deserializeTransaction,
  serializeTransaction,
  isZeroSignature,
} from '../solana/tx.js';
import { sign as cryptoSign } from 'node:crypto';
import { privateKeyObject } from '../keys.js';

export interface SolanaRailConfig {
  rpc: string;
  mint: string; // base58
  decimals: number;
  fee_payer: string; // path to a key file the gateway holds
}

export class SolanaRail implements Rail {
  readonly name = 'solana' as const;
  readonly rpc: SolanaRpc;
  private feePayer: KeyPair;
  private feePayer58: string;

  constructor(private cfg: SolanaRailConfig) {
    if (cfg.decimals !== 6) throw new Error('draft 0 supports only 6-decimal mints');
    this.rpc = new SolanaRpc(cfg.rpc);
    this.feePayer = loadKey(cfg.fee_payer);
    this.feePayer58 = b58encode(pubBytes(this.feePayer.publicKey));
  }

  info(): Record<string, unknown> {
    return { mint: this.cfg.mint, decimals: this.cfg.decimals, fee_payer: this.feePayer58 };
  }

  async challengeExtras(): Promise<Partial<Challenge>> {
    return {
      solana: {
        mint: this.cfg.mint,
        decimals: this.cfg.decimals,
        fee_payer: this.feePayer58,
        recent_blockhash: await this.rpc.getLatestBlockhash(),
      },
    };
  }

  /** Byte-for-byte check of the agent's transaction against the challenge, then co-sign. */
  reserveLocal(ctx: ReserveContext): { tx: string | null } {
    const txB64 = ctx.cred.solana?.tx;
    if (!txB64) throw new PayError('malformed-credential', 'credential carries no solana transaction');
    let wire;
    try {
      wire = deserializeTransaction(new Uint8Array(Buffer.from(txB64, 'base64')));
    } catch {
      throw new PayError('malformed-credential', 'solana transaction does not parse');
    }
    const expected = buildPaymentMessage(ctx.chal, ctx.cred.mandate.owner, ctx.cred.agent);
    if (Buffer.compare(Buffer.from(wire.message), Buffer.from(expected.bytes)) !== 0) {
      throw new PayError('verification-failed', 'transaction does not match the challenge');
    }
    if (wire.signatures.length !== expected.numRequiredSignatures) {
      throw new PayError('verification-failed', 'wrong signature count');
    }
    if (!isZeroSignature(wire.signatures[0])) {
      throw new PayError('verification-failed', 'fee payer slot must be unsigned');
    }
    const agent58 = b58encode(pubBytes(ctx.cred.agent));
    const slot = expected.accounts.indexOf(agent58);
    if (slot <= 0 || slot >= expected.numRequiredSignatures) {
      throw new PayError('verification-failed', 'agent is not a signer');
    }
    const agentSig = Buffer.from(wire.signatures[slot]).toString('base64url');
    if (!verifyBytes(ctx.cred.agent, expected.bytes, agentSig)) {
      throw new PayError('verification-failed', 'agent transaction signature invalid');
    }
    const feeSig = cryptoSign(null, expected.bytes, privateKeyObject(this.feePayer));
    const signatures = wire.signatures.slice();
    signatures[0] = new Uint8Array(feeSig);
    const full = serializeTransaction({ signatures, message: expected.bytes });
    return { tx: Buffer.from(full).toString('base64') };
  }

  /** Simulate with the gateway's signature added. Nothing is broadcast here. */
  async reserveRemote(hold: HoldRow): Promise<void> {
    const sim = await this.rpc.simulateTransaction(hold.tx!);
    if (sim.err) {
      const s = JSON.stringify(sim.err);
      // Custom:1 = InsufficientFunds; Custom:4 = OwnerMismatch, which is what an
      // exhausted (auto-cleared) or revoked delegation looks like on chain.
      if (/"Custom":[14]\b/.test(s)) {
        throw new PayError(
          'insufficient-funds',
          'owner token balance, delegated amount or delegation does not cover this payment',
        );
      }
      const tail = sim.logs.slice(-3).join(' | ');
      throw new PayError('verification-failed', `simulation failed: ${s} ${tail}`);
    }
  }

  /** Broadcast and confirm; only called after the upstream answered 2xx. */
  async capture(hold: HoldRow): Promise<string> {
    const sig = await this.rpc.sendTransaction(hold.tx!);
    await this.rpc.confirm(sig);
    return `solana:${sig}`;
  }

  async release(_hold: HoldRow): Promise<void> {
    // nothing was broadcast; nothing to undo on-chain
  }

  /** Available = token balance of the wallet's ATA, in base units (micro for 6 decimals). */
  async balance(wallet: string): Promise<number> {
    const ataAddr = ata(pubBytes(wallet), b58decode32(this.cfg.mint));
    return Number(await this.rpc.tokenBalance(b58encode(ataAddr)));
  }
}
