// The catalog: discovery for buyers, a route search, receipt aggregation, an
// optional "try it" agent that pays for catalogued routes, and the front end.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { usdToMicro, microToUsd, type Receipt } from './protocol.js';
import { verifyMandate, mandateExpired, realmAllowed, type Mandate } from './mandate.js';
import type { KeyPair } from './keys.js';
import { TabClient, PaymentRefused, receiptOf } from './client.js';
import type { CatalogStore, GatewayRow } from './store.js';
import { renderDocsPage, DOC_GROUPS } from './markdown.js';
import { guardedFetch, isPublicAddress } from './net.js';

// the package version, for /v1/health; src/ and dist/src/ sit at different depths
const VERSION_PKG = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const v = (JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string });
      if (v.name === 'paidwithtab' && v.version) return v.version;
    } catch { /* try the next */ }
  }
  return 'unknown';
})();

export interface CatalogOptions {
  store: CatalogStore;
  tryAgent?: KeyPair;
  tryMandate?: Mandate;
  tryMaxPerCallUsd?: string;
  /**
   * Accept announcements of origins on private/loopback/link-local addresses.
   * Off by default: a hostile announce must not be able to point the catalog
   * at internal infrastructure or cloud metadata services (SSRF).
   */
  allowPrivateOrigins?: boolean;
  log?: (msg: string) => void;
}

const MAX_DISCOVERY_BYTES = 16_000_000; // about 40,000 routes

/**
 * SSRF gate for announced origins: the hostname, or every address it resolves to, must be
 * global unicast (src/net.ts). The fetches themselves go through guardedFetch, which checks
 * again at connect time, so DNS rebinding between this check and the fetch gets nowhere.
 */
export async function originIsPublic(origin: string): Promise<{ ok: boolean; reason?: string }> {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (isIP(host)) {
    return isPublicAddress(host) ? { ok: true } : { ok: false, reason: `${host} is not a public address` };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `${host} is not a public hostname` };
  }
  try {
    const addrs = await lookup(host, { all: true });
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) return { ok: false, reason: `${host} resolves to ${bad.address}, which is not public` };
    return { ok: true };
  } catch {
    return { ok: false, reason: `cannot resolve ${host}` };
  }
}

interface CatalogRoute {
  origin: string;
  realm: string;
  rail: string;
  service: string;
  service_description: string;
  method: string;
  path: string;
  url: string;
  price: string; // in `currency`
  price_micro: number;
  currency: string; // "USD", or the token the gateway charges in
  description: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body, null, 1));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function findUi(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../web', '../../web']) {
    const p = join(here, rel);
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return null;
}

// static files under web/: clean URLs for the pages (/product -> product.html), plus assets (images, the demo video and
// the site's fonts) and the three markdown documents at the repo root, which the docs page links to
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg',
  woff2: 'font/woff2', mp4: 'video/mp4', md: 'text/markdown; charset=utf-8',
};
const DOCS = new Set(['README.md', 'SPEC.md', 'DEPLOY.md']);
/** Where the site sends /app: the company dashboard's own origin. */
const APP_URL = process.env.TAB_APP_URL || 'https://app.paidwithtab.com';
function staticFile(uiDir: string, path: string): [file: string, type: string] | null {
  if (path === '/' || path === '/index.html') {
    // the landing page when the operator ships one; otherwise the catalog app is the front door
    const landing = join(uiDir, 'index.html');
    return [existsSync(landing) ? landing : join(uiDir, 'catalog.html'), TYPES.html];
  }
  const m = /^\/([a-z0-9-]+)(?:\.(html|css|png|jpg|woff2|mp4))?$/.exec(path);
  if (m) {
    const ext = m[2] ?? 'html';
    const file = join(uiDir, `${m[1]}.${ext}`);
    return existsSync(file) ? [file, TYPES[ext]] : null;
  }
  const name = path.slice(1);
  if (DOCS.has(name)) {
    const file = join(uiDir, '..', name);
    return existsSync(file) ? [file, TYPES.md] : null;
  }
  return null;
}

// A gateway that fails a refresh keeps its last good routes in search this long, so one
// timeout or a catalog older than its gateways does not empty the catalog. Calls to a
// gateway that is really down still fail at the gateway, before any payment.
export const STALE_MS = 6 * 3_600_000;

/** Is this row's payload still served: fetched fine, or failing for less than STALE_MS? */
export function servable(row: GatewayRow, now = Date.now()): boolean {
  if (!row.payload) return false;
  if (row.ok) return true;
  return !!row.last_ok_at && now - Date.parse(row.last_ok_at) < STALE_MS;
}

function routesOf(row: GatewayRow): CatalogRoute[] {
  if (!servable(row)) return [];
  const doc = row.payload as any;
  const out: CatalogRoute[] = [];
  for (const s of doc.services ?? []) {
    for (const r of s.routes ?? []) {
      let priceMicro = 0;
      try {
        priceMicro = usdToMicro(String(r.price));
      } catch {
        continue;
      }
      // a prefix like ":6379/x" or ".evil.example" would point the route at another host or port
      const prefix = String(s.prefix ?? ''), path = String(r.path ?? '');
      if ((prefix !== '' && !prefix.startsWith('/')) || !path.startsWith('/')) continue;
      let url: URL;
      try { url = new URL(prefix + path, row.origin); } catch { continue; }
      if (url.origin !== new URL(row.origin).origin) continue;
      const currency = typeof doc.currency === 'string' && /^[A-Z0-9]{2,12}$/.test(doc.currency) ? doc.currency : 'USD';
      out.push({
        origin: row.origin,
        realm: String(doc.realm ?? ''),
        rail: String(doc.rail ?? 'ledger'),
        service: String(s.name ?? ''),
        service_description: String(s.description ?? ''),
        method: String(r.method ?? 'GET').toUpperCase(),
        path: String(s.prefix ?? '') + String(r.path ?? ''),
        url: row.origin.replace(/\/$/, '') + prefix + path,
        price: String(r.price),
        price_micro: priceMicro,
        currency,
        description: String(r.description ?? ''),
      });
    }
  }
  return out;
}

export function createCatalog(opts: CatalogOptions): Server {
  const { store } = opts;
  const log = opts.log ?? (() => {});
  const uiPath = findUi();
  // every fetch to an announced origin: public addresses only, checked at connect time, no redirects
  const egress = (maxBytes: number, timeoutMs: number): typeof fetch =>
    opts.allowPrivateOrigins ? fetch : guardedFetch({ maxBytes, timeoutMs });
  const tryClient =
    opts.tryAgent && opts.tryMandate
      ? new TabClient({
          agent: opts.tryAgent,
          mandate: opts.tryMandate,
          maxPerCallUsd: opts.tryMaxPerCallUsd ?? '0.05',
          fetch: egress(1_000_000, 20_000),
        })
      : null;

  async function fetchGateway(origin: string): Promise<GatewayRow> {
    const now = new Date().toISOString();
    try {
      if (!opts.allowPrivateOrigins) {
        const pub = await originIsPublic(origin);
        if (!pub.ok) throw new Error(`refused: ${pub.reason}`);
      }
      const res = await egress(MAX_DISCOVERY_BYTES, 10_000)(origin.replace(/\/$/, '') + '/.well-known/tab', {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_DISCOVERY_BYTES) throw new Error('discovery document too large');
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (typeof doc.realm !== 'string' || !Array.isArray(doc.services)) {
        throw new Error('not a tab discovery document');
      }
      return { origin, ok: true, error: null, payload: doc, fetched_at: now };
    } catch (err) {
      const message = (err as Error).message;
      // a host that now resolves somewhere private stops being served at once, stale copy or not
      return { origin, ok: false, error: message, payload: null, fetched_at: now, forget: /refused|not a public|not public/.test(message) };
    }
  }

  async function announce(origin: string): Promise<GatewayRow> {
    const row = await fetchGateway(origin);
    store.put(row);
    log(`announce ${origin}: ${row.ok ? 'ok' : `failed (${row.error})`}`);
    return row;
  }

  async function refreshAll(): Promise<number> {
    const rows = store.all();
    await Promise.all(rows.map((r) => announce(r.origin)));
    return rows.length;
  }

  const server = createServer(async (req, res) => {
    // HEAD is GET without the body (node drops it), so monitors and link checkers see real pages
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://localhost');
    const path = u.pathname;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      // the dashboard is its own origin; the site only points at it (tab OS in web/os.html needs the company API, which only that origin has)
      if (method === 'GET' && (path === '/app' || path === '/app.html')) {
        res.writeHead(302, { location: APP_URL });
        res.end();
        return;
      }

      // the project docs, all rendered through the same shell so none opens as raw markdown
      const RENDERED: Record<string, { file: string; opts: Parameters<typeof renderDocsPage>[1] }> = {
        '/docs': { file: 'README.md', opts: { active: 'docs', groups: DOC_GROUPS } },
        '/docs.html': { file: 'README.md', opts: { active: 'docs', groups: DOC_GROUPS } },
        '/protocol': { file: 'SPEC.md', opts: { active: 'protocol', title: 'Specification' } },
        '/deployment': { file: 'DEPLOY.md', opts: { active: 'deployment', title: 'Deployment' } },
        '/company-guide': { file: 'docs/company.md', opts: { active: 'docs', title: 'Companies' } },
      };
      if (method === 'GET' && uiPath && RENDERED[path]) {
        const { file, opts } = RENDERED[path];
        const md = join(uiPath, '..', file);
        if (existsSync(md)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
          res.end(renderDocsPage(readFileSync(md, 'utf8'), opts));
          return;
        }
      }

      // a person clicking /SPEC.md etc should see the rendered doc, never raw markdown; ?raw=1 keeps the source
      const MD_REDIRECT: Record<string, string> = { '/README.md': '/docs', '/SPEC.md': '/protocol', '/DEPLOY.md': '/deployment', '/docs/company.md': '/company-guide' };
      if (method === 'GET' && MD_REDIRECT[path] && u.searchParams.get('raw') !== '1') {
        res.writeHead(301, { location: MD_REDIRECT[path] });
        res.end();
        return;
      }

      const page = method === 'GET' && !path.startsWith('/v1/') ? (uiPath ? staticFile(uiPath, path) : null) : null;
      if (page) {
        const [file, type] = page;
        const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'public, max-age=300' };
        if (type.startsWith('video/')) {
          // video players ask for byte ranges (Safari refuses to play without them), so the demo is streamed
          const size = statSync(file).size;
          const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
          headers['accept-ranges'] = 'bytes';
          if (range && (range[1] || range[2])) {
            const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            if (start >= size || start > end) {
              res.writeHead(416, { 'content-range': `bytes */${size}` });
              res.end();
              return;
            }
            res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
            createReadStream(file, { start, end }).pipe(res);
            return;
          }
          res.writeHead(200, { ...headers, 'content-length': String(size) });
          createReadStream(file).pipe(res);
          return;
        }
        res.writeHead(200, headers);
        res.end(readFileSync(file));
        return;
      }
      if (method === 'GET' && !uiPath && (path === '/' || path === '/catalog')) {
        sendJson(res, 500, { error: 'ui not found: keep web/ next to dist/' });
        return;
      }

      // for uptime monitors: 503 when search would find nothing or a gateway that used to work is failing
      if (method === 'GET' && path === '/v1/health') {
        // origins that never once served a document (junk announces) do not count against health
        const rows = store.all().filter((r) => r.last_ok_at || r.ok);
        const gateways = rows.map((r) => ({
          origin: r.origin, ok: r.ok, error: r.error, fetched_at: r.fetched_at, last_ok_at: r.last_ok_at ?? null,
          routes: routesOf(r).length,
        }));
        const routes = gateways.reduce((n, g) => n + g.routes, 0);
        const ok = routes > 0 && gateways.every((g) => g.ok);
        sendJson(res, ok ? 200 : 503, { ok, version: VERSION_PKG, routes, gateways });
        return;
      }

      if (method === 'GET' && path === '/v1/catalog.json') {
        // ?services=0 leaves out each gateway's service list, so a page that only needs counts
        // does not download every route of every gateway
        const withServices = u.searchParams.get('services') !== '0';
        sendJson(res, 200, {
          gateways: store.all().map((r) => {
            const { services, ...rest } = (r.payload ?? {}) as { services?: Array<{ routes?: unknown[] }> };
            const list = Array.isArray(services) ? services : [];
            // the gateway's own fields first, so it cannot overwrite the catalog's (origin, ok, ...)
            return {
              ...rest,
              origin: r.origin,
              ok: r.ok,
              error: r.error,
              fetched_at: r.fetched_at,
              last_ok_at: r.last_ok_at ?? null,
              ...(!r.ok && servable(r) ? { stale: true } : {}),
              service_count: list.length,
              route_count: list.reduce((n, s) => n + (Array.isArray(s.routes) ? s.routes.length : 0), 0),
              ...(withServices && r.payload ? { services } : {}),
            };
          }),
        });
        return;
      }

      if (method === 'GET' && path === '/v1/search') {
        const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
        const maxPrice = u.searchParams.get('max_price');
        let maxMicro: number | null = null;
        if (maxPrice) {
          try { maxMicro = usdToMicro(maxPrice); } catch { sendJson(res, 400, { error: 'max_price must be an amount like 0.01' }); return; }
        }
        // a price ceiling only means something in one currency: USD unless the caller says otherwise
        const currency = u.searchParams.get('currency') || 'USD';
        const terms = q ? q.split(/\s+/) : [];
        // a page of results: limit defaults to 100 and caps at 1000, offset pages through the rest
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit') ?? 100) || 100, 1), 1000);
        const offset = Math.max(Number(u.searchParams.get('offset') ?? 0) || 0, 0);
        const results: Array<CatalogRoute & { score: number }> = [];
        for (const row of store.all()) {
          for (const route of routesOf(row)) {
            if (maxMicro !== null && (route.currency !== currency || route.price_micro > maxMicro)) continue;
            const routeText = `${route.method} ${route.path} ${route.description}`.toLowerCase();
            const serviceText = `${route.service} ${route.service_description} ${route.realm}`.toLowerCase();
            // every term must appear somewhere; terms found in the route itself and in the
            // service name rank higher, so "bitcoin fees" puts /bitcoin/v1/fees first
            let score = 0;
            if (terms.length === 0) score = 1;
            else if (terms.every((t) => (routeText + ' ' + serviceText).includes(t))) {
              for (const t of terms) {
                if (routeText.includes(t)) score += 2;
                if (route.service.toLowerCase().includes(t)) score += 3;
                else if (serviceText.includes(t)) score += 1;
              }
            }
            if (score > 0) results.push({ ...route, score });
          }
        }
        results.sort((a, b) => b.score - a.score || a.price_micro - b.price_micro);
        sendJson(res, 200, {
          total: results.length,
          offset,
          results: results.slice(offset, offset + limit).map(({ score, ...r }) => r),
        });
        return;
      }

      if (method === 'POST' && path === '/v1/announce') {
        const body = await readJson(req);
        if (typeof body.origin !== 'string' || !/^https?:\/\//.test(body.origin)) {
          sendJson(res, 400, { error: 'origin must be an http(s) URL' });
          return;
        }
        const origin = body.origin.replace(/\/$/, '');
        if (!opts.allowPrivateOrigins) {
          const pub = await originIsPublic(origin);
          if (!pub.ok) {
            log(`announce ${origin}: refused (${pub.reason})`);
            sendJson(res, 403, { error: `refused: ${pub.reason}` });
            return;
          }
        }
        const row = await announce(origin);
        sendJson(res, 200, { origin: row.origin, ok: row.ok, error: row.error });
        return;
      }

      if (method === 'POST' && path === '/v1/refresh') {
        const n = await refreshAll();
        sendJson(res, 200, { refreshed: n });
        return;
      }

      if (method === 'POST' && path === '/v1/mandate/verify') {
        const body = await readJson(req);
        const m = body.mandate as Mandate;
        const v = verifyMandate(m);
        if (!v.ok) {
          sendJson(res, 200, { ok: false, error: v.error });
          return;
        }
        const expired = mandateExpired(m);
        const realmOk = typeof body.realm === 'string' ? realmAllowed(m, body.realm) : null;
        sendJson(res, 200, {
          ok: !expired && realmOk !== false,
          error: expired ? 'mandate expired' : realmOk === false ? `realm ${body.realm} not allowed` : null,
          mandate: {
            id: m.id, owner: m.owner, agent: m.agent,
            budget_usd: microToUsd(Number(m.budget)), window: m.window,
            max_per_call_usd: m.max_per_call === null ? null : microToUsd(Number(m.max_per_call)),
            allow: m.allow, issued_at: m.issued_at, expires_at: m.expires_at,
          },
        });
        return;
      }

      if (method === 'GET' && path === '/v1/wallet') {
        const origin = u.searchParams.get('origin');
        const wallet = u.searchParams.get('wallet');
        if (!origin || !wallet) {
          sendJson(res, 400, { error: 'origin and wallet are required' });
          return;
        }
        // never a free-form fetch: only origins already in the catalog
        if (!store.all().some((r) => r.origin === origin.replace(/\/$/, ''))) {
          sendJson(res, 403, { error: 'origin is not a catalogued gateway' });
          return;
        }
        try {
          const r = await egress(100_000, 5_000)(
            origin.replace(/\/$/, '') + '/.well-known/tab/wallet/' + encodeURIComponent(wallet),
            { signal: AbortSignal.timeout(5_000) },
          );
          sendJson(res, r.status, await r.json());
        } catch (err) {
          sendJson(res, 502, { error: (err as Error).message });
        }
        return;
      }

      if (method === 'GET' && path === '/v1/receipts') {
        const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') ?? 50) || 50));
        const all: Array<Receipt & { origin: string }> = [];
        await Promise.all(
          store.all().filter((r) => r.ok).map(async (row) => {
            try {
              const r = await egress(2_000_000, 5_000)(
                row.origin.replace(/\/$/, '') + `/.well-known/tab/receipts?limit=${limit}`,
                { signal: AbortSignal.timeout(5_000) },
              );
              if (!r.ok) return;
              const doc = (await r.json()) as { receipts?: Receipt[] };
              // a gateway writes these; only well-formed receipts are passed on to the page
              for (const rec of (doc.receipts ?? []).slice(0, limit)) if (receiptLooksRight(rec)) all.push({ ...rec, origin: row.origin });
            } catch {
              /* gateway without public receipts, or down */
            }
          }),
        );
        all.sort((a, b) => (a.at < b.at ? 1 : -1));
        sendJson(res, 200, { receipts: all.slice(0, limit) });
        return;
      }

      if (method === 'GET' && path === '/v1/try') {
        if (!tryClient || !opts.tryMandate) {
          sendJson(res, 200, { enabled: false });
          return;
        }
        sendJson(res, 200, {
          enabled: true,
          agent: opts.tryAgent!.publicKey,
          max_per_call_usd: opts.tryMaxPerCallUsd ?? '0.05',
          budget_usd: microToUsd(Number(opts.tryMandate.budget)),
          window: opts.tryMandate.window,
        });
        return;
      }

      if (method === 'POST' && path === '/v1/try') {
        if (!tryClient) {
          sendJson(res, 403, { error: 'no try-it agent configured' });
          return;
        }
        const body = await readJson(req);
        const url = String(body.url ?? '');
        const m = String(body.method ?? 'GET').toUpperCase();
        const known = store
          .all()
          .flatMap(routesOf)
          .some((r) => r.method === m && urlMatchesRoute(url, r.url));
        if (!known) {
          sendJson(res, 403, { error: 'url is not a catalogued route' });
          return;
        }
        try {
          const init = {
            method: m,
            headers: body.body != null ? { 'content-type': 'application/json' } : undefined,
            body: body.body != null ? (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)) : undefined,
          };
          const r = await tryClient.fetch(url, init);
          const bytes = new Uint8Array(await r.arrayBuffer());
          const check = await tryClient.verify(url, r, bytes, init);
          sendJson(res, 200, {
            status: r.status,
            receipt: receiptOf(r),
            receipt_verified: check ? check.ok : null,
            body: new TextDecoder().decode(bytes).slice(0, 65_536),
          });
        } catch (err) {
          if (err instanceof PaymentRefused) {
            sendJson(res, 200, { status: 0, error: `refused: ${err.reason}` });
          } else {
            sendJson(res, 502, { error: (err as Error).message });
          }
        }
        return;
      }

      sendJson(res, 404, { error: `no such endpoint: ${method} ${path}` });
    } catch (err) {
      log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  // re-fetch every stored gateway every 60 s
  const timer = setInterval(() => {
    refreshAll().catch(() => {});
  }, 60_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  (server as any).announce = announce; // used by --seed and tests
  return server;
}

/** Does a concrete URL match a catalogued route URL that may contain :params? */
function urlMatchesRoute(url: string, routeUrl: string): boolean {
  if (url === routeUrl) return true;
  let a: URL, b: URL;
  try {
    a = new URL(url);
    b = new URL(routeUrl);
  } catch {
    return false;
  }
  if (a.origin !== b.origin) return false;
  const pa = a.pathname.split('/');
  const pb = b.pathname.split('/');
  if (pa.length !== pb.length) return false;
  return pb.every((seg, i) => (seg.startsWith(':') && seg.length > 1 ? pa[i].length > 0 : seg === pa[i]));
}

/** Receipts relayed from gateways to the catalog page: shapes only, so a hostile gateway cannot smuggle markup or reorder the list. */
function receiptLooksRight(r: Receipt): boolean {
  return !!r && typeof r === 'object' && typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id)
    && typeof r.realm === 'string' && r.realm.length <= 253 && typeof r.resource === 'string' && r.resource.length <= 2048
    && /^\d{1,15}$/.test(String(r.amount)) && (r.currency === undefined || /^[A-Z0-9]{2,12}$/.test(String(r.currency)))
    && typeof r.ref === 'string' && /^(ledger|evm):[A-Za-z0-9_x-]{1,80}$/.test(r.ref)
    && typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) && Date.parse(r.at) <= Date.now() + 300_000;
}
