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
import type { Mandate } from './mandate.js';
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
}

export class TabClient {
  private maxPerCallMicro: number | null;
  private accepts: string;
  private receiptKeys = new Map<string, string | null>();

  constructor(private opts: TabClientOptions) {
    this.maxPerCallMicro = opts.maxPerCallUsd != null ? usdToMicro(opts.maxPerCallUsd) : null;
    this.accepts = opts.currency ?? 'USD';
    if (opts.mandate.agent !== opts.agent.publicKey) {
      throw new Error('mandate is not for this agent key');
    }
  }

  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const first = await doFetch(url, init);
    if (first.status !== 402) return first;
    const chal = parseChallengeHeader(first.headers.get('www-authenticate'));
    if (!chal) return first;

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
