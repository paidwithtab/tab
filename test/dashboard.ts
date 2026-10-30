// tab OS in a real browser. Starts a gateway with starter credits, a fake
// Messages API and a company server in process, then drives web/os.html with
// Playwright: sign up, start the quickstart and watch the starter agent pay and
// answer, found a company from the research template, add a model key, claim
// credits, watch the first ticket run to done, read the evidence and the run
// log, sign out. Any console error or page error fails.
//   npm run test:dashboard          (needs: npx playwright install chromium, once)
//   npm run test:dashboard -- --live   also loads the public site and app read-only
// The browser is the one Playwright installed, or $CHROME.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

import { newKeyPair } from '../src/keys.js';
import { Store } from '../src/store.js';
import { createGateway, type Spec } from '../src/gateway.js';
import { CompanyStore } from '../src/company/store.js';
import { Engine } from '../src/company/engine.js';
import { createCompanyServer } from '../src/company/server.js';
import { Secrets } from '../src/company/secrets.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const live = process.argv.includes('--live');
const SITE = process.env.SITE_URL ?? 'https://paidwithtab.com';
const LIVE_APP = process.env.APP_URL ?? 'https://app.paidwithtab.com';

/** Console errors, page errors and failed requests on a page, for the checks. */
function watch(page: Page): { errors: string[]; failed: string[] } {
  const errors: string[] = [];
  const failedReqs: string[] = [];
  // Chrome logs every non-2xx fetch as "Failed to load resource"; the API's expected 401s and 400s are checked by status, not here
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && r.request().resourceType() !== 'fetch' && r.request().resourceType() !== 'xhr') failedReqs.push(`${r.status()} ${r.url()}`); });
  return { errors, failed: failedReqs };
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-dash-'));

  // -- a gateway selling one route, with starter credits ------------------------------
  const seller = newKeyPair();
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ quote: 'stub', path: req.url })); });
  const upPort = await listen(upstream);
  const wiki = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const u = new URL(req.url ?? '/', 'http://wiki');
    const q = u.searchParams.get('q') ?? '';
    if (u.pathname === '/w/rest.php/v1/search/page') return res.end(JSON.stringify({ pages: [{ key: q.replace(/ /g, '_'), title: q }] }));
    res.end(JSON.stringify({ title: 'Lisbon', extract: 'Lisbon is the capital of Portugal.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Lisbon' } } }));
  });
  const wikiPort = await listen(wiki);
  const spec: Spec = {
    realm: 'quotes.local', recipient: seller.publicKey, public_receipts: true,
    services: [
      { name: 'q', prefix: '', upstream: `http://127.0.0.1:${upPort}`, routes: [{ method: 'GET', path: '/quote', price: '0.01' }] },
      { name: 'wikipedia', prefix: '/wikipedia', upstream: `http://127.0.0.1:${wikiPort}`, routes: [
        { method: 'GET', path: '/w/rest.php/v1/search/page', price: '0.001' },
        { method: 'GET', path: '/api/rest_v1/page/summary/:title', price: '0.001' },
      ] },
    ],
  };
  const gwStore = new Store(join(scratch, 'gw.db'));
  const gateway = createGateway(spec, { store: gwStore, faucetUsd: '1.00', faucetPerIpPerDay: 100 });
  const GW = `http://127.0.0.1:${await listen(gateway)}`;

  // -- a fake Messages API: limits, one paid fetch, finish with the receipt -----------
  const GOOD_KEY = 'sk-ant-api03-dash-' + 'x'.repeat(24);
  const anthropic = createServer(async (req, res) => {
    const json = (st: number, d: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    const key = String(req.headers['x-api-key'] ?? '');
    if (key !== GOOD_KEY) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (req.method === 'GET') return json(200, { data: [{ id: 'claude-sonnet-5-5' }] });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const turn = body.messages.filter((m: any) => m.role === 'assistant').length;
    const reply = (content: unknown[]) => json(200, { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 100 } });
    if (turn === 0) return reply([{ type: 'tool_use', id: 'tu_1', name: 'tab_limits', input: {} }]);
    if (turn === 1) return reply([{ type: 'tool_use', id: 'tu_2', name: 'tab_fetch', input: { url: `${GW}/quote` } }]);
    let receipt = '';
    try { receipt = JSON.parse(body.messages[body.messages.length - 1].content[0].content).receipt.id; } catch { /* none */ }
    return reply([{ type: 'tool_use', id: 'tu_3', name: 'finish', input: { status: 'done', summary: 'bought a quote and read it', evidence: [{ kind: 'receipt', value: receipt }], comment: 'the quote was: stub' } }]);
  });
  const ANT = `http://127.0.0.1:${await listen(anthropic)}`;

  // -- the company server, as the hosted one runs: claude, http and starter, no host key --------
  const store = new CompanyStore(join(scratch, 'company.db'));
  const secrets = Secrets.ephemeral();
  const engine = new Engine({ store, workDir: join(scratch, 'work'), tickMs: 3_600_000, runTimeoutMs: 20_000, secrets, anthropicUrl: ANT });
  const server = createCompanyServer({ store, engine, hosts: [], allowPrivateOrigins: true, defaultGateway: GW, secureCookies: false, secrets, anthropicUrl: ANT });
  const APP = `http://127.0.0.1:${await listen(server)}`;

  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const w = watch(page);
  const text = async (sel: string) => (await page.locator(sel).first().textContent()) ?? '';
  const open = async (app: string) => { await page.evaluate((a) => { (globalThis as any).location.hash = `#/${a}`; }, app); await page.locator(`main[data-app="${app}"]`).waitFor(); };
  const run = async () => { await engine.tick(); await engine.drain(); };
  const doneCol = '.board .col:nth-child(5)';

  try {
    // -- sign up ----------------------------------------------------------------------
    await page.goto(APP + '/');
    await page.locator('#a-signup').waitFor();
    check('the sign in view shows first', await page.locator('#a-login').isVisible() && await page.locator('#shell').isHidden());
    await page.fill('#a-email', 'owner@example.com');
    await page.fill('#a-pass', 'correct horse battery');
    await page.click('#a-signup');
    await page.locator('#qs-topic').waitFor();
    check('sign up lands on the first company setup', /Set up your first company/.test(await text('#gate h1')) && await page.locator('#n-out').isVisible());

    // -- the quickstart: a starter agent pays and answers, no key --------------------------
    await page.fill('#qs-topic', 'Lisbon');
    await page.click('#qs-go');
    await page.locator('main[data-app="overview"]').waitFor();
    check('the quickstart opens the overview with the first run card', /Your first run/.test(await text('main')) && /owner@example\.com/.test(await text('#me')));
    await run();
    await page.locator('main .answer').waitFor({ timeout: 15_000 });
    check('the starter answer appears with its two verified receipts', /Lisbon is the capital of Portugal/.test(await text('main .answer')) && (await page.locator('main .answer a.ok').count()) === 2);
    await page.fill('#fr-topic', 'Lisbon tram 28');
    await page.click('[data-act="fr-again"]');
    await page.locator('main .wip').filter({ hasText: 'Lisbon tram 28' }).waitFor();
    await run();
    await open('tasks');
    await page.locator(`${doneCol} .tcard`).filter({ hasText: 'Lisbon tram 28' }).waitFor({ timeout: 15_000 });
    check('asking again opens a starter ticket that runs to done', true);
    await open('overview');
    await page.click('[data-act="hide-fr"]');
    check('the first run card can be hidden', !/Your first run/.test(await text('main')));

    // -- a second company, from the research template ---------------------------------------------
    await page.click('[data-act="switch"]');
    await page.click('#switcher [data-act="new-company"]');
    await page.locator('#n-template').waitFor();
    check('the switcher starts a new company, with a way back', /New company/.test(await text('#gate h1')) && await page.locator('#n-cancel').isVisible());
    check('templates are offered', (await page.locator('#n-template option').count()) >= 3);
    await page.selectOption('#n-template', '0');
    check('choosing a template fills the form', /Field Notes/.test(await page.inputValue('#n-name')) && (await page.inputValue('#n-mission')).length > 20);
    await page.fill('#n-gateway', GW);
    await page.click('#n-go');
    await page.locator('#switcher .nm').filter({ hasText: 'Field Notes' }).waitFor();
    await page.locator('main[data-app="overview"]').waitFor();
    check('the company opens with the template agents and ticket', (await page.locator('main table.t tr.click').count()) === 2 && (await page.locator('main .wip').count()) === 1);
    check('claude agents are shown waiting for a model key', /waiting for a model key/.test(await text('main')));
    await page.click('.top [data-act="new-agent"]');
    check('the hosted server offers claude, http and starter adapters', (await page.locator('#h-adapter option').allTextContents()).join('|') === 'Claude (on the company model key)|Your own endpoint (http)|Starter (Wikipedia lookups, no model key)');
    await page.click('#mform [data-act="close"]');

    // -- model key and starter credits ----------------------------------------------
    await open('integrations');
    await page.click('main [data-act="model-key"]');
    await page.fill('#k-val', 'hunter2');
    await page.click('#msub');
    await page.locator('#merr').filter({ hasText: /does not look like/ }).waitFor();
    check('a bad key is explained inline', true);
    await page.fill('#k-val', GOOD_KEY);
    await page.click('#msub');
    await page.locator('main').filter({ hasText: /ending in/ }).waitFor();
    check('a good key is accepted and shown by its hint only', !(await page.content()).includes(GOOD_KEY) && await page.locator('main [data-act="model-key-rm"]').isVisible());
    await open('wallet');
    await page.click('main [data-act="fund"]');
    await page.locator('main .wal .amt').filter({ hasText: /1\.00/ }).waitFor();
    check('starter credits land in the owner wallet', true);

    // -- the first run ----------------------------------------------------------------
    await run();
    await open('tasks');
    await page.locator(`${doneCol} .tcard`).first().waitFor({ timeout: 15_000 });
    check('the ticket goes to done', (await page.locator(`${doneCol} .tcard`).count()) === 1);
    await open('wallet');
    await page.locator('main').filter({ hasText: /0\.019/ }).waitFor();
    const wallet = await text('main');
    check('the wallet shows the tab spend, the model cost and the total', /0\.01/.test(wallet) && /0\.009/.test(wallet) && /0\.019/.test(wallet));
    await open('tasks');
    await page.locator(`${doneCol} .tcard`).first().click();
    await page.locator('#td-thread').filter({ hasText: /the quote was: stub/ }).waitFor();
    check('the task drawer shows the receipt as evidence and the agent comment', /receipt/.test(await text('.drawer')));
    await page.click('.drawer [data-act="close"]');
    await open('agents');
    await page.locator('main .acard').filter({ hasText: 'scout' }).click();
    await page.locator('.drawer tr[data-run]').first().click();
    await page.locator('#ad-run').filter({ hasText: /claude-sonnet-5-5: 3 turns/ }).waitFor();
    check('the run log names the model and the tool calls', /\[tab_fetch/.test(await text('#ad-run')));
    await page.click('.drawer [data-act="close"]');
    await open('integrations');
    check('the board log verifies every action', (await page.locator('main td.ok').count()) >= 2 && (await page.locator('main td.bad').count()) === 0);
    await open('receipts');
    check('receipts list the payment', /quotes\.local/.test(await text('main')));

    // -- a task from tab OS ---------------------------------------------------------------
    await open('tasks');
    await page.click('main [data-act="new-task"]');
    await page.fill('#t-title', 'second brief');
    await page.selectOption('#t-as', 'scout');
    await page.click('#msub');
    await page.locator('.board .tcard').filter({ hasText: 'second brief' }).waitFor();
    await run();
    await page.locator(`${doneCol} .tcard`).filter({ hasText: 'second brief' }).waitFor({ timeout: 15_000 });
    check('a task opened in tab OS runs to done', true);

    // -- the old addresses and sign out --------------------------------------------------
    const old = await fetch(APP + '/os', { redirect: 'manual' });
    check('the old /os address leads to tab OS at /', old.status === 301 && old.headers.get('location') === '/');
    await page.click('#me');
    await page.click('.side [data-act="logout"]');
    await page.locator('#a-login').waitFor();
    check('sign out returns to the sign in view', await page.locator('#shell').isHidden());
    check('no console or page errors during the session', w.errors.length === 0, w.errors);
    check('no asset failed to load', w.failed.length === 0, w.failed);

    // -- the public site and app, read-only ---------------------------------------------------
    if (live) {
      for (const path of ['/', '/product', '/developers', '/providers', '/catalog', '/docs', '/company', '/company-guide', '/protocol', '/deployment']) {
        const p = await context.newPage();
        const lw = watch(p);
        const r = await p.goto(SITE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await p.waitForTimeout(500);
        check(`site ${path} loads clean`, !!r && r.status() === 200 && lw.errors.length === 0 && lw.failed.length === 0, { status: r?.status(), errors: lw.errors, failed: lw.failed });
        await p.close();
      }
      const p = await context.newPage();
      const lw = watch(p);
      const r = await p.goto(LIVE_APP + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await p.locator('#a-login').waitFor({ timeout: 10_000 });
      check('the live app serves the sign in view with no errors', !!r && r.status() === 200 && lw.errors.length === 0 && lw.failed.length === 0, { errors: lw.errors, failed: lw.failed });
      await p.close();
    }
  } finally {
    await browser.close();
    server.close();
    anthropic.close();
    gateway.close();
    upstream.close();
    wiki.close();
    store.close();
    gwStore.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
