// 3.2: x402 sellers in the tab catalog. Most paid APIs for agents today speak x402 and take
// USDC on Base; a tab agent already pays them from its own address, within its mandate
// (src/client.ts). This file reads them into the catalog so tab_search finds them beside
// tab gateways: from a public x402 discovery list (the Bazaar format: items with resource,
// accepts, description and 30-day usage), and from a seller's own /.well-known/x402.

import { KNOWN_EVM_TOKENS } from './client.js';
import { chainIdOf, decodeX402, type X402PaymentRequired, type X402Requirements } from './x402.js';

/** The public x402 discovery list (Coinbase's Bazaar). */
export const BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';

/** An x402 route as the catalog keeps it. */
export interface X402Route {
  url: string;
  method: string;
  description: string;
  service: string;
  price_micro: number; // USD micro units
  network: string; // CAIP-2, "eip155:8453"
  asset: string;
  pay_to: string;
  tags?: string[];
  calls_30d?: number;
  payers_30d?: number;
  last_called?: string;
}

const MAX_PRICE_MICRO = 1_000_000; // $1 a call: the catalog lists cheap calls an agent may make on its own
// test networks: their dollars are not dollars, so the catalog does not list them beside real prices
const TESTNETS = new Set([84532, 46630, 11155111, 421614, 11155420]);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The first payment option a tab client can pay: exact, EIP-3009, a known USD token. Price in USD micro units. */
export function payableOption(accepts: unknown): { req: X402Requirements; micro: number } | null {
  if (!Array.isArray(accepts)) return null;
  for (const r of accepts as X402Requirements[]) {
    if (!r || r.scheme !== 'exact') continue;
    const chainId = chainIdOf(String(r.network ?? ''));
    const method = r.extra?.assetTransferMethod;
    if (chainId === null || TESTNETS.has(chainId) || (method !== undefined && method !== 'eip3009')) continue;
    if (typeof r.extra?.name !== 'string' || typeof r.extra?.version !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(String(r.payTo))) continue;
    const pin = KNOWN_EVM_TOKENS.find((t) => t.chainId === chainId && t.token === String(r.asset).toLowerCase() && t.currency === 'USD');
    // version 1 offers named the price maxAmountRequired
    const amount = String(r.amount ?? (r as { maxAmountRequired?: string }).maxAmountRequired ?? '');
    if (!pin || !/^\d{1,30}$/.test(amount)) continue;
    const base = BigInt(amount);
    const scale = 10n ** BigInt(Math.max(pin.decimals - 6, 0));
    const micro = Number((base + scale - 1n) / scale);
    if (!Number.isSafeInteger(micro) || micro <= 0 || micro > MAX_PRICE_MICRO) continue;
    return { req: r, micro };
  }
  return null;
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function publicHttpsUrl(raw: unknown, allowLocal = false): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1') return u.toString(); // tests
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** One Bazaar item as an X402Route, or null when a tab client could not pay it or it is not a plain HTTP call. */
export function routeOfBazaarItem(it: any): X402Route | null {
  if (!it || typeof it !== 'object' || (it.type !== undefined && it.type !== 'http')) return null;
  const url = publicHttpsUrl(it.resource);
  if (!url) return null;
  const pay = payableOption(it.accepts);
  if (!pay) return null;
  const method = String(it.extensions?.bazaar?.info?.input?.method ?? it.accepts?.[0]?.extra?.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) return null;
  const q = it.quality && typeof it.quality === 'object' ? it.quality : {};
  return {
    url, method,
    description: clean(it.description, 300) || clean(it.serviceName, 80) || new URL(url).pathname,
    service: clean(it.serviceName, 60) || new URL(url).hostname,
    price_micro: pay.micro, network: String(pay.req.network), asset: String(pay.req.asset).toLowerCase(), pay_to: String(pay.req.payTo).toLowerCase(),
    ...(Array.isArray(it.tags) ? { tags: it.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8).map((t: string) => clean(t, 30)) } : {}),
    ...(Number.isSafeInteger(q.l30DaysTotalCalls) ? { calls_30d: q.l30DaysTotalCalls } : {}),
    ...(Number.isSafeInteger(q.l30DaysUniquePayers) ? { payers_30d: q.l30DaysUniquePayers } : {}),
    ...(typeof q.lastCalledAt === 'string' && Number.isFinite(Date.parse(q.lastCalledAt)) ? { last_called: q.lastCalledAt } : {}),
  };
}

/** Read a Bazaar-format discovery list, page by page, up to `max` payable routes. */
export async function importBazaar(listUrl: string, send: typeof fetch, max = 40_000, pageSize = 1000): Promise<X402Route[]> {
  const out = new Map<string, X402Route>();
  for (let offset = 0; offset < 200_000 && out.size < max; offset += pageSize) {
    const u = new URL(listUrl);
    u.searchParams.set('limit', String(pageSize));
    u.searchParams.set('offset', String(offset));
    const r = await send(u, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${u.host} answered HTTP ${r.status} at offset ${offset}`);
    const doc = (await r.json()) as { items?: unknown[]; pagination?: { total?: number } };
    const items = Array.isArray(doc.items) ? doc.items : [];
    for (const it of items) {
      const route = routeOfBazaarItem(it);
      if (route && out.size < max) out.set(`${route.method} ${route.url}`, route);
    }
    if (items.length < pageSize || (doc.pagination?.total !== undefined && offset + pageSize >= doc.pagination.total)) break;
  }
  return [...out.values()];
}

/**
 * A seller's own /.well-known/x402: {resources: [url, ...]}. Each resource on the seller's origin is
 * asked once, unpaid, for its price (the 402 it answers with). At most `max` resources.
 */
export async function importWellKnown(origin: string, send: typeof fetch, max = 50, allowLocal = false): Promise<X402Route[]> {
  const base = new URL(origin).origin;
  const r = await send(base + '/.well-known/x402', { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!r.ok) throw new Error(`/.well-known/x402 answered HTTP ${r.status}`);
  const doc = (await r.json()) as { name?: string; description?: string; resources?: unknown[] };
  const urls = (Array.isArray(doc.resources) ? doc.resources : [])
    .map((x) => publicHttpsUrl(typeof x === 'string' ? x : (x as { url?: string })?.url, allowLocal))
    .filter((x): x is string => !!x && new URL(x).origin === base)
    .slice(0, max);
  const out: X402Route[] = [];
  for (const url of urls) {
    try {
      const probe = await send(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (probe.status !== 402) { await probe.arrayBuffer().catch(() => undefined); continue; }
      let required = decodeX402<X402PaymentRequired>(probe.headers.get('payment-required'));
      if (!required) { try { required = (await probe.json()) as X402PaymentRequired; } catch { /* no offer */ } }
      else await probe.arrayBuffer().catch(() => undefined);
      const pay = payableOption(required?.accepts);
      if (!pay) continue;
      out.push({
        url, method: 'GET',
        description: clean(required?.resource?.description, 300) || clean(doc.description, 300) || new URL(url).pathname,
        service: clean(required?.resource?.serviceName ?? doc.name, 60) || new URL(url).hostname,
        price_micro: pay.micro, network: String(pay.req.network), asset: String(pay.req.asset).toLowerCase(), pay_to: String(pay.req.payTo).toLowerCase(),
      });
    } catch { /* one resource that does not answer is skipped */ }
  }
  return out;
}

/**
 * How much to trust a route's track record, 0 to 1: tab routes by their gateway's 7-day ok rate,
 * x402 routes by recent paid use in the discovery list. Unknown is 0.7.
 */
export function reliabilityOf(r: { stats?: { calls_7d: number; ok_rate: number }; payers_30d?: number; last_called?: string }, now = Date.now()): number {
  if (r.stats && r.stats.calls_7d >= 3) return r.stats.ok_rate;
  if (r.last_called) {
    const age = now - Date.parse(r.last_called);
    if (age > 30 * 86_400_000) return 0.4;
    if ((r.payers_30d ?? 0) >= 3) return 0.95;
    return 0.8;
  }
  return 0.7;
}
