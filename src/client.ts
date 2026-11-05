// The buyer side: a payment-aware fetch. On 402 it parses the challenge, signs
// a credential (and on the evm rail builds and signs the payment transaction),
// and retries exactly once. verify() checks the signed receipt of a paid
// response against the gateway's published receipt key and the bytes received.

import {
  bodyDigest,
  encodeCredentialHeader,
  formatAmount,
  microToUsd,
  parseChallengeHeader,
  parseReceiptHeader,
  signCredential,
  usdToMicro,
  verifyReceipt,
  type Challenge,
  type Receipt,
} from './protocol.js';
import { mandateExpired, realmAllowed, perCallCap, approvalThreshold, mandateChain, type Mandate } from './mandate.js';
import type { Approval, ApprovalRequest } from './approval.js';
import {
  CHANNEL_PATH, encodeVoucherHeader, nextVoucherAmount, signClose, signVoucher, type ChannelState,
} from './channel.js';
import { windowKey } from './rails/budget.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { scalarFromSeed } from './evm/secp256k1.js';
import {
  decodeX402, encodeX402, chainIdOf, signAuthorization, X402_VERSION,
  type X402PaymentRequired, type X402Requirements, type X402SettlementResponse,
} from './x402.js';
import type { KeyPair } from './keys.js';
import { buildSignedPaymentTxEvm } from './evm/pay.js';
import { addressFromSeed } from './evm/secp256k1.js';

export class PaymentRefused extends Error {
  constructor(
    public reason: string,
    public challenge: Challenge,
  ) {
    super(reason);
    this.name = 'PaymentRefused';
  }
}

export interface ChallengeRequest {
  amount: string; // micro units of `currency`
  amountUsd: string; // the amount as a decimal string ("0.01"), whatever the currency
  currency: string; // "USD", or the token a gateway charges in
  resource: string;
  realm: string;
  rail: string;
}

/**
 * A token this client will sign payments in: the chain, the contract, its decimals and the
 * currency a gateway must name for it. A challenge carries its own token and decimals, so
 * without a pin a hostile gateway could name 18 decimals for a 6-decimal token (a 0.01
 * charge becoming the whole allowance) or name another token the owner approved.
 */
export interface EvmTokenPin {
  chainId: number;
  token: string; // 0x contract address
  decimals: number;
  currency: string; // "USD" for dollar stablecoins
}

/** The tokens tab's own gateways settle in. More come from options or TAB_EVM_TOKENS. */
export const KNOWN_EVM_TOKENS: EvmTokenPin[] = [
  { chainId: 4663, token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, currency: 'USD' }, // USDG, Robinhood Chain
  { chainId: 46630, token: '0x5b6c7caf7f99f99154fd8375ec935fcf03f326f5', decimals: 6, currency: 'USD' }, // USDC, Robinhood Chain testnet
  { chainId: 46630, token: '0x8f6fe411e76b79d6eb6521872340c37c3210ee47', decimals: 18, currency: 'TTT' }, // tab's test token
  // where most x402 sites take payment
  { chainId: 8453, token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, currency: 'USD' }, // USDC, Base
  { chainId: 84532, token: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals: 6, currency: 'USD' }, // USDC, Base Sepolia
];

/** TAB_EVM_TOKENS="chainId:currency:0xtoken:decimals,..." */
export function parseEvmTokens(spec: string | undefined): EvmTokenPin[] {
  if (!spec) return [];
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [chainId, currency, token, decimals] = entry.split(':');
    if (!/^\d+$/.test(chainId ?? '') || !currency || !/^0x[0-9a-fA-F]{40}$/.test(token ?? '') || !/^\d+$/.test(decimals ?? '')) {
      throw new Error(`TAB_EVM_TOKENS entry must be chainId:currency:0xtoken:decimals, got ${JSON.stringify(entry)}`);
    }
    return { chainId: Number(chainId), currency, token: token.toLowerCase(), decimals: Number(decimals) };
  });
}

export interface TabClientOptions {
  agent: KeyPair;
  mandate: Mandate;
  /** Client-side per-call ceiling in USD, independent of the mandate. */
  maxPerCallUsd?: string;
  /**
   * The currency this client will pay in; default "USD". A gateway that charges
   * in its own token says so in the challenge, and a mandate's numbers mean that
   * token there, so the client refuses any other currency unless told to accept it.
   */
  currency?: string;
  /** Optional veto; amounts in micro-USD. Return false to refuse. */
  onChallenge?: (challenge: Challenge, request: ChallengeRequest) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  /** Extra tokens to pay in on the evm rail, beside KNOWN_EVM_TOKENS and TAB_EVM_TOKENS. */
  evmTokens?: EvmTokenPin[];
  /**
   * Pay x402 sites (a 402 with PAYMENT-REQUIRED and no tab challenge). The agent signs an EIP-3009
   * transfer from its own address, so the owner funds that address; the mandate still bounds it,
   * counted here because an x402 site keeps no tab budget. Default true.
   */
  x402?: boolean;
  /** Where the x402 spend against each mandate is kept between runs (JSON). Default: in memory only. */
  x402Ledger?: string;
  /**
   * 3.0: pay priced calls from payment channels: one deposit per gateway, then a signed voucher per
   * call. `depositUsd` opens a channel on the first call to a gateway that takes them; without it only
   * channels opened with openChannel are used. `file` keeps the channels between runs (JSON).
   */
  channels?: { depositUsd?: string; file?: string };
}

/** Per call choices on top of RequestInit. */
export interface PayOptions {
  /** Pay on delivery: the payment is held until the seller delivers, refunded if it does not. The route must offer it. */
  escrow?: boolean;
  /** The owner's approval, for a payment above the mandate's approval threshold. */
  approval?: Approval;
  /** On approval-required, wait this long for the owner to approve (polling the gateway), then retry. Default 0: return the 402. */
  waitForApprovalMs?: number;
  /** Pay this call per call even when a channel is open. */
  noChannel?: boolean;
}

/** What a pay-on-delivery call reports in its Tab-Escrow header. */
export interface EscrowTicket {
  id: string;
  state: 'held' | 'delivered' | 'refunded';
  deadline: string;
  token: string; // reads the order's status and result
  status: string; // the order's status URL
}

/** A channel this client holds at one gateway: the gateway's view, kept fresh from every Tab-Channel header. */
export type HeldChannel = ChannelState & { origin: string };

export class TabClient {
  private maxPerCallMicro: number | null;
  private accepts: string;
  private receiptKeys = new Map<string, string | null>();
  private evmTokens: EvmTokenPin[];
  // mandate id + window -> micro this client has spent under it: signed away to x402 sites, and paid to tab
  // gateways through it. Gateways keep their own counters; x402 sites keep none, so this is their budget check.
  private x402Spent: Record<string, number> = {};
  private channelBook: Record<string, HeldChannel> = {}; // origin -> open channel
  private channelSupport = new Map<string, boolean>();

  constructor(private opts: TabClientOptions) {
    if (opts.channels?.file && existsSync(opts.channels.file)) {
      try { this.channelBook = JSON.parse(readFileSync(opts.channels.file, 'utf8')) as Record<string, HeldChannel>; } catch { /* start fresh */ }
    }
    this.maxPerCallMicro = opts.maxPerCallUsd != null ? usdToMicro(opts.maxPerCallUsd) : null;
    this.accepts = opts.currency ?? 'USD';
    this.evmTokens = [...KNOWN_EVM_TOKENS, ...parseEvmTokens(process.env.TAB_EVM_TOKENS), ...(opts.evmTokens ?? [])];
    if (opts.x402Ledger && existsSync(opts.x402Ledger)) {
      try { this.x402Spent = JSON.parse(readFileSync(opts.x402Ledger, 'utf8')) as Record<string, number>; } catch { /* start fresh */ }
    }
    if (opts.mandate.agent !== opts.agent.publicKey) {
      throw new Error('mandate is not for this agent key');
    }
  }

  async fetch(url: string | URL, init: RequestInit = {}, pay: PayOptions = {}): Promise<Response> {
    const res = await this.fetchOnce(url, init, pay);
    if (res.status !== 402 || !pay.waitForApprovalMs) return res;
    // above the approval threshold: wait for the owner, then ask again
    const request = await approvalRequestOf(res);
    if (!request) return res;
    const doFetch = this.opts.fetch ?? fetch;
    const deadline = Date.now() + pay.waitForApprovalMs;
    const origin = new URL(url).origin;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(0, deadline - Date.now()))));
      try {
        const st = await doFetch(`${origin}/.well-known/tab/approvals/${request.id}`, { signal: AbortSignal.timeout(10_000) });
        if (st.ok && ((await st.json()) as { approved?: boolean }).approved) return this.fetchOnce(url, init, { ...pay, noChannel: true });
      } catch { /* keep waiting */ }
    }
    return res;
  }

  private async fetchOnce(url: string | URL, init: RequestInit, pay: PayOptions): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const first = await doFetch(url, init);
    if (first.status !== 402) return first;
    const chal = parseChallengeHeader(first.headers.get('www-authenticate'));
    if (!chal) {
      // no tab challenge: an x402 site, perhaps (a tab gateway that also speaks x402 sends both; tab wins)
      if (this.opts.x402 === false) return first;
      const offer = await x402Offer(first);
      return offer ? this.payX402(url, init, offer, doFetch) : first;
    }

    const amount = Number(chal.amount);
    const currency = typeof chal.currency === 'string' ? chal.currency : 'USD';
    const request: ChallengeRequest = {
      amount: chal.amount,
      amountUsd: microToUsd(amount),
      currency,
      resource: chal.resource,
      realm: chal.realm,
      rail: chal.rail,
    };
    if (currency !== this.accepts) {
      throw new PaymentRefused(
        `gateway charges in ${currency}; this client pays in ${this.accepts} (set currency to accept it)`,
        chal,
      );
    }
    // the mandate binds the client too: an honest gateway enforces it, a hostile one would not
    const m = this.opts.mandate;
    if (mandateExpired(m)) throw new PaymentRefused('mandate has expired', chal);
    // the challenge must come from the realm it claims: a hostile site answering with an allowed gateway's realm would
    // otherwise be paid under that allow list (on the evm rail, with transfers to a recipient it names)
    const where = new URL(url);
    if (!isLocalHost(where.hostname) && String(chal.realm) !== where.host && String(chal.realm) !== where.hostname) {
      throw new PaymentRefused(`challenge claims realm ${chal.realm} but came from ${where.host}`, chal);
    }
    if (!realmAllowed(m, String(chal.realm))) throw new PaymentRefused(`realm ${chal.realm} is not in the mandate's allow list`, chal);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentRefused(`challenge amount ${chal.amount} is not a positive amount`, chal);
    const fmt = (n: number) => formatAmount(n, currency);
    const cap = perCallCap(m);
    if (cap !== null && amount > cap && chal.resource !== `POST ${CHANNEL_PATH}`) {
      throw new PaymentRefused(`price ${fmt(amount)} exceeds the mandate's per-call cap ${fmt(cap)}`, chal);
    }
    if (amount > Number(m.budget)) throw new PaymentRefused(`price ${fmt(amount)} exceeds the mandate budget`, chal);
    const method = (init.method ?? 'GET').toUpperCase();
    if (chal.resource !== `${method} ${new URL(url).pathname}`) {
      throw new PaymentRefused(`challenge is for ${chal.resource}, not ${method} ${new URL(url).pathname}`, chal);
    }
    if (this.maxPerCallMicro !== null && amount > this.maxPerCallMicro && chal.resource !== `POST ${CHANNEL_PATH}`) {
      throw new PaymentRefused(
        `price ${fmt(amount)} exceeds the client cap ${fmt(this.maxPerCallMicro)}`,
        chal,
      );
    }
    if (pay.escrow && !chal.escrow) throw new PaymentRefused(`${chal.resource} does not take pay on delivery`, chal);
    if (this.opts.onChallenge && !(await this.opts.onChallenge(chal, request))) {
      throw new PaymentRefused('refused by onChallenge', chal);
    }
    const body = init.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new Error('tab client supports only string or byte request bodies (they are signed)');
    }

    // a channel open at this gateway pays the call with a voucher, no transaction per call
    const origin = new URL(url).origin;
    if (!pay.escrow && !pay.noChannel && !pay.approval && chal.resource !== `POST ${CHANNEL_PATH}` && (this.opts.channels || this.channelBook[origin])) {
      const ch = await this.channelFor(origin, currency);
      if (ch) {
        const payVoucher = async (c: HeldChannel) => {
          const voucher = signVoucher(this.opts.agent, {
            channel: c.id, amount: String(nextVoucherAmount(c, amount)), resource: chal.resource,
            query: new URL(url).search, body_sha256: bodyDigest(body as string | Uint8Array | null | undefined),
          });
          const headers = new Headers(init.headers);
          headers.set('authorization', encodeVoucherHeader(voucher));
          const r = await doFetch(url, { ...init, headers });
          this.noteChannel(origin, r);
          return { r, problem: r.status === 402 ? await problemCodeOf(r) : null };
        };
        let { r: res, problem } = await payVoucher(ch);
        // our view of the channel was behind (another client on it): resync from the refusal and try once more
        const now = this.channelBook[origin];
        if (problem === 'channel-exhausted' && now && Number(now.deposit) - Number(now.spent) - Number(now.held) >= amount) ({ r: res, problem } = await payVoucher(now));
        if (problem !== 'channel-invalid' && problem !== 'channel-exhausted') return res;
        // the channel is spent, closed or expired: forget it and pay this call per call, under the same challenge
        delete this.channelBook[origin];
        this.saveChannels();
      }
    }

    let evm: { tx: string } | undefined;
    let evmLevels: string[] = [];
    if (chal.rail === 'evm') {
      // a signed transfer is a bearer instrument: counted against every level of the mandate chain before it leaves
      const at = new Date();
      const levels = mandateChain(this.opts.mandate).map((x) => ({ x, key: `${x.id}:${windowKey(x, at)}` }));
      for (const { x, key } of levels) {
        if ((this.x402Spent[key] ?? 0) + amount > Number(x.budget)) {
          throw new PaymentRefused(`price ${fmt(amount)} would pass the ${x === this.opts.mandate ? 'mandate' : 'parent mandate'} budget (signed so far ${fmt(this.x402Spent[key] ?? 0)})`, chal);
        }
      }
      evmLevels = levels.map((l) => l.key);
      const evmOwner = this.opts.mandate.evm_owner;
      if (!evmOwner) throw new PaymentRefused('mandate has no evm_owner; re-issue it for the evm rail', chal);
      const info = chal.evm;
      const pin = info && this.evmTokens.find((t) => t.chainId === Number(info.chain_id) && t.token === String(info.token).toLowerCase() && t.currency === currency);
      if (!info || !pin) {
        throw new PaymentRefused(`gateway asks for a token this client does not know (${info?.token} on chain ${info?.chain_id} as ${currency}); pin it with evmTokens or TAB_EVM_TOKENS`, chal);
      }
      if (Number(info.decimals) !== pin.decimals) {
        throw new PaymentRefused(`gateway says ${info.token} has ${info.decimals} decimals; it has ${pin.decimals}`, chal);
      }
      const agentAddr = addressFromSeed(new Uint8Array(Buffer.from(this.opts.agent.privateKey, 'base64url')));
      const nonceRes = await doFetch(`${origin}/.well-known/tab/evm/nonce/${agentAddr}`);
      if (!nonceRes.ok) throw new PaymentRefused('gateway could not report the agent nonce', chal);
      const nonce = BigInt(((await nonceRes.json()) as { nonce: number }).nonce);
      // pay on delivery on the evm rail pays the gateway's escrow address the challenge names
      const payTo = pay.escrow ? chal.escrow?.recipient : undefined;
      if (pay.escrow && !payTo) throw new PaymentRefused('the challenge names no escrow address', chal);
      evm = { tx: buildSignedPaymentTxEvm(chal, evmOwner, this.opts.agent, nonce, payTo) };
      for (const key of evmLevels) this.x402Spent[key] = (this.x402Spent[key] ?? 0) + amount;
      this.saveSpent();
    }
    const cred = signCredential(this.opts.agent, chal, this.opts.mandate, {
      evm,
      query: new URL(url).search,
      body,
      escrow: pay.escrow,
      approval: pay.approval,
    });
    const headers = new Headers(init.headers);
    headers.set('authorization', encodeCredentialHeader(cred));
    const paid = await doFetch(url, { ...init, headers });
    // what this mandate paid a tab gateway counts toward its budget at x402 sites too (a channel's calls
    // were paid by its deposit, which is itself counted here when the channel opens)
    const receipt = receiptOf(paid);
    if (receipt && chal.rail !== 'evm' && receipt.mandate === this.opts.mandate.id && (!receipt.channel || receipt.channel.kind === 'deposit')) this.countSpend(Number(receipt.amount));
    return paid;
  }

  private saveSpent(): void {
    if (!this.opts.x402Ledger) return;
    writeFileSync(this.opts.x402Ledger + '.tmp', JSON.stringify(this.x402Spent));
    renameSync(this.opts.x402Ledger + '.tmp', this.opts.x402Ledger);
  }

  /** Add to the client's own count of what the mandate chain has spent, which x402 payments are checked against. */
  private countSpend(micro: number): void {
    if (!Number.isSafeInteger(micro) || micro <= 0) return;
    const at = new Date();
    for (const x of mandateChain(this.opts.mandate)) { const key = `${x.id}:${windowKey(x, at)}`; this.x402Spent[key] = (this.x402Spent[key] ?? 0) + micro; }
    if (this.opts.x402Ledger) {
      writeFileSync(this.opts.x402Ledger + '.tmp', JSON.stringify(this.x402Spent));
      renameSync(this.opts.x402Ledger + '.tmp', this.opts.x402Ledger);
    }
  }

  /** Pay an x402 site within the mandate: pick a known token, check every limit, sign, retry once. */
  private async payX402(url: string | URL, init: RequestInit, offer: X402Offer, doFetch: typeof fetch): Promise<Response> {
    const m = this.opts.mandate;
    const refuse = (reason: string): never => {
      throw new PaymentRefused(reason, { ver: 'x402', id: '', realm: new URL(url).hostname, rail: 'evm', amount: '0', recipient: '', resource: '', expires_at: '' } as unknown as Challenge);
    };
    const host = new URL(url).hostname;
    // the first entry this client can pay: exact, EIP-3009, a token it knows, in its currency
    let pick: { req: X402Requirements; pin: EvmTokenPin } | null = null;
    for (const r of offer.required.accepts ?? []) {
      const chainId = chainIdOf(String(r?.network ?? ''));
      const method = r?.extra?.assetTransferMethod;
      if (r?.scheme !== 'exact' || chainId === null || (method !== undefined && method !== 'eip3009')) continue;
      if (typeof r.extra?.name !== 'string' || typeof r.extra?.version !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(String(r.payTo))) continue;
      const pin = this.evmTokens.find((t) => t.chainId === chainId && t.token === String(r.asset).toLowerCase() && t.currency === this.accepts);
      if (pin) { pick = { req: r, pin }; break; }
    }
    if (!pick) return refuse(`x402 site asks for nothing this client pays in (${this.accepts} on a known token)`);
    const { req, pin } = pick;
    if (!/^\d{1,40}$/.test(String(req.amount))) return refuse('x402 amount is not a whole number of token units');
    const base = BigInt(req.amount);
    const scale = pin.decimals >= 6 ? 10n ** BigInt(pin.decimals - 6) : 1n;
    const micro = Number(pin.decimals >= 6 ? (base + scale - 1n) / scale : base * 10n ** BigInt(6 - pin.decimals)); // rounded up
    if (!Number.isSafeInteger(micro) || micro <= 0) return refuse('x402 amount is out of range');
    if (mandateExpired(m)) return refuse('mandate has expired');
    if (!realmAllowed(m, host)) return refuse(`${host} is not in the mandate's allow list`);
    const cap = perCallCap(m);
    if (cap !== null && micro > cap) return refuse(`price ${formatAmount(micro, this.accepts)} exceeds the mandate's per-call cap ${formatAmount(cap, this.accepts)}`);
    if (this.maxPerCallMicro !== null && micro > this.maxPerCallMicro) return refuse(`price ${microToUsd(micro)} exceeds the client cap ${microToUsd(this.maxPerCallMicro)}`);
    // an x402 site takes no tab approval: above the threshold the owner has to be asked another way
    const gate = approvalThreshold(m);
    if (gate !== null && micro > gate) return refuse(`price ${formatAmount(micro, this.accepts)} is above the mandate's approval threshold ${formatAmount(gate, this.accepts)}; an x402 site cannot take the owner's approval`);
    // counted against every level of the chain, as a tab gateway counts it
    const at = new Date();
    const levels = mandateChain(m).map((x) => ({ x, key: `${x.id}:${windowKey(x, at)}` }));
    for (const { x, key } of levels) {
      if ((this.x402Spent[key] ?? 0) + micro > Number(x.budget)) {
        return refuse(`price ${microToUsd(micro)} would pass the ${x === m ? 'mandate' : 'parent mandate'} budget (x402 spend so far ${microToUsd(this.x402Spent[key] ?? 0)})`);
      }
    }
    const body = init.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('tab client supports only string or byte request bodies');

    const seed = new Uint8Array(Buffer.from(this.opts.agent.privateKey, 'base64url'));
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: addressFromSeed(seed), to: String(req.payTo).toLowerCase(), value: base.toString(),
      validAfter: String(now - 60), validBefore: String(now + Math.min(Math.max(Number(req.maxTimeoutSeconds) || 60, 30), 600)),
      nonce: '0x' + randomBytes(32).toString('hex'),
    };
    const signature = signAuthorization({ name: String(req.extra!.name), version: String(req.extra!.version), chainId: pin.chainId, token: pin.token }, authorization, scalarFromSeed(seed));
    // a signed authorization is a bearer instrument: count it before it leaves, paid or not
    for (const { key } of levels) this.x402Spent[key] = (this.x402Spent[key] ?? 0) + micro;
    if (this.opts.x402Ledger) {
      writeFileSync(this.opts.x402Ledger + '.tmp', JSON.stringify(this.x402Spent));
      renameSync(this.opts.x402Ledger + '.tmp', this.opts.x402Ledger);
    }
    const headers = new Headers(init.headers);
    if (offer.version === 1) {
      headers.set('x-payment', encodeX402({ x402Version: 1, scheme: 'exact', network: req.network, payload: { signature, authorization } }));
    } else {
      headers.set('payment-signature', encodeX402({ x402Version: X402_VERSION, resource: offer.required.resource, accepted: req, payload: { signature, authorization } }));
    }
    return doFetch(url, { ...init, headers });
  }

  /**
   * Check the receipt of a paid response: signed by the key the gateway
   * publishes, for this client's mandate, committing to the request sent and
   * to exactly `body`, the bytes read from `res`. Null when there is no receipt.
   */
  async verify(url: string | URL, res: Response, body: string | Uint8Array, sent: RequestInit = {}): Promise<{ ok: boolean; reason?: string } | null> {
    const receipt = receiptOf(res);
    if (!receipt) return null;
    const sentBody = sent.body;
    if (sentBody != null && typeof sentBody !== 'string' && !(sentBody instanceof Uint8Array)) {
      return { ok: false, reason: 'cannot check a request body that is not a string or bytes' };
    }
    return verifyReceipt(receipt, {
      key: await this.receiptKey(new URL(url).origin),
      body,
      status: res.status,
      mandate: this.opts.mandate.id,
      request: { query: new URL(url).search, body_sha256: bodyDigest(sentBody) },
    });
  }

  // -- 3.0: pay on delivery --------------------------------------------------------------

  /**
   * Follow a pay-on-delivery order until the seller delivers or it is refunded, then read the
   * result and check its receipt. `waitMs` 0 asks once.
   */
  async escrowResult(ticket: EscrowTicket, waitMs = 0): Promise<{ state: string; order: Record<string, unknown>; body?: Uint8Array; contentType?: string | null; receipt?: Receipt | null; verified?: { ok: boolean; reason?: string } }> {
    const doFetch = this.opts.fetch ?? fetch;
    const deadline = Date.now() + waitMs;
    for (;;) {
      // the token rides in a header, not the URL, so it stays out of logs and referrers
      const auth = { 'tab-escrow-token': ticket.token };
      const r = await doFetch(ticket.status, { headers: auth, signal: AbortSignal.timeout(10_000) });
      const order = (await r.json()) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(order.error ?? `escrow status: HTTP ${r.status}`));
      if (order.state === 'delivered') {
        const res = await doFetch(`${ticket.status}/result`, { headers: auth, signal: AbortSignal.timeout(30_000) });
        const body = new Uint8Array(await res.arrayBuffer());
        const receipt = receiptOf(res);
        const verified = receipt ? verifyReceipt(receipt, { key: await this.receiptKey(new URL(ticket.status).origin), body, status: res.status, mandate: this.opts.mandate.id }) : { ok: false, reason: 'no receipt' };
        return { state: 'delivered', order, body, contentType: res.headers.get('content-type'), receipt, verified };
      }
      if (order.state === 'refunded' || Date.now() >= deadline) return { state: String(order.state), order };
      await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(100, deadline - Date.now()))));
    }
  }

  // -- 3.0: payment channels ---------------------------------------------------------------

  /** The channels this client holds, by gateway origin. */
  channels(): Record<string, HeldChannel> {
    return { ...this.channelBook };
  }

  /** Open a channel at a gateway: one paid call for the deposit, under the mandate. */
  async openChannel(origin: string, depositUsd: string, ttlS?: number): Promise<HeldChannel> {
    origin = origin.replace(/\/$/, '');
    const body = JSON.stringify({ deposit: depositUsd, ...(ttlS ? { ttl_s: ttlS } : {}) });
    const res = await this.fetchOnce(`${origin}${CHANNEL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { noChannel: true });
    const doc = (await res.json()) as { channel?: ChannelState; detail?: string; error?: string };
    if (res.status !== 201 || !doc.channel) throw new Error(`channel not opened: ${doc.detail ?? doc.error ?? `HTTP ${res.status}`}`);
    const held = { ...doc.channel, origin };
    this.channelBook[origin] = held;
    this.saveChannels();
    return held;
  }

  /** Take over a channel opened elsewhere (by another client of the same agent key), so this one pays from and closes it. */
  holdChannel(c: HeldChannel): void {
    if (c.agent !== this.opts.agent.publicKey) throw new Error('that channel belongs to another agent key');
    this.channelBook[c.origin.replace(/\/$/, '')] = c;
    this.saveChannels();
  }

  /** Close the channel at a gateway: the seller gets what was spent, the rest goes back. */
  async closeChannel(origin: string): Promise<{ channel: ChannelState; receipt: Receipt }> {
    origin = origin.replace(/\/$/, '');
    const ch = this.channelBook[origin];
    if (!ch) throw new Error(`no channel held at ${origin}`);
    const doFetch = this.opts.fetch ?? fetch;
    const r = await doFetch(`${origin}${CHANNEL_PATH}/${ch.id}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sig: signClose(this.opts.agent, ch.id) }),
    });
    const doc = (await r.json()) as { channel?: ChannelState; receipt?: Receipt; error?: string };
    if (!r.ok || !doc.channel) throw new Error(`close failed: ${doc.error ?? `HTTP ${r.status}`}`);
    delete this.channelBook[origin];
    this.saveChannels();
    return { channel: doc.channel, receipt: doc.receipt! };
  }

  /**
   * The open channel to pay this gateway from, opening one when told to and the gateway takes them.
   * A channel opened under another mandate of this agent counts: the gateway holds it to the
   * mandate it was opened under, and the per-call checks above still ran against this one.
   */
  private async channelFor(origin: string, currency: string): Promise<HeldChannel | null> {
    const held = this.channelBook[origin];
    if (held && held.state === 'open' && Date.parse(held.expires_at) > Date.now() + 5_000 && held.agent === this.opts.agent.publicKey) return held;
    if (held) { delete this.channelBook[origin]; this.saveChannels(); }
    const deposit = this.opts.channels?.depositUsd;
    if (!deposit || currency !== this.accepts) return null;
    if (!this.channelSupport.has(origin)) {
      try {
        const d = await (this.opts.fetch ?? fetch)(`${origin}/.well-known/tab`, { signal: AbortSignal.timeout(10_000) });
        this.channelSupport.set(origin, d.ok && !!((await d.json()) as { channels?: unknown }).channels);
      } catch { return null; }
    }
    if (!this.channelSupport.get(origin)) return null;
    return this.openChannel(origin, deposit);
  }

  /** Keep the gateway's account of the channel from a voucher-paid response. */
  private noteChannel(origin: string, res: Response): void {
    const h = res.headers.get('tab-channel');
    if (!h || !this.channelBook[origin]) return;
    try {
      const st = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as ChannelState;
      if (st.id === this.channelBook[origin].id) { this.channelBook[origin] = { ...st, origin }; this.saveChannels(); }
    } catch { /* keep the old view */ }
  }

  private saveChannels(): void {
    const file = this.opts.channels?.file;
    if (!file) return;
    writeFileSync(file + '.tmp', JSON.stringify(this.channelBook, null, 2));
    renameSync(file + '.tmp', file);
  }

  /** The gateway's published receipt key, from its discovery document; cached per origin once known. */
  private async receiptKey(origin: string): Promise<string | null> {
    if (this.receiptKeys.has(origin)) return this.receiptKeys.get(origin)!;
    try {
      const r = await (this.opts.fetch ?? fetch)(`${origin}/.well-known/tab`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const key = ((await r.json()) as { receipt_key?: unknown }).receipt_key;
      const found = typeof key === 'string' ? key : null;
      this.receiptKeys.set(origin, found);
      return found;
    } catch {
      return null; // not cached: a gateway that was briefly unreachable gets asked again
    }
  }
}

/** Functional form of TabClient. */
export async function tabFetch(
  url: string | URL,
  init: RequestInit = {},
  options: TabClientOptions,
): Promise<Response> {
  return new TabClient(options).fetch(url, init);
}

/** The order a pay-on-delivery call opened (the Tab-Escrow header); null on any other response. */
export function escrowOf(res: Response): EscrowTicket | null {
  const h = res.headers.get('tab-escrow');
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as EscrowTicket; } catch { return null; }
}

/** The approval request in an approval-required 402, for the owner to sign; null on any other response. */
export async function approvalRequestOf(res: Response): Promise<ApprovalRequest | null> {
  if (res.status !== 402) return null;
  try {
    const doc = (await res.clone().json()) as { type?: string; approval_request?: ApprovalRequest };
    return doc.type === 'urn:tab:problem:approval-required' && doc.approval_request ? doc.approval_request : null;
  } catch { return null; }
}

async function problemCodeOf(res: Response): Promise<string | null> {
  try {
    const t = ((await res.clone().json()) as { type?: string }).type;
    return typeof t === 'string' && t.startsWith('urn:tab:problem:') ? t.slice('urn:tab:problem:'.length) : null;
  } catch { return null; }
}

/** The receipt of a paid response; null if the route was free or the call voided. */
export function receiptOf(res: Response): Receipt | null {
  return parseReceiptHeader(res.headers.get('tab-receipt'));
}

interface X402Offer {
  version: 1 | 2;
  required: X402PaymentRequired;
}

/** The x402 requirements in a 402: the PAYMENT-REQUIRED header (version 2), or a version 1 body. */
async function x402Offer(res: Response): Promise<X402Offer | null> {
  const v2 = decodeX402<X402PaymentRequired>(res.headers.get('payment-required'));
  if (v2 && Array.isArray(v2.accepts)) return { version: 2, required: v2 };
  try {
    const body = (await res.clone().json()) as { x402Version?: number; accepts?: Array<Record<string, unknown>> };
    if (body?.x402Version === 1 && Array.isArray(body.accepts)) {
      const accepts = body.accepts.map((a) => ({ ...a, amount: String(a.maxAmountRequired ?? a.amount ?? '') })) as unknown as X402Requirements[];
      return { version: 1, required: { x402Version: 1, resource: { url: String(body.accepts[0]?.resource ?? '') }, accepts } };
    }
  } catch { /* not JSON */ }
  return null;
}

/** The settlement an x402 site reported for a paid response (PAYMENT-RESPONSE, or X-PAYMENT-RESPONSE in version 1). */
export function x402ResponseOf(res: Response): X402SettlementResponse | null {
  return decodeX402<X402SettlementResponse>(res.headers.get('payment-response') ?? res.headers.get('x-payment-response'));
}

/** A development host (loopback or a .local name), where a gateway's realm need not match the address it is reached at. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || /^127\./.test(h);
}
