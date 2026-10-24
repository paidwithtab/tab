// The dashboard in a real browser. Starts a gateway with starter credits, a
// fake Messages API and a company server in process, then drives web/app.html
// with Playwright: sign up, start the quickstart and watch the starter agent pay
// and answer, found a company from the research template, add a
// model key, claim credits, watch the first ticket run to done, read the
// evidence and the run log, log out. Any console error or page error fails.
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
  const visible = (id: string) => page.locator(`#${id}:not([hidden])`);

  try {
    // -- sign up ----------------------------------------------------------------------
    await page.goto(APP + '/');
    await visible('v-auth').waitFor();
    check('the auth view shows first', await page.locator('#a-signup').isVisible());
    await page.fill('#a-email', 'owner@example.com');
    await page.fill('#a-pass', 'correct horse battery');
    await page.click('#a-signup');
    await visible('v-list').waitFor();
    check('sign up lands on the company list, signed in', (await page.locator('#who').textContent()) === 'owner@example.com' && /No companies yet/.test(await page.locator('#companies').textContent() ?? ''));

    // -- the quickstart: a starter agent pays and answers, no key --------------------------
    check('a new account is offered the quickstart', await page.locator('#qs').isVisible() && (await page.locator('#n-head').textContent()) === 'Or build your own');
    await page.fill('#qs-topic', 'Lisbon');
    await page.click('#qs-go');
    await visible('v-company').waitFor();
    await visible('gs').waitFor();
    check('the getting started list shows the company founded and the credits claimed', (await page.locator('#gs-steps li.done').count()) >= 2 && /1\.00 USD of free credits/.test(await page.locator('#gs-steps').textContent() ?? ''));
    await engine.tick();
    await engine.drain();
    await page.locator('#gs-answer .answer').waitFor({ timeout: 15_000 });
    check('the starter answer appears with its two verified receipts', /Lisbon is the capital of Portugal/.test(await page.locator('#gs-answer').textContent() ?? '')
      && (await page.locator('#gs-answer a.ok').count()) === 2 && /2 receipts, each signed/.test(await page.locator('#gs-steps').textContent() ?? ''));
    check('the next step points at the model key', await page.locator('#gs-key').isVisible());
    await page.fill('#gs-topic', 'Lisbon tram 28');
    await page.click('#gs-again');
    await page.locator('#tickets tr.click').filter({ hasText: 'Lisbon tram 28' }).waitFor();
    await engine.tick();
    await engine.drain();
    await page.locator('#tickets tr.click').filter({ hasText: 'Lisbon tram 28' }).filter({ hasText: 'done' }).waitFor({ timeout: 15_000 });
    check('asking again opens a starter ticket that runs to done', true);
    await page.click('#gs-hide');
    check('the guide can be hidden', !(await page.locator('#gs').isVisible()));
    await page.click('#c-back');
    await visible('v-list').waitFor();
    check('with a company, the quickstart card steps aside', !(await page.locator('#qs').isVisible()) && (await page.locator('#n-head').textContent()) === 'New company');

    // -- found from the research template ---------------------------------------------
    const templates = await page.locator('#n-template option').count();
    check('templates are offered', templates >= 3);
    await page.selectOption('#n-template', '0');
    check('choosing a template fills the form', /Field Notes/.test(await page.inputValue('#n-name')) && (await page.inputValue('#n-mission')).length > 20);
    await page.fill('#n-gateway', GW);
    await page.click('#n-go');
    await visible('v-company').waitFor();
    check('the company view opens with the template agents and ticket', /Field Notes/.test(await page.locator('#c-name').textContent() ?? '')
      && (await page.locator('#agents tr').count()) === 3 && (await page.locator('#tickets tr.click').count()) === 1);
    check('the hosted server offers claude, http and starter adapters', (await page.locator('#h-adapter option').allTextContents()).join('|') === "claude (Claude, on the company's API key)|http (your endpoint)|starter (Wikipedia lookups, no model key)");
    check('claude agents are shown waiting for a model key', /waiting for a model key/.test(await page.locator('#mk-status').textContent() ?? ''));

    // -- model key and starter credits ----------------------------------------------
    await page.fill('#mk-key', 'hunter2');
    await page.click('#mk-save');
    await page.locator('#mk-err').filter({ hasText: /does not look like/ }).waitFor();
    check('a bad key is explained inline', true);
    await page.fill('#mk-key', GOOD_KEY);
    await page.click('#mk-save');
    await page.locator('#mk-status').filter({ hasText: /ending in/ }).waitFor();
    check('a good key is accepted and shown by its hint only', /ending in/.test(await page.locator('#mk-status').textContent() ?? '') && (await page.inputValue('#mk-key')) === ''
      && !(await page.content()).includes(GOOD_KEY) && await page.locator('#mk-remove').isVisible());
    await page.click('#c-fund');
    await page.locator('#c-balance').filter({ hasText: /1\.00/ }).waitFor();
    check('starter credits land in the owner wallet', /1\.00/.test(await page.locator('#c-balance').textContent() ?? ''));

    // -- the first run ----------------------------------------------------------------
    await engine.tick();
    await engine.drain();
    await page.locator('#tickets .pill.done').first().waitFor({ timeout: 15_000 });
    check('the ticket goes to done on the dashboard', (await page.locator('#tickets .pill.done').count()) === 1);
    check('the run shows its tab spend and model cost', /0\.01/.test(await page.locator('#runs').textContent() ?? '') && /0\.009/.test(await page.locator('#runs').textContent() ?? ''));
    check('the budget bar moved', /0\.019/.test(await page.locator('#c-spent').textContent() ?? ''));
    await page.locator('#tickets tr.click').first().click();
    await visible('ticket-panel').waitFor();
    await page.locator('#tp-evidence').filter({ hasText: /receipt/ }).waitFor();
    check('the ticket panel shows the receipt as evidence and the agent comment', /receipt/.test(await page.locator('#tp-evidence').textContent() ?? '') && /the quote was: stub/.test(await page.locator('#tp-thread').textContent() ?? ''));
    await page.locator('#runs tr.click').first().click();
    await visible('run-out').waitFor();
    check('the run log names the model and the tool calls', /claude-sonnet-5-5: 3 turns/.test(await page.locator('#run-out').textContent() ?? '') && /\[tab_fetch/.test(await page.locator('#run-out').textContent() ?? ''));
    check('the board log verifies every action', (await page.locator('#board td.ok').count()) >= 2 && (await page.locator('#board td.bad').count()) === 0);
    check('receipts list the payment', /quotes\.local/.test(await page.locator('#receipts').textContent() ?? ''));

    // -- a ticket and a comment from the dashboard -----------------------------------------
    await page.fill('#t-title', 'second brief');
    await page.selectOption('#t-assignee', 'scout');
    await page.click('#t-go');
    await page.locator('#tickets tr.click').filter({ hasText: 'second brief' }).waitFor();
    await engine.tick();
    await engine.drain();
    await page.locator('#tickets tr.click').filter({ hasText: 'second brief' }).filter({ hasText: 'done' }).waitFor({ timeout: 15_000 });
    check('a ticket opened on the dashboard runs to done', true);

    // -- log out ----------------------------------------------------------------------------
    await page.click('#logout');
    await visible('v-auth').waitFor();
    check('log out returns to the auth view', await page.locator('#a-login').isVisible());
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
      await p.locator('#v-auth:not([hidden])').waitFor({ timeout: 10_000 });
      await p.locator('#n-template option').nth(2).waitFor({ state: 'attached', timeout: 10_000 }); // templates arrive after the auth check
      check('the live app serves the auth view with templates and no errors', !!r && r.status() === 200 && lw.errors.length === 0 && lw.failed.length === 0, { errors: lw.errors, failed: lw.failed });
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
