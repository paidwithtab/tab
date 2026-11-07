// 3.1: hosted listings. A seller with no server of their own signs a listing (their API's
// URL, routes and prices) and posts it to a gateway; the gateway serves it under
// /s/<slug>/, lists it in discovery (so the catalog finds it), and pays the seller's own
// wallet for every call: their ledger wallet, or on an evm gateway the 0x address they name.
// An MCP server can be listed the same way: each tool becomes a route, and the gateway
// makes the JSON-RPC call for the buyer.

import { canonicalJson, usdToMicro } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';
import { isPublicAddress } from './net.js';
import { isIP } from 'node:net';

export const LISTING_VERSION = 'tab/0';
export const LISTING_PATH = '/.well-known/tab/listings';
/** Hosted listings live under this prefix: /s/<slug>/... */
export const LISTING_PREFIX = '/s/';

export interface ListingRoute {
  method: string;
  path: string;
  price: string;
  description?: string;
  /** An MCP tool this route calls; the buyer's body is the tool's arguments. */
  mcp_tool?: string;
  /** The tool's JSON Schema for its arguments, shown to buyers. */
  input_schema?: Record<string, unknown>;
  /** 3.2: calls each buyer gets free per day before paying (counted per agent and per address). */
  free_per_day?: number;
}

export interface Listing {
  ver: string;
  kind: 'listing';
  realm: string; // the gateway this listing is for; a signed listing cannot be replayed at another
  seller: string; // the seller's wallet id (Ed25519 public key): signs the listing, paid on a ledger gateway
  slug: string;
  name: string;
  description?: string;
  upstream: string;
  mcp?: boolean; // the upstream is an MCP server (JSON-RPC over HTTP); routes name its tools
  routes: ListingRoute[];
  evm_payout?: string; // 0x address paid on an evm gateway
  notify?: string; // 3.2: an https webhook (an ntfy.sh topic works) told of the first sale and each day's earnings
  remove?: boolean; // a signed request to take the listing down
  at: string; // ISO time; must be recent, and newer than the listing it replaces
  sig: string;
}

export const LISTING_LIMITS = {
  minPrice: '0.001',
  maxPrice: '1.00',
  maxRoutes: 50,
  perSeller: 5,
  perIpPerHour: 10,
  total: 2000,
  skewMs: 10 * 60_000,
  ratePerMinute: 300, // per listing, through this gateway: 5 a second sustained, bursts of 5
  maxFreePerDay: 100, // 3.2: free calls a route may give each buyer a day
};

export function listingMessage(l: Omit<Listing, 'sig'> | Listing): Uint8Array {
  return Buffer.from(canonicalJson({ ...l, sig: undefined }));
}

/** Sign a listing with the seller's key; `seller` is set from it. */
export function signListing(seller: KeyPair, l: Omit<Listing, 'sig' | 'seller' | 'ver' | 'kind' | 'at'> & { at?: string }): Listing {
  const body = { ...l, ver: LISTING_VERSION, kind: 'listing' as const, seller: seller.publicKey, at: l.at ?? new Date().toISOString() };
  return { ...body, sig: signBytes(seller, listingMessage(body)) };
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const PATH = /^\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)?(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*$/;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;

/** Is this a URL a gateway may forward paid calls to: https, a name or public address, no credentials. */
export function upstreamProblem(raw: string, ownRealm: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'upstream is not a URL'; }
  if (u.protocol !== 'https:') return 'upstream must be https';
  if (u.username || u.password) return 'upstream may not carry credentials';
  if (u.search || u.hash) return 'upstream may not carry a query or fragment';
  if (raw.length > 300) return 'upstream URL is too long';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) && !isPublicAddress(host)) return 'upstream must be a public address';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'upstream must be public';
  if (host === ownRealm.toLowerCase().split(':')[0]) return 'upstream may not be this gateway';
  return null;
}

/** Check a signed listing for this gateway. Returns the problem, or null when it is good. */
export function listingProblem(l: Listing, o: { realm: string; rail: 'ledger' | 'evm'; now?: Date; allowPrivate?: boolean }): string | null {
  if (!l || typeof l !== 'object') return 'not a listing';
  if (l.ver !== LISTING_VERSION || l.kind !== 'listing') return 'not a tab/0 listing';
  if (typeof l.seller !== 'string' || typeof l.sig !== 'string') return 'listing is not signed';
  if (!verifyBytes(l.seller, listingMessage(l), l.sig)) return 'listing signature does not verify';
  if (l.realm !== o.realm) return `listing is for ${l.realm}, not ${o.realm}`;
  const at = Date.parse(l.at);
  const now = (o.now ?? new Date()).getTime();
  if (!Number.isFinite(at) || Math.abs(now - at) > LISTING_LIMITS.skewMs) return 'listing time is more than 10 minutes off; sign it again';
  if (typeof l.slug !== 'string' || !SLUG.test(l.slug)) return 'slug must be 3 to 32 lowercase letters, digits and dashes';
  if (l.remove === true) return null;
  if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 60) return 'name must be 1 to 60 characters';
  if (l.description !== undefined && (typeof l.description !== 'string' || l.description.length > 300)) return 'description must be at most 300 characters';
  const up = o.allowPrivate ? (/^https?:\/\/[^/]+/.test(String(l.upstream ?? '')) ? null : 'upstream is not a URL') : upstreamProblem(String(l.upstream ?? ''), o.realm);
  if (up) return up;
  if (l.notify !== undefined) {
    const np = o.allowPrivate ? (/^https?:\/\/[^/]+/.test(String(l.notify)) ? null : 'notify is not a URL') : upstreamProblem(String(l.notify).replace(/\?.*$/, ''), o.realm);
    if (np) return np.replace('upstream', 'notify');
  }
  if (o.rail === 'evm' && !(typeof l.evm_payout === 'string' && /^0x[0-9a-fA-F]{40}$/.test(l.evm_payout))) return 'this gateway pays on chain: evm_payout must be your 0x address';
  if (!Array.isArray(l.routes) || l.routes.length === 0) return 'a listing needs at least one route';
  if (l.routes.length > LISTING_LIMITS.maxRoutes) return `at most ${LISTING_LIMITS.maxRoutes} routes`;
  const min = usdToMicro(LISTING_LIMITS.minPrice);
  const max = usdToMicro(LISTING_LIMITS.maxPrice);
  const seen = new Set<string>();
  for (const r of l.routes) {
    if (!r || typeof r !== 'object') return 'each route must be an object';
    const method = String(r.method ?? '').toUpperCase();
    if (!METHODS.has(method)) return `route method must be one of ${[...METHODS].join(', ')}`;
    if (typeof r.path !== 'string' || r.path.length > 120 || !PATH.test(r.path) || r.path.split('/').some((seg) => seg === '.' || seg === '..')) return `route path ${JSON.stringify(r.path)} must look like /forecast or /items/:id`;
    let micro: number;
    try { micro = usdToMicro(String(r.price)); } catch { return `route ${r.path}: price is not an amount`; }
    if (micro < min || micro > max) return `route ${r.path}: price must be between ${LISTING_LIMITS.minPrice} and ${LISTING_LIMITS.maxPrice}`;
    if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > 500)) return `route ${r.path}: description must be at most 500 characters`;
    if (r.free_per_day !== undefined && !(Number.isInteger(r.free_per_day) && r.free_per_day >= 1 && r.free_per_day <= LISTING_LIMITS.maxFreePerDay)) return `route ${r.path}: free_per_day must be 1 to ${LISTING_LIMITS.maxFreePerDay}`;
    if (l.mcp) {
      if (method !== 'POST' || typeof r.mcp_tool !== 'string' || !TOOL.test(r.mcp_tool)) return 'an MCP listing has one POST route per tool, each naming its mcp_tool';
      if (r.input_schema !== undefined && (typeof r.input_schema !== 'object' || r.input_schema === null || JSON.stringify(r.input_schema).length > 8000)) return `tool ${r.mcp_tool}: input_schema must be a JSON object under 8 KB`;
    } else if (r.mcp_tool !== undefined) return 'mcp_tool is only for an MCP listing (mcp: true)';
    const key = `${method} ${r.path}`;
    if (seen.has(key)) return `route ${key} is listed twice`;
    seen.add(key);
  }
  return null;
}

/** The routes a hosted MCP listing has for its tools: POST /tools/<name>. */
export function mcpToolPath(tool: string): string {
  return `/tools/${tool}`;
}
