// 3.2: card top-ups on a ledger gateway, through Stripe Checkout. The gateway opens a Checkout
// Session for a wallet and an amount; Stripe sends the person to its own payment page; when the
// payment completes, Stripe posts a signed event to the gateway's webhook and the wallet is
// credited once. No card data touches the gateway. Off unless the operator sets both keys.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StripeConfig {
  secretKey: string; // sk_live_... or sk_test_...
  webhookSecret: string; // whsec_...
  api?: string; // default https://api.stripe.com, tests point it at a fake
  successUrl?: string; // where the person lands after paying; {TOPUP} is replaced with the top-up id
  cancelUrl?: string;
}

export const TOPUP_LIMITS = { minUsd: 1, maxUsd: 100, perIpPerHour: 10, toleranceS: 300 };

/** Open a Checkout Session for `cents` that credits `wallet`; returns Stripe's session id and payment page. */
export async function createCheckout(
  cfg: StripeConfig, send: typeof fetch,
  o: { topupId: string; wallet: string; cents: number; realm: string; origin: string },
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(o.cents),
    'line_items[0][price_data][product_data][name]': `tab credit at ${o.realm}`,
    'line_items[0][price_data][product_data][description]': `Credit for agent payments, wallet ${o.wallet.slice(0, 12)}`,
    client_reference_id: o.topupId,
    'metadata[wallet]': o.wallet,
    'metadata[realm]': o.realm,
    'metadata[topup]': o.topupId,
    success_url: (cfg.successUrl ?? `${o.origin}/.well-known/tab/topup/{TOPUP}?paid=1`).replace('{TOPUP}', o.topupId),
    cancel_url: (cfg.cancelUrl ?? `${o.origin}/`).replace('{TOPUP}', o.topupId),
  });
  const r = await send(`${(cfg.api ?? 'https://api.stripe.com').replace(/\/$/, '')}/v1/checkout/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': o.topupId },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const doc = (await r.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!r.ok || typeof doc.id !== 'string' || typeof doc.url !== 'string') throw new Error(doc.error?.message ?? `Stripe answered HTTP ${r.status}`);
  return { id: doc.id, url: doc.url };
}

/**
 * Check a Stripe-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of "t.payload">) against the
 * webhook secret, within the tolerance. Returns the parsed event or null.
 */
export function verifyWebhook(secret: string, header: string | undefined, payload: Buffer, now = Date.now()): { type: string; data: { object: Record<string, unknown> } } | null {
  if (!header) return null;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) return null;
  if (Math.abs(now / 1000 - Number(t)) > TOPUP_LIMITS.toleranceS) return null;
  const want = createHmac('sha256', secret).update(`${t}.`).update(payload).digest();
  const match = sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/.test(s ?? '')) return false;
    const got = Buffer.from(s, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!match) return null;
  try {
    const ev = JSON.parse(payload.toString('utf8'));
    return ev && typeof ev.type === 'string' && ev.data && typeof ev.data.object === 'object' ? ev : null;
  } catch {
    return null;
  }
}

/** Sign a payload the way Stripe does, for tests and local fakes. */
export function signWebhook(secret: string, payload: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
