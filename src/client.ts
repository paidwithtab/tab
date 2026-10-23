// The buyer side: a payment-aware fetch. On 402 it parses the challenge, signs
// a credential (and on the evm rail builds and signs the payment transaction),
// and retries exactly once. verify() checks the signed receipt of a paid
// response against the gateway's published receipt key and the bytes received.

import {
  bodyDigest,
  encodeCredentialHeader,
  microToUsd,
  parseChallengeHeader,
  parseReceiptHeader,
  signCredential,
  usdToMicro,
  verifyReceipt,
  type Challenge,
  type Receipt,
} from './protocol.js';
import { mandateExpired, realmAllowed, type Mandate } from './mandate.js';
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
}

export class TabClient {
  private maxPerCallMicro: number | null;
  private accepts: string;
  private receiptKeys = new Map<string, string | null>();
  private evmTokens: EvmTokenPin[];
  private x402Spent: Record<string, number> = {}; // mandate id + window -> micro signed away to x402 sites

  constructor(private opts: TabClientOptions) {
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

  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
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
    if (!realmAllowed(m, String(chal.realm))) throw new PaymentRefused(`realm ${chal.realm} is not in the mandate's allow list`, chal);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentRefused(`challenge amount ${chal.amount} is not a positive amount`, chal);
    if (m.max_per_call !== null && amount > Number(m.max_per_call)) {
      throw new PaymentRefused(`price ${request.amountUsd} exceeds the mandate's per-call cap ${microToUsd(Number(m.max_per_call))}`, chal);
    }
    if (amount > Number(m.budget)) throw new PaymentRefused(`price ${request.amountUsd} exceeds the mandate budget`, chal);
    const method = (init.method ?? 'GET').toUpperCase();
    if (chal.resource !== `${method} ${new URL(url).pathname}`) {
      throw new PaymentRefused(`challenge is for ${chal.resource}, not ${method} ${new URL(url).pathname}`, chal);
    }
    if (this.maxPerCallMicro !== null && amount > this.maxPerCallMicro) {
      throw new PaymentRefused(
        `price ${request.amountUsd} exceeds the client cap ${microToUsd(this.maxPerCallMicro)}`,
        chal,
      );
    }
    if (this.opts.onChallenge && !(await this.opts.onChallenge(chal, request))) {
      throw new PaymentRefused('refused by onChallenge', chal);
    }

    let evm: { tx: string } | undefined;
    if (chal.rail === 'evm') {
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
      const origin = new URL(url).origin;
      const nonceRes = await doFetch(`${origin}/.well-known/tab/evm/nonce/${agentAddr}`);
      if (!nonceRes.ok) throw new PaymentRefused('gateway could not report the agent nonce', chal);
      const nonce = BigInt(((await nonceRes.json()) as { nonce: number }).nonce);
      evm = { tx: buildSignedPaymentTxEvm(chal, evmOwner, this.opts.agent, nonce) };
    }
    const body = init.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new Error('tab client supports only string or byte request bodies (they are signed)');
    }
    const cred = signCredential(this.opts.agent, chal, this.opts.mandate, {
      evm,
      query: new URL(url).search,
      body,
    });
    const headers = new Headers(init.headers);
    headers.set('authorization', encodeCredentialHeader(cred));
    return doFetch(url, { ...init, headers });
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
    if (m.max_per_call !== null && micro > Number(m.max_per_call)) return refuse(`price ${microToUsd(micro)} exceeds the mandate's per-call cap ${microToUsd(Number(m.max_per_call))}`);
    if (this.maxPerCallMicro !== null && micro > this.maxPerCallMicro) return refuse(`price ${microToUsd(micro)} exceeds the client cap ${microToUsd(this.maxPerCallMicro)}`);
    const key = `${m.id}:${windowKey(m, new Date())}`;
    if ((this.x402Spent[key] ?? 0) + micro > Number(m.budget)) return refuse(`price ${microToUsd(micro)} would pass the mandate budget (x402 spend so far ${microToUsd(this.x402Spent[key] ?? 0)})`);
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
    this.x402Spent[key] = (this.x402Spent[key] ?? 0) + micro;
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
