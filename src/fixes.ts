// 3.3: what to do about a refusal. Every problem a buyer can hit, from the gateway (a problem code)
// or from this client before it pays (a PaymentRefused reason), mapped to one sentence that names
// the command that fixes it. tab fetch prints it, tab_fetch returns it as `fix`, tab doctor uses it.

export interface Fix {
  /** The problem, in a few words. */
  what: string;
  /** What to do about it, naming the command. */
  fix: string;
}

const BY_CODE: Record<string, Fix> = {
  'mandate-exceeded': {
    what: 'the mandate does not cover this call',
    fix: 'the price is above the per-call cap or the budget is spent. tab doctor (or the tab_limits tool) shows what is left; a daily budget resets at midnight UTC; the owner can issue a larger one with tab mandate issue --budget 5.00 --max-per-call 0.10, or tab init again for the default.',
  },
  'mandate-denied': {
    what: 'the mandate does not allow this gateway, route or hour',
    fix: 'the realm is not in the mandate\'s allow list, or the route or time is outside its paths or hours. The owner issues one that allows it: tab mandate issue --allow <realm> (or --allow "*").',
  },
  'mandate-invalid': {
    what: 'the mandate is expired or malformed',
    fix: 'tab init issues a fresh mandate from the same keys; tab doctor shows when the current one expires.',
  },
  'mandate-revoked': {
    what: 'the owner revoked this mandate',
    fix: 'ask the owner for a new mandate (tab mandate issue, or tab init on the owner\'s machine).',
  },
  'insufficient-funds': {
    what: 'the owner wallet is empty on this gateway',
    fix: 'add credits with a card: tab topup 5; or claim starter credits once with tab init. On a chain gateway, fund the owner address with USDG and run tab evm approve.',
  },
  'approval-required': {
    what: 'the payment is above the approval threshold',
    fix: 'the owner approves with tab mandate approve --request <file>, then the same request is sent again.',
  },
  'payment-expired': {
    what: 'the price quote expired before it was paid, or the payment did not settle',
    fix: 'nothing was charged; send the request again.',
  },
  'invalid-challenge': {
    what: 'the price quote was altered or is from another gateway',
    fix: 'nothing was charged; send the request again. If it keeps happening, the gateway or a proxy in between is misbehaving.',
  },
  'verification-failed': {
    what: 'the gateway could not verify the payment',
    fix: 'nothing was charged. Check the machine clock and that the agent key and mandate belong together: tab doctor.',
  },
  'malformed-credential': {
    what: 'the payment header could not be read',
    fix: 'nothing was charged; use a current tab client (tab version, then update from the GitHub release).',
  },
  'upstream-failed': {
    what: 'the seller\'s API failed',
    fix: 'nothing was charged. tab_search finds other routes that do the same job; tab_fetch lists alternatives when a seller fails.',
  },
  'rate-limited': {
    what: 'too many requests from this address or agent',
    fix: 'wait a minute and try again.',
  },
  'not-found': { what: 'nothing is priced at this path', fix: 'tab_discover (or curl <origin>/.well-known/tab) lists the routes this gateway sells.' },
  'bad-request': { what: 'the gateway refused the request as sent', fix: 'check the method, path and body against the route\'s description in tab_discover.' },
  'channel-invalid': { what: 'the payment channel is closed, expired or unknown', fix: 'the next call pays per call; open a new channel with tab channel open if you want one.' },
  'channel-exhausted': { what: 'the payment channel\'s deposit is used up', fix: 'close it (tab channel close) and open a new one, or pay per call.' },
};

const BY_REASON: Array<[RegExp, string]> = [
  [/not in the mandate's allow list/, 'mandate-denied'],
  [/not in the mandate's paths|outside the mandate's hours|hours/, 'mandate-denied'],
  [/per-call cap|exceeds the mandate budget|would pass the .*budget/, 'mandate-exceeded'],
  [/mandate has expired/, 'mandate-invalid'],
];

const CLIENT: Array<[RegExp, Fix]> = [
  [/token this client does not know/, { what: 'the gateway charges in a token this client has not pinned', fix: 'pin it with TAB_EVM_TOKENS=<address>:<decimals>:<symbol>, or use a gateway that charges in USD.' }],
  [/no evm_owner/, { what: 'the mandate has no chain owner address', fix: 'tab init (or tab mandate issue) writes one; a mandate issued before 0.5 needs re-issuing for chain gateways.' }],
  [/could not report the agent nonce/, { what: 'the chain gateway could not read the agent\'s nonce', fix: 'the gateway\'s RPC is down; try again shortly. Nothing was signed.' }],
  [/does not take pay on delivery/, { what: 'this route does not offer pay on delivery', fix: 'call it without escrow.' }],
  [/challenge claims realm .* but came from/, { what: 'the price quote names a different gateway than the one asked', fix: 'nothing was signed. Something between you and the gateway is rewriting responses; do not pay through it.' }],
];

/** The fix for a gateway problem code, or null when there is nothing to add. */
export function fixForCode(code: string | null | undefined): Fix | null {
  return code ? BY_CODE[code] ?? null : null;
}

/** The fix for a refusal this client made before paying. */
export function fixForRefusal(reason: string): Fix | null {
  for (const [re, code] of BY_REASON) if (re.test(reason)) return BY_CODE[code];
  for (const [re, fix] of CLIENT) if (re.test(reason)) return fix;
  return null;
}

/** The problem code in a problem+json body, if it is one. */
export function problemCodeOf(contentType: string | null, body: string): string | null {
  if (!/problem\+json|application\/json/.test(contentType ?? '')) return null;
  try {
    const doc = JSON.parse(body) as { type?: string; code?: string };
    const t = doc.code ?? doc.type ?? '';
    const m = /([a-z]+(?:-[a-z]+)+)$/.exec(String(t));
    return m && BY_CODE[m[1]] ? m[1] : null;
  } catch {
    return null;
  }
}
