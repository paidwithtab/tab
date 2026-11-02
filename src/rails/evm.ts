// The evm rail: any ERC-20 (USDG, USDC, or a gateway's own token) on an EVM chain, built for
// Robinhood Chain, an Arbitrum-stack L2. The owner approved the agent as
// ERC-20 spender once; per payment the agent signs a type-2 transferFrom
// transaction; the gateway verifies it field-for-field against the challenge
// and broadcasts only after the upstream answered 2xx. The agent's account
// pays gas (EVM has no native fee-payer co-signing), so it needs a little ETH.

import { PayError, assertDecimals, baseUnitsToMicro, type Challenge } from '../protocol.js';
import type { HoldRow } from '../store.js';
import { PayoutPending, PayoutUnknown, LockTimeout, type Rail, type ReserveContext } from './index.js';
import type { Store, PayoutRow } from '../store.js';
import { EvmRpc, EvmRevert } from '../evm/rpc.js';
import { parseTx, hexToBytes, bytesToHex, bigToHex, isAddress, type ParsedTx } from '../evm/tx.js';
import { buildPaymentTx } from '../evm/pay.js';
import { scalarFromSeed, addressFromSeed } from '../evm/secp256k1.js';
import { signTx, erc20 } from '../evm/tx.js';
import { microToBaseUnits } from '../protocol.js';
import type { KeyPair } from '../keys.js';
import {
  evmNetwork, authorizationSigner, authorizationShapeError, transferWithAuthorizationData,
  type X402Authorization, type X402PaymentPayload, type X402Requirements,
} from '../x402.js';

export interface EvmRailConfig {
  rpc: string;
  chain_id: number; // Robinhood Chain: 46630 testnet, 4663 mainnet
  token: string; // ERC-20 contract address
  decimals: number; // 0 to 18; checked against the contract's decimals() at first use
  recipient: string; // seller payout address, 0x hex
  explorer?: string; // e.g. https://explorer.testnet.chain.robinhood.com
  // the token's EIP-712 domain, for x402 (EIP-3009 transferWithAuthorization); USDG on
  // Robinhood Chain is {"name": "Global Dollar", "version": "1"}
  eip712?: { name: string; version: string };
}

/** An x402 payment that passed every check, ready to settle once the upstream answered. */
export interface X402Accepted {
  authorization: X402Authorization;
  signature: string;
  payer: string;
  amount: bigint;
}

const GAS_LIMIT = 250_000;
const MAX_CANCELS = 5; // fee-bumped cancels at one nonce before the payout is left to the operator // transferFrom incl. Arbitrum-style L1 posting headroom
const X402_GAS_LIMIT = 300_000; // transferWithAuthorization, a signature check more than transferFrom

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

  async challengeExtras(o: { recipient?: string } = {}): Promise<Partial<Challenge>> {
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
        recipient: (o.recipient ?? this.cfg.recipient).toLowerCase(),
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
    const expected = buildPaymentTx(ctx.chal, evmOwner, parsed.nonce, ctx.payTo);
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

  // -- x402 ------------------------------------------------------------------------------

  private settler: KeyPair | null = null;
  private settling: Promise<unknown> = Promise.resolve(); // settlement sends one at a time: one nonce sequence

  /** Turn on x402: the settler key pays gas for transferWithAuthorization. Needs the token's EIP-712 domain. */
  enableX402(settler: KeyPair): void {
    if (!this.cfg.eip712) throw new Error('x402 needs evm.eip712 {name, version} in the spec (USDG: Global Dollar, 1)');
    this.settler = settler;
  }

  get x402Enabled(): boolean {
    return this.settler !== null;
  }

  x402Info(): Record<string, unknown> | null {
    if (!this.settler || !this.cfg.eip712) return null;
    return { x402Version: 2, scheme: 'exact', network: evmNetwork(this.cfg.chain_id), asset: this.cfg.token.toLowerCase(), payTo: this.cfg.recipient.toLowerCase(), eip712: this.cfg.eip712 };
  }

  /** What an x402 buyer must pay for one call at this price. */
  x402Requirements(priceMicro: number): X402Requirements {
    return {
      scheme: 'exact',
      network: evmNetwork(this.cfg.chain_id),
      amount: microToBaseUnits(BigInt(priceMicro), this.cfg.decimals).toString(),
      asset: this.cfg.token.toLowerCase(),
      payTo: this.cfg.recipient.toLowerCase(),
      maxTimeoutSeconds: 120,
      extra: { name: this.cfg.eip712!.name, version: this.cfg.eip712!.version },
    };
  }

  /**
   * Check an x402 payment against this price: shape, network, token, recipient, exact amount,
   * validity window, the signer, then the chain (authorization unused, balance, a dry run of the
   * transfer from the settler). Throws PayError with the x402 error code first in the detail.
   */
  async x402Verify(p: X402PaymentPayload, priceMicro: number, now = new Date()): Promise<X402Accepted> {
    const fail = (code: string, why: string) => new PayError('verification-failed', `${code}: ${why}`);
    if (!this.settler || !this.cfg.eip712) throw fail('unsupported_scheme', 'x402 is not enabled on this gateway');
    if (!p || p.x402Version !== 2) throw fail('invalid_x402_version', 'x402Version must be 2');
    const want = this.x402Requirements(priceMicro);
    const acc = p.accepted ?? ({} as X402Requirements);
    if (acc.scheme !== 'exact') throw fail('unsupported_scheme', 'only the exact scheme');
    if (acc.network !== want.network) throw fail('invalid_network', `this gateway settles on ${want.network}`);
    if (String(acc.asset).toLowerCase() !== want.asset) throw fail('invalid_payment_requirements', 'wrong asset');
    if (acc.extra?.assetTransferMethod !== undefined && acc.extra.assetTransferMethod !== 'eip3009') throw fail('invalid_payment_requirements', 'only eip3009 transfers');
    const a = p.payload?.authorization;
    const shape = authorizationShapeError(a);
    if (shape || typeof p.payload?.signature !== 'string') throw fail(shape ?? 'invalid_payload', 'malformed authorization');
    if (a.to.toLowerCase() !== want.payTo) throw fail('invalid_exact_evm_payload_recipient_mismatch', 'pays someone else');
    if (BigInt(a.value) !== BigInt(want.amount)) throw fail('invalid_exact_evm_payload_authorization_value_mismatch', `price is ${want.amount}`);
    const t = BigInt(Math.floor(now.getTime() / 1000));
    if (BigInt(a.validAfter) > t) throw fail('invalid_exact_evm_payload_authorization_valid_after', 'not valid yet');
    if (BigInt(a.validBefore) < t + 30n) throw fail('invalid_exact_evm_payload_authorization_valid_before', 'expires within 30 s');
    const payer = a.from.toLowerCase();
    const signer = authorizationSigner({ ...this.cfg.eip712, chainId: this.cfg.chain_id, token: this.cfg.token }, a, p.payload.signature);
    if (signer !== payer) throw fail('invalid_exact_evm_payload_signature', 'signature does not recover to authorization.from');
    // the chain: is the settler able to pay gas, and would the transfer go through right now?
    const settlerAddr = addressFromSeed(new Uint8Array(Buffer.from(this.settler.privateKey, 'base64url')));
    const fee = (await this.rpc.gasPrice()) * 2n + (await this.rpc.maxPriorityFeePerGas());
    if ((await this.rpc.balance(settlerAddr)) < BigInt(X402_GAS_LIMIT) * fee) throw fail('unexpected_verify_error', 'the gateway cannot pay gas to settle right now');
    if ((await this.rpc.erc20BalanceOf(this.cfg.token, payer)) < BigInt(a.value)) throw fail('insufficient_funds', 'payer balance is short');
    try {
      await this.rpc.ethCall(this.cfg.token, transferWithAuthorizationData(a, p.payload.signature), settlerAddr);
    } catch (err) {
      if (err instanceof EvmRevert) throw fail('invalid_transaction_state', 'the transfer would revert (authorization used, or signature refused by the token)');
      throw fail('unexpected_verify_error', `dry run failed: ${(err as Error).message}`);
    }
    return { authorization: a, signature: p.payload.signature, payer, amount: BigInt(a.value) };
  }

  /** Submit transferWithAuthorization from the settler and wait for it. Returns the tx hash; throws if it did not settle. */
  async x402Settle(x: X402Accepted): Promise<string> {
    const run = async () => {
      const settler = this.settler!;
      const from = addressFromSeed(new Uint8Array(Buffer.from(settler.privateKey, 'base64url')));
      const tip = await this.rpc.maxPriorityFeePerGas();
      const { raw, hash } = signTx({
        chainId: BigInt(this.cfg.chain_id),
        nonce: await this.rpc.transactionCount(from),
        maxPriorityFeePerGas: tip,
        maxFeePerGas: (await this.rpc.gasPrice()) * 2n + tip,
        gasLimit: BigInt(X402_GAS_LIMIT),
        to: this.cfg.token.toLowerCase(),
        value: 0n,
        data: transferWithAuthorizationData(x.authorization, x.signature),
      }, scalarFromSeed(new Uint8Array(Buffer.from(settler.privateKey, 'base64url'))));
      try {
        await this.rpc.sendRawTransaction(raw);
      } catch (err) {
        const known = await this.rpc.call('eth_getTransactionByHash', [hash]).catch(() => null);
        if (!known) throw err;
      }
      try {
        await this.rpc.waitForReceipt(hash);
      } catch (err) {
        if (/reverted|receipt of/.test((err as Error).message)) throw err;
        // broadcast and slow: the transfer is signed by the buyer and will land or not on its own
      }
      return hash;
    };
    const next = this.settling.then(run, run);
    this.settling = next.catch(() => undefined);
    return next;
  }

  // -- escrow (3.0) ----------------------------------------------------------------------
  // Pay-on-delivery orders and channel deposits are paid into an escrow address the gateway
  // holds the key of; the escrow key pays them out to the seller or back to the owner. The
  // buyer trusts the gateway with the money for that while, as a seller trusts it already.

  private escrowKey: KeyPair | null = null;
  private escrowStore: Store | null = null;
  private paying: Promise<unknown> = Promise.resolve(); // payouts send one at a time: one nonce sequence
  /** How long a lock or a payout waits for its receipt before it counts as not confirmed. */
  confirmMs = 60_000;

  enableEscrow(key: KeyPair, store: Store): void {
    this.escrowKey = key;
    this.escrowStore = store;
  }

  escrowRecipient(): string | null {
    return this.escrowKey ? addressFromSeed(new Uint8Array(Buffer.from(this.escrowKey.privateKey, 'base64url'))) : null;
  }

  /**
   * The buyer's transfer into the escrow address, confirmed. Unlike a capture, a slow receipt is
   * not good enough: an order or a channel must not open on money that may never arrive. Anything
   * short of a revert (a refused or unanswered broadcast, a slow receipt) is a LockTimeout: the
   * transfer may still land, so the gateway watches it rather than forgetting it.
   */
  async lock(hold: HoldRow): Promise<string> {
    const raw = hexToBytes(hold.tx!);
    const hash = parseTx(raw).hash;
    try {
      await this.rpc.sendRawTransaction(raw);
    } catch (err) {
      const known = await this.rpc.call('eth_getTransactionByHash', [hash]).catch(() => null);
      if (!known) throw new LockTimeout(`evm:${hash}`, `the payment into escrow was not accepted by the node (${(err as Error).message})`);
    }
    try {
      await this.rpc.waitForReceipt(hash, this.confirmMs);
    } catch (err) {
      if (/reverted/.test((err as Error).message)) throw err;
      throw new LockTimeout(`evm:${hash}`, `the payment into escrow did not confirm within ${Math.round(this.confirmMs / 1000)} s`);
    }
    return `evm:${hash}`;
  }

  /**
   * What a transaction of ours (or a buyer's) has come to. The account's mined nonce is read before
   * the receipt, so a transaction that mines between the two reads shows its receipt, not a consumed
   * nonce. A consumed nonce with no receipt is asked again by hash and by receipt; still unknown, it is
   * 'unknown' (a node lagging, or a transaction that lost its nonce), which never counts as failed.
   */
  private async txOutcome(hash: string, from: string, nonce: bigint): Promise<'ok' | 'reverted' | 'pending' | 'unknown'> {
    const mined = BigInt(await this.rpc.call('eth_getTransactionCount', [from, 'latest']));
    const receipt = await this.receiptFor(hash);
    if (receipt) return receipt;
    if (mined <= nonce) return 'pending';
    const byHash = await this.rpc.call('eth_getTransactionByHash', [hash]).catch(() => null);
    const again = await this.receiptFor(hash);
    if (again) return again;
    return byHash ? 'pending' : 'unknown';
  }

  /**
   * A receipt read strictly: ok on status 0x1, reverted on status 0x0, both only when the receipt
   * names this hash. Anything else (no receipt, another transaction's receipt, an odd status) is null.
   */
  private async receiptFor(hash: string): Promise<'ok' | 'reverted' | null> {
    const r = await this.rpc.call('eth_getTransactionReceipt', [hash]);
    if (!r || (typeof r.transactionHash === 'string' && r.transactionHash.toLowerCase() !== hash.toLowerCase())) return null;
    return r.status === '0x1' ? 'ok' : r.status === '0x0' ? 'reverted' : null;
  }

  /**
   * What became of a lock that timed out: landed (the money is in escrow), failed (it reverted, or a
   * day on its nonce is spent and nothing knows the transaction), or still pending.
   */
  async lockStatus(hold: HoldRow): Promise<'landed' | 'failed' | 'pending'> {
    const tx = parseTx(hexToBytes(hold.tx!));
    const out = await this.txOutcome(tx.hash, tx.from, tx.nonce);
    if (out === 'ok') return 'landed';
    if (out === 'reverted') return 'failed';
    if (out === 'unknown' && Date.now() - Date.parse(hold.created_at) > 86_400_000) return 'failed';
    return 'pending';
  }

  /**
   * Pay out of the escrow address, once per key. The signed transaction is stored before it is
   * sent; a retry looks that transaction up and rebroadcasts it. A new one is signed only when the
   * chain shows the stored one cannot land: its own receipt says it reverted, or a cancel transaction
   * of ours at the same nonce has mined. A consumed nonce without a receipt is never enough: that is
   * how a lagging node looks too, so the payout is left for the operator instead.
   */
  async payoutLocked(hold: HoldRow, to: 'seller' | 'buyer', micro: number, key: string): Promise<string | null> {
    if (micro <= 0) return null;
    if (!this.escrowKey || !this.escrowStore) throw new Error('this gateway has no escrow key');
    const addr = to === 'seller' ? this.cfg.recipient.toLowerCase() : hold.refund_to;
    if (!addr || !isAddress(addr)) throw new Error(`no ${to} address to pay out to`);
    const run = () => this.payoutOnce(hold, addr, micro, key);
    const next = this.paying.then(run, run);
    this.paying = next.catch(() => undefined);
    return next;
  }

  /** A payout marked stuck whose transaction landed after all: true when it is now confirmed. */
  async reconcilePayout(p: PayoutRow): Promise<boolean> {
    if (!p.hash || p.nonce === null) return false;
    const out = await this.txOutcome(p.hash, this.escrowRecipient()!, BigInt(p.nonce));
    if (out !== 'ok') return false;
    this.escrowStore!.putPayout({ ...p, state: 'confirmed', updated_at: new Date().toISOString() });
    return true;
  }

  private sign(tx: { nonce: bigint; to: string; value: bigint; data: Uint8Array; tip: bigint; fee: bigint }) {
    return signTx({ chainId: BigInt(this.cfg.chain_id), nonce: tx.nonce, maxPriorityFeePerGas: tx.tip, maxFeePerGas: tx.fee, gasLimit: BigInt(GAS_LIMIT), to: tx.to, value: tx.value, data: tx.data },
      scalarFromSeed(new Uint8Array(Buffer.from(this.escrowKey!.privateKey, 'base64url'))));
  }

  private async payoutOnce(hold: HoldRow, addr: string, micro: number, key: string): Promise<string> {
    const store = this.escrowStore!;
    const from = this.escrowRecipient()!;
    const now = () => new Date().toISOString();
    let p: PayoutRow | undefined = store.payout(key);
    if (p?.state === 'confirmed') return p.ref!;
    if (p?.raw && p.hash && p.nonce !== null) {
      // a transaction for this key exists: settle that one
      const out = await this.txOutcome(p.hash, from, BigInt(p.nonce));
      if (out === 'ok') { store.putPayout({ ...p, state: 'confirmed', updated_at: now() }); return p.ref!; }
      if (out === 'unknown') {
        // the nonce is spent and nothing shows this transaction: one of our cancels took it, or a node is behind.
        // Only a receipt for one of our own transactions at this nonce settles which.
        let freed = false;
        for (const c of p.cancels ?? []) if ((await this.receiptFor(c.hash)) !== null) { freed = true; break; }
        if (freed) {
          store.putPayout({ ...p, state: 'pending', raw: null, hash: null, nonce: null, cancels: [], last_error: 'cancelled; signing it again', updated_at: now() });
          p = store.payout(key);
        } else {
          throw new PayoutUnknown(p.ref!, `the nonce of ${p.hash} is spent but no node shows it; not signing again`);
        }
      } else if (out === 'reverted') {
        // our own transaction, reverted: it can never land, so a new one is safe
        store.putPayout({ ...p, state: 'pending', raw: null, hash: null, nonce: null, cancels: [], last_error: 'reverted on chain', updated_at: now() });
        p = store.payout(key);
      } else {
        return this.sendAndWait(p, true);
      }
    }
    // a new transaction: the nonce after anything of ours still in flight
    const pendingCount = await this.rpc.transactionCount(from);
    const inFlight = store.maxPendingNonce();
    const nonce = inFlight !== null && BigInt(inFlight) + 1n > pendingCount ? BigInt(inFlight) + 1n : pendingCount;
    const tip = await this.rpc.maxPriorityFeePerGas();
    const { raw, hash } = this.sign({ nonce, tip, fee: (await this.rpc.gasPrice()) * 2n + tip, to: this.cfg.token.toLowerCase(), value: 0n, data: erc20.transfer(addr, microToBaseUnits(BigInt(micro), this.cfg.decimals)) });
    const at = now();
    const row: PayoutRow = {
      key, hold_id: hold.id, to_addr: addr, amount: micro, state: 'sent', ref: `evm:${hash}`, raw: bytesToHex(raw), hash, nonce: Number(nonce),
      attempts: p?.attempts ?? 0, last_error: null, next_try_at: at, created_at: p?.created_at ?? at, updated_at: at, cancels: [],
    };
    store.putPayout(row); // written before it is sent: whatever happens next, a retry finds this transaction
    return this.sendAndWait(row, false);
  }

  private async sendAndWait(p: PayoutRow, rebroadcast: boolean): Promise<string> {
    const store = this.escrowStore!;
    // every cancel already signed for this nonce goes out again too: a refused or lost one must not leave a hole
    for (const c of p.cancels ?? []) await this.rpc.sendRawTransaction(hexToBytes(c.raw)).catch(() => undefined);
    try {
      await this.rpc.sendRawTransaction(hexToBytes(p.raw!));
    } catch (err) {
      const known = await this.rpc.call('eth_getTransactionByHash', [p.hash]).catch(() => null);
      const cancels = p.cancels ?? [];
      const lastKnown = cancels.length ? await this.rpc.call('eth_getTransactionByHash', [cancels.at(-1)!.hash]).catch(() => null) : null;
      if (!known && rebroadcast && p.attempts >= 2 && !lastKnown && cancels.length < MAX_CANCELS) {
        // the node keeps refusing it: free its nonce with a zero-value transaction to ourselves at the same
        // nonce, so later payouts are not stalled behind it; each further cancel pays more, so it can replace
        // the one before. Once any of ours at this nonce mines, this payout is signed again.
        const bump = 3n + BigInt(cancels.length) * 2n;
        const tip = (await this.rpc.maxPriorityFeePerGas()) * bump + 1n;
        const cancel = this.sign({ nonce: BigInt(p.nonce!), tip, fee: (await this.rpc.gasPrice()) * bump * 2n + tip, to: this.escrowRecipient()!, value: 0n, data: new Uint8Array(0) });
        const next = [...cancels, { raw: bytesToHex(cancel.raw), hash: cancel.hash }];
        store.putPayout({ ...store.payout(p.key)!, cancels: next, updated_at: new Date().toISOString() }); // kept before it is sent
        await this.rpc.sendRawTransaction(cancel.raw).catch(() => { /* rebroadcast on the next try */ });
      }
      if (!known) throw new PayoutPending(p.ref!, `payout sent, the node answered: ${(err as Error).message}`);
    }
    try {
      await this.rpc.waitForReceipt(p.hash!, this.confirmMs);
      store.putPayout({ ...store.payout(p.key)!, state: 'confirmed', updated_at: new Date().toISOString() });
      return p.ref!;
    } catch (err) {
      throw new PayoutPending(p.ref!, `payout ${p.hash} not confirmed: ${(err as Error).message}`);
    }
  }

  /** Pending nonce for an agent account, served via the gateway so clients need no RPC. */
  async accountNonce(address: string): Promise<number> {
    if (!isAddress(address)) throw new Error('not an address');
    return Number(await this.rpc.transactionCount(address.toLowerCase()));
  }
}
