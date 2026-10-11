// The catalog: discovery for buyers, a route search, receipt aggregation, an
// optional "try it" agent that pays for catalogued routes, and the front end.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
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

const MAX_DISCOVERY_BYTES = 1_000_000;

function isPrivateIp(ip: string): boolean {
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const low = ip.toLowerCase();
  return (
    low === '::' || low === '::1' ||
    low.startsWith('fc') || low.startsWith('fd') || // unique local
    low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb') // link-local
  );
}

/**
 * SSRF gate for announced origins. Checks the hostname (or every address it
 * resolves to) against private ranges. Note the residual DNS-rebinding window
 * between this check and the fetch; run the catalog with no reachable internal
 * services if that matters in your deployment.
 */
async function originIsPublic(origin: string): Promise<{ ok: boolean; reason?: string }> {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (isIP(host)) {
    return isPrivateIp(host) ? { ok: false, reason: `${host} is not a public address` } : { ok: true };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `${host} is not a public hostname` };
  }
  try {
    const addrs = await lookup(host, { all: true });
    const bad = addrs.find((a) => isPrivateIp(a.address));
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
  price: string; // USD
  price_micro: number;
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
  for await (const c of req) chunks.push(c as Buffer);
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

// static files under web/: clean URLs for the pages (/product -> product.html), plus assets (images and the
// site's fonts) and the three markdown documents at the repo root, which the docs page links to
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg',
  woff2: 'font/woff2', md: 'text/markdown; charset=utf-8',
};
const DOCS = new Set(['README.md', 'SPEC.md', 'DEPLOY.md']);
function staticFile(uiDir: string, path: string): [file: string, type: string] | null {
  if (path === '/' || path === '/index.html') {
    // the landing page when the operator ships one; otherwise the catalog app is the front door
    const landing = join(uiDir, 'index.html');
    return [existsSync(landing) ? landing : join(uiDir, 'catalog.html'), TYPES.html];
  }
  const m = /^\/([a-z0-9-]+)(?:\.(html|css|png|jpg|woff2))?$/.exec(path);
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

function routesOf(row: GatewayRow): CatalogRoute[] {
  if (!row.ok || !row.payload) return [];
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
      out.push({
        origin: row.origin,
        realm: String(doc.realm ?? ''),
        rail: String(doc.rail ?? 'ledger'),
        service: String(s.name ?? ''),
        service_description: String(s.description ?? ''),
        method: String(r.method ?? 'GET').toUpperCase(),
        path: String(s.prefix ?? '') + String(r.path ?? ''),
        url: row.origin.replace(/\/$/, '') + String(s.prefix ?? '') + String(r.path ?? ''),
        price: String(r.price),
        price_micro: priceMicro,
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
  const tryClient =
    opts.tryAgent && opts.tryMandate
      ? new TabClient({
          agent: opts.tryAgent,
          mandate: opts.tryMandate,
          maxPerCallUsd: opts.tryMaxPerCallUsd ?? '0.05',
        })
      : null;

  async function fetchGateway(origin: string): Promise<GatewayRow> {
    const now = new Date().toISOString();
    try {
      if (!opts.allowPrivateOrigins) {
        const pub = await originIsPublic(origin);
        if (!pub.ok) throw new Error(`refused: ${pub.reason}`);
      }
      const res = await fetch(origin.replace(/\/$/, '') + '/.well-known/tab', {
        signal: AbortSignal.timeout(5_000),
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
      return { origin, ok: false, error: (err as Error).message, payload: null, fetched_at: now };
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
    const method = (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://localhost');
    const path = u.pathname;
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      // the three project docs, all rendered through the same shell so none opens as raw markdown
      const RENDERED: Record<string, { file: string; opts: Parameters<typeof renderDocsPage>[1] }> = {
        '/docs': { file: 'README.md', opts: { active: 'docs', groups: DOC_GROUPS } },
        '/docs.html': { file: 'README.md', opts: { active: 'docs', groups: DOC_GROUPS } },
        '/protocol': { file: 'SPEC.md', opts: { active: 'protocol', title: 'Specification' } },
        '/deployment': { file: 'DEPLOY.md', opts: { active: 'deployment', title: 'Deployment' } },
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
      const MD_REDIRECT: Record<string, string> = { '/README.md': '/docs', '/SPEC.md': '/protocol', '/DEPLOY.md': '/deployment' };
      if (method === 'GET' && MD_REDIRECT[path] && u.searchParams.get('raw') !== '1') {
        res.writeHead(301, { location: MD_REDIRECT[path] });
        res.end();
        return;
      }

      const page = method === 'GET' && !path.startsWith('/v1/') ? (uiPath ? staticFile(uiPath, path) : null) : null;
      if (page) {
        const [file, type] = page;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
        res.end(readFileSync(file));
        return;
      }
      if (method === 'GET' && !uiPath && (path === '/' || path === '/catalog')) {
        sendJson(res, 500, { error: 'ui not found: keep web/ next to dist/' });
        return;
      }

      if (method === 'GET' && path === '/v1/catalog.json') {
        sendJson(res, 200, {
          gateways: store.all().map((r) => ({
            origin: r.origin,
            ok: r.ok,
            error: r.error,
            fetched_at: r.fetched_at,
            ...(r.payload ?? {}),
          })),
        });
        return;
      }

      if (method === 'GET' && path === '/v1/search') {
        const q = (u.searchParams.get('q') ?? '').trim().toLowerCase();
        const maxPrice = u.searchParams.get('max_price');
        const maxMicro = maxPrice ? usdToMicro(maxPrice) : null;
        const terms = q ? q.split(/\s+/) : [];
        const results: Array<CatalogRoute & { score: number }> = [];
        for (const row of store.all()) {
          for (const route of routesOf(row)) {
            if (maxMicro !== null && route.price_micro > maxMicro) continue;
            const routeText = `${route.method} ${route.path} ${route.description}`.toLowerCase();
            const serviceText = `${route.service} ${route.service_description} ${route.realm}`.toLowerCase();
            let score = 0;
            if (terms.length === 0) score = 1;
            else if (terms.every((t) => routeText.includes(t))) score = 2;
            else if (terms.every((t) => (routeText + ' ' + serviceText).includes(t))) score = 1;
            if (score > 0) results.push({ ...route, score });
          }
        }
        results.sort((a, b) => b.score - a.score || a.price_micro - b.price_micro);
        sendJson(res, 200, { results: results.map(({ score, ...r }) => r) });
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
          const r = await fetch(
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
        const limit = Number(u.searchParams.get('limit') ?? 50) || 50;
        const all: Array<Receipt & { origin: string }> = [];
        await Promise.all(
          store.all().filter((r) => r.ok).map(async (row) => {
            try {
              const r = await fetch(
                row.origin.replace(/\/$/, '') + `/.well-known/tab/receipts?limit=${limit}`,
                { signal: AbortSignal.timeout(5_000) },
              );
              if (!r.ok) return;
              const doc = (await r.json()) as { receipts?: Receipt[] };
              for (const rec of doc.receipts ?? []) all.push({ ...rec, origin: row.origin });
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
          const r = await tryClient.fetch(url, {
            method: m,
            headers: body.body != null ? { 'content-type': 'application/json' } : undefined,
            body: body.body != null ? (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)) : undefined,
          });
          const text = await r.text();
          sendJson(res, 200, {
            status: r.status,
            receipt: receiptOf(r),
            body: text.slice(0, 65_536),
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
