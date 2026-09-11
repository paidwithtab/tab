// The buyer side: a payment-aware fetch. On 402 it parses the challenge, signs
// a credential (and on the evm rail builds and signs the payment transaction),
// and retries exactly once.

import {
  encodeCredentialHeader,
  microToUsd,
  parseChallengeHeader,
  parseReceiptHeader,
  signCredential,
  usdToMicro,
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
  amount: string; // micro-USD
  amountUsd: string;
  resource: string;
  realm: string;
  rail: string;
}

export interface TabClientOptions {
  agent: KeyPair;
  mandate: Mandate;
  /** Client-side per-call ceiling in USD, independent of the mandate. */
  maxPerCallUsd?: string;
  /** Optional veto; amounts in micro-USD. Return false to refuse. */
  onChallenge?: (challenge: Challenge, request: ChallengeRequest) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
}

export class TabClient {
  private maxPerCallMicro: number | null;

  constructor(private opts: TabClientOptions) {
    this.maxPerCallMicro = opts.maxPerCallUsd != null ? usdToMicro(opts.maxPerCallUsd) : null;
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
    const request: ChallengeRequest = {
      amount: chal.amount,
      amountUsd: microToUsd(amount),
      resource: chal.resource,
      realm: chal.realm,
      rail: chal.rail,
    };
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
