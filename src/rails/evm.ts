// The evm rail: any ERC-20 (USDG, USDC, or a gateway's own token) on an EVM chain — built for
// Robinhood Chain, an Arbitrum-stack L2. The owner approved the agent as
// ERC-20 spender once; per payment the agent signs a type-2 transferFrom
// transaction; the gateway verifies it field-for-field against the challenge
// and broadcasts only after the upstream answered 2xx. The agent's account
// pays gas (EVM has no native fee-payer co-signing), so it needs a little ETH.

import { PayError, assertDecimals, baseUnitsToMicro, type Challenge } from '../protocol.js';
import type { HoldRow } from '../store.js';
import type { Rail, ReserveContext } from './index.js';
import { EvmRpc, EvmRevert } from '../evm/rpc.js';
import { parseTx, hexToBytes, bigToHex, isAddress, type ParsedTx } from '../evm/tx.js';
import { buildPaymentTx } from '../evm/pay.js';

export interface EvmRailConfig {
  rpc: string;
  chain_id: number; // Robinhood Chain: 46630 testnet, 4663 mainnet
  token: string; // ERC-20 contract address
  decimals: number; // 0 to 18; checked against the contract's decimals() at first use
  recipient: string; // seller payout address, 0x hex
  explorer?: string; // e.g. https://explorer.testnet.chain.robinhood.com
}

const GAS_LIMIT = 250_000; // transferFrom incl. Arbitrum-style L1 posting headroom

export class EvmRail implements Rail {
  readonly name = 'evm' as const;
  readonly rpc: EvmRpc;
  private chainChecked = false;

  constructor(private cfg: EvmRailConfig) {
    assertDecimals(cfg.decimals);
    if (!isAddress(cfg.token)) throw new Error(`evm.token is not an address: ${cfg.token}`);
    if (!isAddress(cfg.recipient)) throw new Error(`evm.recipient is not an address: ${cfg.recipient}`);
    if (!Number.isInteger(cfg.chain_id) || cfg.chain_id <= 0) throw new Error('evm.chain_id is required');
    this.rpc = new EvmRpc(cfg.rpc);
  }

  info(): Record<string, unknown> {
    return {
      chain_id: this.cfg.chain_id,
      token: this.cfg.token.toLowerCase(),
      decimals: this.cfg.decimals,
      recipient: this.cfg.recipient.toLowerCase(),
      ...(this.cfg.explorer ? { explorer: this.cfg.explorer.replace(/\/$/, '') } : {}),
    };
  }

  async challengeExtras(): Promise<Partial<Challenge>> {
    if (!this.chainChecked) {
      const actual = await this.rpc.chainId();
      if (actual !== BigInt(this.cfg.chain_id)) {
        throw new Error(`RPC is chain ${actual}, spec says ${this.cfg.chain_id}`);
      }
      const onChain = await this.rpc.erc20Decimals(this.cfg.token);
      if (onChain !== this.cfg.decimals) {
        throw new Error(`token ${this.cfg.token} has ${onChain} decimals, spec says ${this.cfg.decimals}`);
      }
      this.chainChecked = true;
    }
    const gasPrice = await this.rpc.gasPrice();
    const tip = await this.rpc.maxPriorityFeePerGas();
    return {
      evm: {
        chain_id: this.cfg.chain_id,
        token: this.cfg.token.toLowerCase(),
        decimals: this.cfg.decimals,
        recipient: this.cfg.recipient.toLowerCase(),
        max_fee_per_gas: bigToHex(gasPrice * 2n + tip),
        max_priority_fee_per_gas: bigToHex(tip),
        gas_limit: GAS_LIMIT,
      },
    };
  }

  /** Parse the agent's transaction and check every field against the challenge. */
  reserveLocal(ctx: ReserveContext): { tx: string | null; txHash?: string; txSlot?: string } {
    const txHex = ctx.cred.evm?.tx;
    if (!txHex || !/^0x[0-9a-fA-F]+$/.test(txHex)) {
      throw new PayError('malformed-credential', 'credential carries no evm transaction');
    }
    const evmOwner = ctx.cred.mandate.evm_owner;
    if (!evmOwner) {
      throw new PayError('mandate-invalid', 'mandate has no evm_owner; issue one with --evm-owner (tab does this automatically)');
    }
    let parsed: ParsedTx;
    try {
      parsed = parseTx(hexToBytes(txHex));
    } catch (err) {
      throw new PayError('malformed-credential', `evm transaction does not parse: ${(err as Error).message}`);
    }
    const expected = buildPaymentTx(ctx.chal, evmOwner, parsed.nonce);
    const mismatch =
      parsed.chainId !== expected.chainId ? 'chain id' :
      parsed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas ? 'priority fee' :
      parsed.maxFeePerGas !== expected.maxFeePerGas ? 'max fee' :
      parsed.gasLimit !== expected.gasLimit ? 'gas limit' :
      parsed.to !== expected.to ? 'token contract' :
      parsed.value !== expected.value ? 'value' :
      Buffer.compare(Buffer.from(parsed.data), Buffer.from(expected.data)) !== 0 ? 'calldata' :
      null;
    if (mismatch) {
      throw new PayError('verification-failed', `transaction does not match the challenge (${mismatch})`);
    }
    // parseTx already recovered the sender from the signature; whoever signed
    // is the spender the token contract will check the allowance of.
    return { tx: txHex, txHash: parsed.hash, txSlot: `${parsed.from}:${parsed.nonce}` };
  }

  /** Chain-state checks + dry run. Nothing is broadcast here. */
  async reserveRemote(hold: HoldRow): Promise<void> {
    const parsed = parseTx(hexToBytes(hold.tx!));
    const nonce = await this.rpc.transactionCount(parsed.from);
    if (parsed.nonce !== nonce) {
      throw new PayError('payment-expired', `stale nonce (transaction ${parsed.nonce}, account ${nonce}); request a fresh challenge`);
    }
    const gasNeeded = parsed.gasLimit * parsed.maxFeePerGas;
    if ((await this.rpc.balance(parsed.from)) < gasNeeded) {
      throw new PayError('insufficient-funds', 'agent account cannot cover gas; send it a little ETH');
    }
    try {
      await this.rpc.ethCall(parsed.to, parsed.data, parsed.from);
    } catch (err) {
      if (err instanceof EvmRevert) {
        throw new PayError(
          'insufficient-funds',
          'transferFrom reverts: owner balance or the agent\'s ERC-20 allowance does not cover this payment',
        );
      }
      throw new PayError('verification-failed', `dry run failed: ${(err as Error).message}`);
    }
  }

  /**
   * Broadcast and wait for the receipt; only called after the upstream answered 2xx. Throws when
   * the payment did not settle (refused, reverted). The hash is computed here, not taken from the
   * node, and a transaction the network already has counts as broadcast (a failover node after a
   * timed out first try). Once broadcast, a receipt that is merely slow does not void the hold:
   * the transfer may still land, and refunding it would let total spend pass the mandate.
   */
  async capture(hold: HoldRow): Promise<string> {
    const raw = hexToBytes(hold.tx!);
    const hash = parseTx(raw).hash;
    try {
      const said = await this.rpc.sendRawTransaction(raw);
      if (typeof said === 'string' && said.toLowerCase() !== hash) throw new Error(`node returned hash ${said}, expected ${hash}`);
    } catch (err) {
      const known = await this.rpc.call('eth_getTransactionByHash', [hash]).catch(() => null);
      if (!known) throw err;
    }
    try {
      await this.rpc.waitForReceipt(hash);
    } catch (err) {
      if (/reverted|receipt of/.test((err as Error).message)) throw err;
      // still pending after the wait: booked as paid; the chain is the record (ref names the tx)
    }
    return `evm:${hash}`;
  }

  async release(_hold: HoldRow): Promise<void> {
    // nothing was broadcast; nothing to undo on-chain
  }

  /** Balance of an 0x address in micro units of the token, whatever its decimals. */
  async balance(wallet: string): Promise<number> {
    if (!isAddress(wallet)) {
      throw new Error('the evm rail looks up 0x addresses (tab evm address <key> prints yours)');
    }
    const base = await this.rpc.erc20BalanceOf(this.cfg.token, wallet.toLowerCase());
    return Number(baseUnitsToMicro(base, this.cfg.decimals));
  }

  /** Pending nonce for an agent account — served via the gateway so clients need no RPC. */
  async accountNonce(address: string): Promise<number> {
    if (!isAddress(address)) throw new Error('not an address');
    return Number(await this.rpc.transactionCount(address.toLowerCase()));
  }
}
