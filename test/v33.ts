// tab 3.3 end to end, on the ledger rail, in one process on random ports with temp SQLite files:
// the funnel on gateways and on the site, tab's own User-Agent, and the rest of 3.3 as it lands.
//   npm run test:v33

import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
import { fixForCode, fixForRefusal, problemCodeOf } from '../src/fixes.js';
import { runDoctor } from '../src/doctor.js';
import { createTabTools } from '../src/tools.js';
import { listProofs } from '../src/proof.js';
import { MCP_INSTRUCTIONS } from '../src/mcp.js';

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
    if (u.pathname.startsWith('/api/rest_v1/page/summary/')) return send(200, { title: decodeURIComponent(u.pathname.split('/').pop()!).replace(/_/g, ' '), extract: 'a status code' });
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
    }, {
      name: 'wikipedia', prefix: '/wikipedia', upstream: UP, description: 'Wikipedia',
      routes: [{ method: 'GET', path: '/api/rest_v1/page/summary/:title', price: '0.001', description: 'summary', free_per_day: 3 }],
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

    // a catalog started without --house-ip, read on the box with the operator's address left out after the fact
    const bare = new CatalogStore(join(scratch, 'catalog-bare.db'));
    const cat2 = createCatalog({ store: bare });
    const CAT2 = await listen(cat2);
    await fromIp('198.51.100.9', { 'user-agent': 'Mozilla/5.0' })(`${CAT2}/`);
    await fromIp('203.0.113.30', { 'user-agent': 'Mozilla/5.0' })(`${CAT2}/`);
    await settle();
    cat2.close();
    const all = await cli(['stats', '--catalog-db', join(scratch, 'catalog-bare.db'), '--days', '7', '--json'], {});
    const ours = await cli(['stats', '--catalog-db', join(scratch, 'catalog-bare.db'), '--house-ip', '198.51.100.9', '--days', '7', '--json'], {});
    const home = (o: string) => (JSON.parse(o || '{}').site ?? []).find((x: any) => x.step === 'page' && x.detail === '/')?.visitors;
    check('2: --catalog-db reads the database; --house-ip leaves the operator out after the fact', home(all.out) === 2 && home(ours.out) === 1, { all: all.out.slice(0, 300), ours: ours.out.slice(0, 300), err: ours.err });
  }

  // ======================================================================================
  // 3. the first paid call: tab init's demo, fixes that name the command, tab doctor
  {
    const home = join(scratch, 'newuser');
    const env = { TAB_HOME: home, TAB_PROOFS: join(home, 'receipts') };
    const init = await cli(['init', '--dir', home, '--gateway', GW, '--catalog', 'http://127.0.0.1:9'], env);
    check('3: tab init makes a first call and says so', init.code === 0 && /first call\s+Wikipedia "HTTP 402", free, signed receipt/.test(init.out), init);
    check('3: and checks its proof', /proof\s+.*: holds/.test(init.out), init.out);
    const proofs = listProofs(join(home, 'receipts'));
    check('3: the first call is kept as a proof folder tagged tab init', proofs.length === 1 && JSON.parse(readFileSync(join(proofs[0], 'request.json'), 'utf8')).task === 'tab init', proofs);
    const again = await cli(['init', '--dir', home, '--gateway', GW, '--no-demo'], env);
    check('3: --no-demo skips it', again.code === 0 && !/first call/.test(again.out), again.out);

    // fixes
    check('3: a gateway code has a fix naming a command', /tab mandate issue/.test(fixForCode('mandate-exceeded')?.fix ?? '') && /tab topup/.test(fixForCode('insufficient-funds')?.fix ?? ''));
    check('3: a client refusal maps to the same fix', fixForRefusal('realm x.example is not in the mandate\'s allow list')?.what === fixForCode('mandate-denied')?.what && fixForRefusal('price $0.50 exceeds the mandate\'s per-call cap $0.05') === fixForCode('mandate-exceeded'));
    check('3: unknown reasons have none', fixForRefusal('something else') === null && fixForCode('nope') === null);
    check('3: problemCodeOf reads a problem body', problemCodeOf('application/problem+json', JSON.stringify({ type: 'urn:tab:problem:mandate-denied', title: 'mandate-denied' })) === 'mandate-denied' && problemCodeOf('text/plain', 'x') === null);
    const capped = await cli(['fetch', `${GW}/api/dear`], env);
    check('3: tab fetch prints the fix when the client refuses', capped.code === 2 && /refused: price .* per-call cap/.test(capped.err) && /fix: .*tab mandate issue/.test(capped.err), capped);
    const owner = newKeyPair(), agent = newKeyPair();
    const narrow = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['elsewhere.example'] });
    const tools = createTabTools({ agent, mandate: narrow, catalog: 'http://127.0.0.1:9' });
    const denied = await tools.call('tab_fetch', { url: `${GW}/api/hello` });
    check('3: tab_fetch returns the fix with a refusal', denied.isError && /fix: .*--allow/.test(denied.text), denied.text);
    const poor = issueMandate(newKeyPair(), { agent: agent.publicKey, budgetUsd: '1.00' });
    const broke = await createTabTools({ agent, mandate: poor, catalog: 'http://127.0.0.1:9' }).call('tab_fetch', { url: `${GW}/api/hello` });
    const bdoc = JSON.parse(broke.text);
    check('3: tab_fetch names the problem and fix for a gateway refusal', bdoc.problem === 'insufficient-funds' && /tab topup/.test(bdoc.fix), bdoc);

    // tab doctor
    const toolsHome = join(scratch, 'toolshome');
    mkdirSync(join(toolsHome, '.cursor'), { recursive: true });
    writeFileSync(join(toolsHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { tab: { command: 'npx' } } }));
    const doc = await runDoctor({ dir: home, gateway: GW, catalog: 'http://127.0.0.1:9', home: toolsHome, latestRelease: async () => '99.0.0' });
    const st = (n: string) => doc.find((c) => c.name === n);
    check('3: doctor: keys and mandate ok', st('agent key')?.state === 'ok' && st('mandate')?.state === 'ok', doc);
    check('3: doctor: gateway, clock, budget, balance', st('gateway')?.state === 'ok' && st('clock')?.state === 'ok' && st('budget left')?.state === 'ok' && st('balance')?.state === 'ok', doc);
    check('3: doctor: a dead catalog is a warning with a fix', st('catalog')?.state === 'warn' && !!st('catalog')?.fix, st('catalog'));
    check('3: doctor: finds tab in the Cursor config', st('agent tools')?.state === 'ok' && /cursor/.test(st('agent tools')?.detail ?? ''), st('agent tools'));
    check('3: doctor: says a newer release is out', st('version')?.state === 'warn' && /99\.0\.0 is out/.test(st('version')?.detail ?? ''), st('version'));
    const lost = await runDoctor({ dir: join(scratch, 'nobody'), gateway: 'http://127.0.0.1:9', catalog: 'http://127.0.0.1:9', home: join(scratch, 'nobody'), latestRelease: async () => null });
    check('3: doctor on an empty machine fails with fixes', lost.filter((c) => c.state === 'fail').length >= 3 && lost.every((c) => c.state !== 'fail' || !!c.fix), lost);
    const printed = await cli(['doctor', '--gateway', GW, '--catalog', 'http://127.0.0.1:9'], { ...env, TAB_DOCTOR_HOME: toolsHome, TAB_DOCTOR_OFFLINE_VERSION: '1' });
    check('3: tab doctor prints and exits 0 when a call should work', printed.code === 0 && /ready: a paid call should work/.test(printed.out), printed);

    // the MCP server tells the model how to use it
    check('3: MCP instructions say search, then fetch', /tab_search/.test(MCP_INSTRUCTIONS) && /tab_fetch/.test(MCP_INSTRUCTIONS) && MCP_INSTRUCTIONS.length < 1200);
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
