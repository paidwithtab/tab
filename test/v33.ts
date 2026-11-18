// tab 3.3 end to end, on the ledger rail, in one process on random ports with temp SQLite files:
// the funnel on gateways and on the site, tab's own User-Agent, and the rest of 3.3 as it lands.
//   npm run test:v33

import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newKeyPair } from '../src/keys.js';
import { usdToMicro } from '../src/protocol.js';
import { issueMandate } from '../src/mandate.js';
import { Store, CatalogStore } from '../src/store.js';
import { createGateway, STATS_PATH, funnelStepOf, clientFamily, type Spec } from '../src/gateway.js';
import { createCatalog, siteStepOf } from '../src/catalog.js';
import { TabClient } from '../src/client.js';
import { tabUserAgent, PACKAGE_VERSION } from '../src/version.js';
import type { UsageReport } from '../src/usage.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)?.slice(0, 600)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-v33-'));
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
async function listen(server: Server): Promise<string> {
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${port}`;
}
const gatewayAt = async (spec: Spec, o: Omit<Parameters<typeof createGateway>[1], 'origin'>): Promise<{ server: Server; url: string }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = createGateway(spec, { ...o, origin: url });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return { server, url };
};
const getJson = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers });
  return { status: r.status, doc: (await r.json().catch(() => ({}))) as any };
};
function cli(args: string[], env: Record<string, string>): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code: code ?? 1 }));
    p.stdin.end();
  });
}
/** A fetch that looks, to a gateway behind a local proxy, like it came from `ip` on the internet. */
const fromIp = (ip: string, extra: Record<string, string> = {}): typeof fetch => ((url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('cf-connecting-ip', ip);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return fetch(url, { ...init, headers });
}) as typeof fetch;
const settle = () => new Promise((r) => setTimeout(r, 50)); // 'finish' handlers run after the response

async function main(): Promise<void> {
  // -- an upstream API ---------------------------------------------------------------------
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    for await (const _ of req) { /* drain */ }
    const send = (s: number, d: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/hello') return send(200, { hello: 'world' });
    if (u.pathname === '/boom') return send(500, { error: 'down' });
    send(404, { error: 'no' });
  });
  const UP = await listen(upstream);

  const REALM = 'v33.local';
  const seller = newKeyPair();
  const spec: Spec = {
    realm: REALM, recipient: seller.publicKey, rail: 'ledger', public_receipts: true,
    services: [{
      name: 'api', prefix: '/api', upstream: UP, description: 'a test API',
      routes: [
        { method: 'GET', path: '/hello', price: '0.002', description: 'hello world greeting' },
        { method: 'GET', path: '/boom', price: '0.001', description: 'always fails' },
        { method: 'GET', path: '/dear', price: '0.50', description: 'expensive' },
      ],
    }],
  };
  const store = new Store(join(scratch, 'gw.db'));
  const STATS_TOKEN = 'stats-token-for-tests';
  const gw = await gatewayAt(spec, { store, faucetUsd: '1.00', allowPrivateEgress: true, egressFetch: fetch, statsToken: STATS_TOKEN, houseIps: ['198.51.100.9'] });
  const GW = gw.url;

  // ======================================================================================
  // 1. the funnel
  {
    check('1: step of a discovery fetch', funnelStepOf('GET', '/.well-known/tab', 200, {}, false)?.step === 'discover');
    check('1: step of a 402', JSON.stringify(funnelStepOf('GET', '/api/hello', 402, { tabProblem: 'payment-required', tabRoute: 'api|GET /hello' }, false)) === JSON.stringify({ step: 'challenge', detail: 'api|GET /hello' }));
    check('1: step of a refusal names its code', funnelStepOf('GET', '/api/dear', 402, { tabProblem: 'mandate-exceeded', tabRoute: 'r' }, false)?.detail === 'mandate-exceeded');
    check('1: step of a paid call', funnelStepOf('GET', '/api/hello', 200, { tabRoute: 'r' }, true)?.step === 'paid');
    check('1: an unpriced path is not a step', funnelStepOf('GET', '/nothing', 404, {}, false) === null);
    check('1: clientFamily reads tab clients', clientFamily('tab/3.3.0 (mcp)') === 'tab-mcp' && clientFamily(tabUserAgent('cli')) === 'tab-cli');
    check('1: clientFamily reads others', clientFamily('curl/8.5') === 'curl' && clientFamily('Mozilla/5.0 (X11)') === 'browser' && clientFamily('Googlebot/2.1') === 'bot' && clientFamily('') === 'none');
    check('1: tab names itself with the package version', tabUserAgent('mcp') === `tab/${PACKAGE_VERSION} (mcp)` && PACKAGE_VERSION !== '0');

    // a stranger: discovers, claims, is asked to pay, pays, is refused above the cap, hits a dead route
    const owner = newKeyPair(), agent = newKeyPair();
    const stranger = fromIp('203.0.113.7');
    await stranger(`${GW}/.well-known/tab`);
    const claim = await stranger(`${GW}/.well-known/tab/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: owner.publicKey }) });
    check('1: the stranger claims starter credits', claim.status === 200, claim.status);
    const mandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', maxPerCallUsd: '0.05' });
    const client = new TabClient({ agent, mandate, fetch: stranger, surface: 'mcp' });
    const ok = await client.fetch(`${GW}/api/hello`);
    check('1: the stranger pays for a call', ok.status === 200, ok.status);
    const dear = await fetch(`${GW}/api/dear`, { headers: { 'cf-connecting-ip': '203.0.113.7', authorization: 'Tab garbage' } });
    check('1: a malformed credential is refused', dear.status >= 400, dear.status);
    await client.fetch(`${GW}/api/boom`);
    // the house: its own address is left out
    const house = fromIp('198.51.100.9');
    await house(`${GW}/.well-known/tab`);
    await new TabClient({ agent, mandate, fetch: house }).fetch(`${GW}/api/hello`);
    // a second stranger only looks, with curl
    await fromIp('203.0.113.8', { 'user-agent': 'curl/8.5.0' })(`${GW}/.well-known/tab`);
    await settle();

    const stats = await getJson(`${GW}${STATS_PATH}?days=7`, { authorization: `Bearer ${STATS_TOKEN}` });
    const f = (stats.doc as UsageReport).funnel!;
    const step = (s: string) => f.steps.find((x) => x.step === s)?.visitors ?? -1;
    check('1: the stats carry the funnel', stats.status === 200 && !!f, stats.status);
    check('1: two outside visitors discovered, the house is left out', step('discover') === 2, f.steps);
    check('1: one claimed, one was asked to pay, one paid', step('claim') === 1 && step('challenge') === 1 && step('paid') === 1, f.steps);
    check('1: the refusal is counted by its code', f.refused.some((r) => r.code === 'malformed-credential'), f.refused);
    check('1: the failed upstream is counted on its route', f.other.some((o) => o.step === 'failed' && o.detail === 'api|GET /boom'), f.other);
    check('1: clients are told apart', f.clients.some((c) => c.client === 'tab-mcp') && f.clients.some((c) => c.client === 'curl'), f.clients);
    check('1: routes show asked and paid', f.routes.some((r) => r.route === 'api|GET /hello' && r.paid === 1 && r.challenged === 1), f.routes);
    const raw = JSON.stringify(store.funnelSince('2000-01-01'));
    check('1: no address is stored', !raw.includes('203.0.113') && !raw.includes('198.51.100'), raw.slice(0, 200));

    const printed = await cli(['stats', '--gateway', GW, '--days', '7'], { TAB_STATS_TOKEN: STATS_TOKEN });
    check('1: tab stats prints the funnel', printed.code === 0 && /funnel/.test(printed.out) && /paid\s+1/.test(printed.out) && /malformed-credential 1/.test(printed.out), printed);

    // a flood cannot fill the table
    for (let i = 0; i < 5; i++) store.funnelStep('2001-01-01', 'discover', '', `w${i}`, 'none', 3);
    const day = (d: string) => store.funnelSince(d).filter((r) => r.step === 'discover' && r.client === 'none').reduce((a, r) => a + r.visitors, 0);
    check('1: a day keeps at most its cap of rows', day('2001-01-01') === 3, day('2001-01-01'));
    store.pruneFunnel('2001-01-02');
    check('1: old days are pruned, today stays', day('2001-01-01') === 0 && step('discover') === 2);
  }

  // ======================================================================================
  // 2. the site funnel
  {
    const own = ['paidwithtab.com'];
    const steps = siteStepOf('GET', '/developers.html', 200, 'text/html; charset=utf-8', new URLSearchParams('ref=x'), 'https://t.co/abc', own);
    check('2: a page view with a ref and an outside referer', JSON.stringify(steps) === JSON.stringify([{ step: 'page', detail: '/developers' }, { step: 'ref', detail: 'x' }, { step: 'referer', detail: 't.co' }]), steps);
    check('2: our own referer is not counted', siteStepOf('GET', '/', 200, 'text/html', new URLSearchParams(), 'https://paidwithtab.com/catalog', own).length === 1);
    check('2: a search is counted with its words', siteStepOf('GET', '/v1/search', 200, 'application/json', new URLSearchParams('q=  Web   Search '), '', own)[0]?.detail === 'web search');
    check('2: errors are not counted', siteStepOf('GET', '/', 404, 'text/html', new URLSearchParams(), '', own).length === 0);

    const cstore = new CatalogStore(join(scratch, 'catalog.db'));
    const cat = createCatalog({ store: cstore, statsToken: STATS_TOKEN, houseIps: ['198.51.100.9'] });
    const CAT = await listen(cat);
    const a = fromIp('203.0.113.20', { 'user-agent': 'Mozilla/5.0', referer: 'https://x.com/paidwithtab' });
    await a(`${CAT}/?ref=x`);
    await a(`${CAT}/developers.html`);
    await a(`${CAT}/v1/search?q=weather`);
    await fromIp('203.0.113.21', { 'user-agent': 'Mozilla/5.0' })(`${CAT}/v1/search?q=weather`);
    await fromIp('198.51.100.9', { 'user-agent': 'Mozilla/5.0' })(`${CAT}/`);
    await fromIp('203.0.113.22', { 'user-agent': 'Googlebot/2.1' })(`${CAT}/`);
    await settle();
    const s = await getJson(`${CAT}/v1/stats?days=7`, { authorization: `Bearer ${STATS_TOKEN}` });
    const row = (step: string, detail: string) => (s.doc.site as any[] ?? []).find((x) => x.step === step && x.detail === detail);
    check('2: the catalog serves its stats with the token', s.status === 200 && Array.isArray(s.doc.site), s);
    check('2: page views by page, house and bots left out', row('page', '/')?.visitors === 1 && row('page', '/developers')?.visitors === 1, s.doc.site);
    check('2: where visitors came from', row('ref', 'x')?.visitors === 1 && row('referer', 'x.com')?.visitors >= 1, s.doc.site);
    check('2: what they searched for', row('search', 'weather')?.visitors === 2, s.doc.site);
    const no = await getJson(`${CAT}/v1/stats`);
    check('2: no token, no stats', no.status === 404);
    const printed = await cli(['stats', '--catalog', CAT, '--days', '7'], { TAB_STATS_TOKEN: STATS_TOKEN });
    check('2: tab stats --catalog prints the site funnel', printed.code === 0 && /search/.test(printed.out) && /weather/.test(printed.out), printed);
    cat.close();
  }

  gw.server.close(); upstream.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
