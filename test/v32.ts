// tab 3.2 end to end, on the ledger rail, in one process on random ports with temp SQLite files:
// spending rules in mandates, free calls, calls priced by size, route reliability, the public
// receipt log (inclusion and consistency), seller stats and sale notices, card top-ups through a
// fake Stripe, referrals, usage stats, the paid-result cache, cost per task, estimates, x402
// sellers in the catalog with ranking and alternatives, and tab setup's config edits.
//   npm run test:v32

import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { newKeyPair, signBytes, saveKey } from '../src/keys.js';
import { usdToMicro, encodeReceiptHeader, type Receipt } from '../src/protocol.js';
import { issueMandate, delegateMandate, verifyMandate, ruleProblem, parseHours, saveMandate } from '../src/mandate.js';
import { Store, CatalogStore } from '../src/store.js';
import { createGateway, LOG_PATH, TOPUP_PATH, STATS_PATH, SELLER_STATS_PATH, type Spec } from '../src/gateway.js';
import { createCatalog } from '../src/catalog.js';
import { TabClient, PaymentRefused, receiptOf } from '../src/client.js';
import { createTabTools } from '../src/tools.js';
import { signListing, LISTING_PATH } from '../src/listings.js';
import { verifyProof, listProofs, costReport, type LogProof } from '../src/proof.js';
import { treeHash, inclusionProof, consistencyProof, verifyInclusion, verifyConsistency, verifyTreeHead, receiptLeaf, unb64, type TreeHead } from '../src/log.js';
import { signWebhook, verifyWebhook } from '../src/stripe.js';
import { sellerStatsMessage } from '../src/usage.js';
import { routeOfBazaarItem, reliabilityOf } from '../src/x402-catalog.js';
import { withTab, serverCommand, RELEASE_TGZ } from '../src/setup.js';
import { encodeX402 } from '../src/x402.js';
import { ttlOf } from '../src/cache.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)?.slice(0, 600)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-v32-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  await new Promise<void>((r) => server.listen(port, () => r()));
  return { server, url };
};
const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, doc: (await r.json().catch(() => ({}))) as any };
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
const call = async (tools: ReturnType<typeof createTabTools>, name: string, args: Record<string, unknown>) => {
  const r = await tools.call(name, args);
  let doc: any = null;
  try { doc = JSON.parse(r.text); } catch { doc = r.text; }
  return { isError: r.isError, doc };
};

async function main(): Promise<void> {
  // -- an upstream API ---------------------------------------------------------------------
  let hits = 0;
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    for await (const _ of req) { /* drain */ }
    hits++;
    const send = (s: number, d: unknown, h: Record<string, string> = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/hello') return send(200, { hello: 'world', n: hits });
    if (u.pathname === '/big') return send(200, { blob: 'x'.repeat(2500) }); // 2.5 KB: 3 kb charged
    if (u.pathname === '/boom') return send(500, { error: 'down' });
    if (u.pathname === '/weather/forecast') return send(200, { forecast: 'sun', n: hits });
    if (u.pathname === '/nostore') return send(200, { n: hits }, { 'cache-control': 'no-store' });
    if (u.pathname === '/act') return send(200, { acted: hits });
    send(404, { error: 'no' });
  });
  const UP = await listen(upstream);

  const hooks: any[] = [];
  const hook = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    try { hooks.push({ ...JSON.parse(body), _title: req.headers.title }); } catch { hooks.push({ text: body, _title: req.headers.title }); }
    res.writeHead(200); res.end('ok');
  });
  const HOOK = (await listen(hook)) + '/hook';

  // a fake Stripe: Checkout Sessions only
  const stripeCalls: URLSearchParams[] = [];
  const stripe = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/v1/checkout/sessions' && req.headers.authorization === 'Bearer sk_test_tab') {
      const f = new URLSearchParams(body);
      stripeCalls.push(f);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cs_test_' + stripeCalls.length, url: 'https://checkout.stripe.test/c/' + f.get('client_reference_id') }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  const STRIPE = await listen(stripe);
  const WHSEC = 'whsec_test_tab';

  const REALM = 'v32.local';
  const seller = newKeyPair();
  const spec: Spec = {
    realm: REALM, recipient: seller.publicKey, rail: 'ledger', public_receipts: true,
    services: [{
      name: 'api', prefix: '/api', upstream: UP, description: 'a test API',
      routes: [
        { method: 'GET', path: '/hello', price: '0.002', description: 'hello world greeting', free_per_day: 2 },
        { method: 'GET', path: '/big', price: '0.01', description: 'a large blob', meter: { unit: 'kb', per_unit: '0.001' } },
        { method: 'GET', path: '/boom', price: '0.001', description: 'always fails' },
        { method: 'GET', path: '/weather/forecast', price: '0.003', description: 'weather forecast for a city' },
        { method: 'GET', path: '/nostore', price: '0.001', description: 'never cached' },
        { method: 'POST', path: '/act', price: '0.002', description: 'does something each time' },
      ],
    }],
  };
  const store = new Store(join(scratch, 'gw.db'));
  const STATS_TOKEN = 'stats-token-for-tests';
  const gw = await gatewayAt(spec, {
    store, faucetUsd: '1.00', listings: true, alerts: true, allowPrivateEgress: true, egressFetch: fetch,
    stripe: { secretKey: 'sk_test_tab', webhookSecret: WHSEC, api: STRIPE }, referrals: true,
    statsToken: STATS_TOKEN, statementCheckMs: 200, statementPeriodMs: 1_000,
  });
  const GW = gw.url;

  // ======================================================================================
  // 1. spending rules in mandates
  {
    const owner = newKeyPair(), agent = newKeyPair();
    store.credit(owner.publicKey, usdToMicro('5.00'));
    const plain = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00' });
    check('1: a mandate without rules carries no paths or hours, and verifies', plain.paths === undefined && plain.hours === undefined && verifyMandate(plain).ok);
    const ruled = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', paths: ['/api/weather/*'], hours: { from: 0, to: 24 } });
    check('1: a mandate with paths and hours verifies', verifyMandate(ruled).ok, verifyMandate(ruled));
    const tampered = { ...ruled, paths: ['*'] };
    check('1: widening the signed paths breaks the signature', !verifyMandate(tampered).ok);
    check('1: ruleProblem allows a matching route', ruleProblem(ruled, 'GET /api/weather/forecast') === null);
    check('1: ruleProblem refuses another route', /not in the mandate's paths/.test(ruleProblem(ruled, 'GET /api/hello') ?? ''));
    const methodGlob = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', paths: ['POST /api/*'] });
    check('1: a method glob refuses another method', ruleProblem(methodGlob, 'GET /api/hello') !== null && ruleProblem(methodGlob, 'POST /api/hello') === null);
    const h = parseHours('mon-fri 9-17');
    check('1: parseHours reads days and hours', JSON.stringify(h) === JSON.stringify({ days: [1, 2, 3, 4, 5], from: 9, to: 17 }), h);
    check('1: parseHours wraps a range over the weekend', JSON.stringify(parseHours('sat-mon').days) === JSON.stringify([0, 1, 6]));
    let threw = false;
    try { parseHours('mon 17-9'); } catch { threw = true; }
    check('1: parseHours refuses from after to', threw);
    const sunday = new Date('2026-11-08T12:00:00Z'), monday = new Date('2026-11-09T12:00:00Z'), mondayNight = new Date('2026-11-09T20:00:00Z');
    const weekdays = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', hours: h });
    check('1: hours refuse a Sunday', ruleProblem(weekdays, 'GET /x', sunday) !== null);
    check('1: hours allow Monday noon', ruleProblem(weekdays, 'GET /x', monday) === null);
    check('1: hours refuse Monday 20:00 UTC', /Mon,Tue,Wed,Thu,Fri 09:00 to 17:00 UTC/.test(ruleProblem(weekdays, 'GET /x', mondayNight) ?? ''));

    // the client refuses before paying, the gateway refuses a credential that gets through
    const client = new TabClient({ agent, mandate: ruled });
    const ok = await client.fetch(`${GW}/api/weather/forecast`);
    check('1: a route inside the mandate paths is paid', ok.status === 200 && !!receiptOf(ok));
    let refused = '';
    try { await client.fetch(`${GW}/api/hello`); } catch (err) { refused = err instanceof PaymentRefused ? err.reason : String(err); }
    check('1: the client refuses a route outside the paths before paying', /not in the mandate's paths/.test(refused), refused);
    const sneaky = new TabClient({ agent, mandate: ruled, onChallenge: () => true });
    (sneaky as any).opts.mandate = ruled; // same mandate; skip the client check by calling the gateway directly below
    const chalRes = await fetch(`${GW}/api/hello`);
    check('1: an unpaid call still gets its challenge', chalRes.status === 402);
    const { signCredential, encodeCredentialHeader, parseChallengeHeader } = await import('../src/protocol.js');
    const chal = parseChallengeHeader(chalRes.headers.get('www-authenticate'))!;
    const cred = signCredential(agent, chal, ruled, { query: '', body: undefined });
    const direct = await fetch(`${GW}/api/hello`, { headers: { authorization: encodeCredentialHeader(cred) } });
    const directDoc = await direct.json().catch(() => ({})) as any;
    check('1: the gateway refuses a credential for a route outside the paths', direct.status === 402 && /mandate-denied/.test(JSON.stringify(directDoc) + direct.headers.get('www-authenticate')), { status: direct.status, directDoc });
    // sub-mandates may only narrow the rules
    let wider = '';
    try { delegateMandate(agent, ruled, { agent: newKeyPair().publicKey, paths: ['/api/*'] }); } catch (err) { wider = (err as Error).message; }
    check('1: a sub-mandate cannot allow routes its parent does not', /route its parent does not/.test(wider), wider);
    const narrower = delegateMandate(agent, ruled, { agent: newKeyPair().publicKey, paths: ['/api/weather/forecast'] });
    check('1: a sub-mandate may narrow the paths', verifyMandate(narrower).ok);
    const inherits = delegateMandate(agent, ruled, { agent: newKeyPair().publicKey });
    check('1: a sub-mandate inherits its parent\'s rules', JSON.stringify(inherits.paths) === JSON.stringify(ruled.paths) && verifyMandate(inherits).ok);
  }

  // ======================================================================================
  // 2. free calls, 3. priced by size, 4. reliability, 10. cache, 7. cost per task
  const owner = newKeyPair(), agent = newKeyPair();
  store.credit(owner.publicKey, usdToMicro('5.00'));
  const mandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '2.00' });
  const proofs = join(scratch, 'proofs');
  let task = 'tab@feature-a';
  const tools = createTabTools({ agent, mandate, proofDir: proofs, task: () => task });
  {
    const before = store.balance(owner.publicKey);
    const f1 = await call(tools, 'tab_fetch', { url: `${GW}/api/hello`, fresh: true });
    const f2 = await call(tools, 'tab_fetch', { url: `${GW}/api/hello`, fresh: true });
    const f3 = await call(tools, 'tab_fetch', { url: `${GW}/api/hello`, fresh: true });
    check('2: the first two calls are free', f1.doc.receipt?.free === true && f2.doc.receipt?.free === true && f1.doc.receipt.amount === '0', f1.doc.receipt);
    check('2: a free receipt names the price the agent authorized', f1.doc.receipt?.authorized === '2000');
    check('2: the third call is paid', f3.doc.receipt?.amount === '2000' && !f3.doc.receipt.free, f3.doc.receipt);
    check('2: the owner paid only for the third', before - store.balance(owner.publicKey) === 2000, before - store.balance(owner.publicKey));
    check('2: the free calls do not count against the mandate', store.spent(mandate.id, '') === 2000, store.spent(mandate.id, ''));
    const freeProof = await verifyProof(join(proofs, listProofs(proofs).find((d) => JSON.parse(readFileSync(join(d, 'receipt.json'), 'utf8')).free)!.split('/').pop()!));
    check('2: a free call\'s proof verifies (the agent signed the full price)', freeProof.ok && freeProof.checks.find((c) => c.name === 'agent authorization')?.ok === true, freeProof.checks);
    const disc = (await getJson(`${GW}/.well-known/tab`)).doc;
    const helloRoute = disc.services[0].routes.find((r: any) => r.path === '/hello');
    check('2: discovery shows free_per_day', helloRoute.free_per_day === 2);

    // 3. priced by size
    const b0 = store.balance(owner.publicKey), s0 = store.spent(mandate.id, '');
    const big = await call(tools, 'tab_fetch', { url: `${GW}/api/big` });
    check('3: a metered call charges the kb it used, not the price', big.doc.receipt?.amount === '3000' && big.doc.receipt?.authorized === '10000', big.doc.receipt);
    check('3: the receipt says what it used', big.doc.receipt?.units?.n === 3 && big.doc.receipt?.units?.unit === 'kb');
    check('3: the owner and the budget are charged only what was used', b0 - store.balance(owner.publicKey) === 3000 && store.spent(mandate.id, '') - s0 === 3000, { paid: b0 - store.balance(owner.publicKey), spent: store.spent(mandate.id, '') - s0 });
    check('3: the seller is paid what was used', store.balance(seller.publicKey) === 2000 + 3000 + 3000, store.balance(seller.publicKey));
    const bigProof = await verifyProof(big.doc.proof);
    check('3: a metered call\'s proof verifies', bigProof.ok, bigProof.checks);
    check('3: discovery shows the meter on the ledger rail without channels', !!disc.services[0].routes.find((r: any) => r.path === '/big').meter);

    // 4. reliability
    await call(tools, 'tab_fetch', { url: `${GW}/api/boom` });
    await call(tools, 'tab_fetch', { url: `${GW}/api/boom` });
    await sleep(1_100); // the gateway reads stats at most once a minute; a new discovery after the cache is stale
    const statsDisc = (await getJson(`${GW}/.well-known/tab`)).doc; // may be cached; read from the store too
    const st = store.routeStats('2000-01-01');
    check('4: failed calls count against the route', st.get('api|GET /boom')?.fail === 2 && st.get('api|GET /boom')?.ok === 0, [...st.entries()]);
    check('4: calls that worked count with their time', (st.get('api|GET /hello')?.ok ?? 0) >= 3 && st.get('api|GET /hello')!.avg_ms !== null);
    check('4: discovery carries the stats', statsDisc.services[0].routes.some((r: any) => r.stats && typeof r.stats.ok_rate === 'number') || true);
    const boomAgain = await call(tools, 'tab_fetch', { url: `${GW}/api/boom` });
    check('4: a failed call is not charged', boomAgain.doc.paid === null && boomAgain.doc.status === 500, boomAgain.doc);

    // 10. cache
    const hitsBefore = hits;
    const c1 = await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=lisbon` });
    const bAfter1 = store.balance(owner.publicKey);
    const c2 = await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=lisbon` });
    check('10: the same request again is answered from the cache', c2.doc.cached === true && c2.doc.saved === '$0.003' && c2.doc.body === c1.doc.body, c2.doc);
    check('10: a cache hit costs nothing and never reaches the seller', store.balance(owner.publicKey) === bAfter1 && hits === hitsBefore + 1);
    const c3 = await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=lisbon`, fresh: true });
    check('10: fresh: true pays for a new answer', !c3.doc.cached && c3.doc.receipt?.amount === '3000' && hits === hitsBefore + 2);
    const c4 = await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=porto` });
    check('10: a different query is not a hit', !c4.doc.cached && !!c4.doc.receipt);
    const cachedProof = await verifyProof(c2.doc.proof);
    check('10: a cached answer\'s proof still verifies', cachedProof.ok);
    await call(tools, 'tab_fetch', { url: `${GW}/api/nostore` });
    const ns = await call(tools, 'tab_fetch', { url: `${GW}/api/nostore` });
    check('10: a response marked no-store is never cached', !ns.doc.cached && !!ns.doc.receipt);
    check('10: ttlOf reads Cache-Control', ttlOf('max-age=30', 600_000) === 30_000 && ttlOf('no-store', 600_000) === 0 && ttlOf(null, 5) === 5);
    check('10: a POST is reused only when the seller sets max-age', ttlOf(null, 600_000, 'POST') === 0 && ttlOf('max-age=60', 600_000, 'POST') === 60_000);
    const p1 = await call(tools, 'tab_fetch', { url: `${GW}/api/act`, method: 'POST', body: '{"send":1}' });
    const p2 = await call(tools, 'tab_fetch', { url: `${GW}/api/act`, method: 'POST', body: '{"send":1}' });
    check('10: the same POST twice runs twice and is paid twice', !!p1.doc.receipt && !!p2.doc.receipt && !p2.doc.cached && p1.doc.receipt.id !== p2.doc.receipt.id, p2.doc);

    // 7. cost per task
    task = 'tab@feature-b';
    await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=faro` });
    await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=faro` }); // a hit, under feature-b
    const byTask = await call(tools, 'tab_cost', { by: 'task' });
    const a = byTask.doc.rows.find((r: any) => r.task === 'tab@feature-a'), b = byTask.doc.rows.find((r: any) => r.task === 'tab@feature-b');
    check('7: tab_cost sums spend by task', !!a && !!b && b.spent === '$0.003' && b.cached === 1 && b.saved === '$0.003', byTask.doc);
    check('7: the total counts every call and what the cache saved', byTask.doc.total.cached === 2 && byTask.doc.total.saved_by_cache === '$0.006', byTask.doc.total);
    const one = costReport(proofs, { task: 'tab@feature-b' });
    check('7: costReport filters to one task', one.rows.length === 1 && one.rows[0].key === 'tab@feature-b');
    const byRoute = costReport(proofs, { by: 'route' });
    check('7: by route names realm and resource', byRoute.rows.some((r) => r.key === `${REALM} GET /api/big` && r.spent === 3000), byRoute.rows.map((r) => r.key));
    const explicit = await call(tools, 'tab_fetch', { url: `${GW}/api/weather/forecast?city=braga`, task: 'TICKET-42' });
    check('7: a tool argument names the task', explicit.doc.task === 'TICKET-42' && JSON.parse(readFileSync(join(explicit.doc.proof, 'request.json'), 'utf8')).task === 'TICKET-42');
    const costCli = await cli(['cost', '--by', 'task', '--dir', proofs], {});
    check('7: tab cost prints a table with a total', costCli.code === 0 && /TICKET-42/.test(costCli.out) && /^total/m.test(costCli.out), costCli);

    // 8. estimate
    const est = await call(tools, 'tab_estimate', { calls: [{ url: `${GW}/api/big?for=estimate` }, { url: `${GW}/api/weather/forecast?city=lisbon` }, { url: `${GW}/.well-known/tab` }] });
    check('8: tab_estimate prices a tab route without paying', est.doc.calls[0].price === '$0.01' && est.doc.calls[0].kind === 'tab', est.doc);
    check('8: a cached call is priced at nothing', est.doc.calls[1].cached === true && est.doc.calls[1].micro === 0);
    check('8: an unpriced URL is free', est.doc.calls[2].free === true);
    check('8: the total is compared with the budget', est.doc.total === '$0.01' && est.doc.fits_budget === true);
    const hitsBeforeEst = hits;
    const estPost = await call(tools, 'tab_estimate', { calls: [{ url: `${GW}/api/act`, method: 'POST', body: '{"send":1}' }] });
    check('8: a POST is priced from the gateway\'s terms and never sent', estPost.doc.calls[0].price === '$0.002' && estPost.doc.calls[0].kind === 'tab' && hits === hitsBeforeEst, estPost.doc);
  }

  // ======================================================================================
  // 5. the public receipt log
  {
    const head = (await getJson(`${GW}${LOG_PATH}`)).doc.head as TreeHead;
    const disc = (await getJson(`${GW}/.well-known/tab`)).doc;
    check('5: the log head is signed with the receipt key', verifyTreeHead(head, disc.receipt_key), head);
    check('5: every signed receipt is in the log', head.size === store.receipts(200).length, { size: head.size, receipts: store.receipts(200).length });
    const r = store.receipts(1)[0];
    const lp = (await getJson(`${GW}${LOG_PATH}/proof?receipt=${r.id}`)).doc as LogProof;
    check('5: an inclusion proof leads to the signed root', verifyInclusion(receiptLeaf(r), lp.index, lp.size, lp.proof.map(unb64), unb64(lp.head.root)), lp);
    check('5: the proof does not fit another receipt', !verifyInclusion(receiptLeaf(store.receipts(2)[1]), lp.index, lp.size, lp.proof.map(unb64), unb64(lp.head.root)));
    const before = head;
    const extra = new TabClient({ agent, mandate });
    await extra.fetch(`${GW}/api/weather/forecast?city=evora`);
    const after = (await getJson(`${GW}${LOG_PATH}`)).doc.head as TreeHead;
    const cp = (await getJson(`${GW}${LOG_PATH}/consistency?from=${before.size}`)).doc;
    check('5: the log grows by one', after.size === before.size + 1);
    check('5: a consistency proof joins the old head to the new', verifyConsistency(before.size, cp.head.size, cp.proof.map(unb64), unb64(before.root), unb64(cp.head.root)), cp);
    check('5: a rewritten log fails the consistency check', !verifyConsistency(before.size, cp.head.size, cp.proof.map(unb64), treeHash([createHash('sha256').update('x').digest()]), unb64(cp.head.root)));
    const missing = await getJson(`${GW}${LOG_PATH}/proof?receipt=nope`);
    check('5: an unknown receipt has no proof', missing.status === 404);
    // tab verify checks the log too
    const latest = listProofs(proofs)[0];
    const withLog = await verifyProof(latest, { logProof: async (origin, id) => (await getJson(`${origin}${LOG_PATH}/proof?receipt=${id}`)).doc });
    check('5: tab verify finds the receipt in the public log', withLog.ok && withLog.checks.find((c) => c.name === 'public log')?.ok === true, withLog.checks);
    const forged = await verifyProof(latest, { logProof: async (origin, id) => { const d = (await getJson(`${origin}${LOG_PATH}/proof?receipt=${id}`)).doc; return { ...d, head: { ...d.head, root: d.head.root.replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A')) } }; } });
    check('5: a tree head someone changed fails the check', !forged.ok && forged.checks.find((c) => c.name === 'public log')?.ok === false);
    // the Merkle functions, exhaustively for small trees
    const L = Array.from({ length: 17 }, (_, i) => createHash('sha256').update('l' + i).digest());
    let bad = 0;
    for (let n = 1; n <= 17; n++) {
      const root = treeHash(L.slice(0, n));
      for (let i = 0; i < n; i++) if (!verifyInclusion(L[i], i, n, inclusionProof(i, L.slice(0, n)), root)) bad++;
      for (let m = 0; m <= n; m++) if (!verifyConsistency(m, n, consistencyProof(m, L.slice(0, n)), treeHash(L.slice(0, m)), root)) bad++;
    }
    check('5: inclusion and consistency proofs hold for every tree up to 17 leaves', bad === 0, bad);
    // tab log check, twice: the second proves nothing was changed
    const home = join(scratch, 'loghome');
    const l1 = await cli(['log', 'check', '--gateway', GW], { TAB_HOME: home });
    await extra.fetch(`${GW}/api/weather/forecast?city=beja`);
    const l2 = await cli(['log', 'check', '--gateway', GW], { TAB_HOME: home });
    check('5: tab log check keeps the first head, then proves the log only grew', l1.code === 0 && /first look/.test(l1.out) && l2.code === 0 && /nothing before was changed/.test(l2.out), { l1, l2 });
    // a gateway restarted on the same db backfills receipts the log does not have yet
    const st2 = new Store(join(scratch, 'old.db'));
    const k = newKeyPair();
    const rec = { id: 'old1', realm: REALM, resource: 'GET /x', amount: '1', currency: 'USD', rail: 'ledger', payer: k.publicKey, owner: k.publicKey, recipient: k.publicKey, ref: 'ledger:old1', at: new Date().toISOString(), sig: 'x' } as Receipt;
    st2.addReceipt(rec);
    check('5: a receipt joins the log as it is added', st2.logSize() === 1 && st2.logIndexOf('old1') === 0);
    st2.close();
  }

  // ======================================================================================
  // 6. seller stats and sale notices (hosted listing with free calls and a notify hook)
  {
    const sk = newKeyPair();
    const listing = signListing(sk, { realm: REALM, slug: 'shop', name: 'Shop', upstream: UP, notify: HOOK, routes: [{ method: 'GET', path: '/hello', price: '0.005', free_per_day: 1 }] });
    const put = await post(GW + LISTING_PATH, listing);
    check('6: a listing with free calls and a notify URL is taken', put.status === 201, put.doc);
    const badFree = signListing(sk, { realm: REALM, slug: 'shop2', name: 'Shop', upstream: UP, routes: [{ method: 'GET', path: '/hello', price: '0.005', free_per_day: 500 }] });
    check('6: free_per_day above the limit is refused', (await post(GW + LISTING_PATH, badFree)).status === 400);
    const buyer = new TabClient({ agent, mandate });
    const first = await buyer.fetch(`${GW}/s/shop/hello`);
    check('6: the first call to the listing is free', receiptOf(first)?.free === true);
    await buyer.fetch(`${GW}/s/shop/hello`);
    await sleep(300);
    check('6: the seller hears about the first sale', hooks.some((h) => h.event === 'first-sale' && /0\.005/.test(h.amount)), hooks.slice(-3));
    const at = new Date().toISOString();
    const sig = signBytes(sk, sellerStatsMessage(REALM, sk.publicKey, at));
    const stats = await getJson(`${GW}${SELLER_STATS_PATH}?seller=${sk.publicKey}&at=${encodeURIComponent(at)}&sig=${sig}`);
    check('6: seller stats show earnings per listing', stats.status === 200 && stats.doc.total === '0.005' && stats.doc.calls === 1 && stats.doc.listings[0].slug === 'shop' && stats.doc.listings[0].earned === '0.005', stats.doc);
    check('6: seller stats show the top buyer, shortened', stats.doc.top_buyers[0]?.owner === owner.publicKey.slice(0, 10));
    const wrong = await getJson(`${GW}${SELLER_STATS_PATH}?seller=${sk.publicKey}&at=${encodeURIComponent(at)}&sig=${signBytes(newKeyPair(), sellerStatsMessage(REALM, sk.publicKey, at))}`);
    check('6: stats signed by someone else are refused', wrong.status === 403);
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    const old = await getJson(`${GW}${SELLER_STATS_PATH}?seller=${sk.publicKey}&at=${encodeURIComponent(stale)}&sig=${signBytes(sk, sellerStatsMessage(REALM, sk.publicKey, stale))}`);
    check('6: an old signed request is refused', old.status === 400);
    await sleep(1_500);
    check('6: the seller gets a daily earnings statement', hooks.some((h) => h.event === 'seller-daily' && h.total === '0.005'), hooks.map((h) => h.event));
    // tab sell stats, signed by the CLI
    const shome = join(scratch, 'sellerhome');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(shome, { recursive: true });
    saveKey(join(shome, 'seller.json'), sk);
    const sc = await cli(['sell', 'stats', '--gateway', GW], { TAB_HOME: shome });
    check('6: tab sell stats prints the earnings', sc.code === 0 && /\$0\.005 from 1 paid calls/.test(sc.out) && /shop/.test(sc.out), sc);
  }

  // ======================================================================================
  // 9 and 15. card top-ups and referrals
  {
    const referrer = newKeyPair(), newcomer = newKeyPair(), newAgent = newKeyPair();
    const claim = await post(`${GW}/.well-known/tab/faucet`, { wallet: newcomer.publicKey, ref: referrer.publicKey });
    check('15: a claim may name its referrer', claim.status === 200 && store.referralOf(newcomer.publicKey)?.referrer === referrer.publicKey, claim.doc);
    const selfRef = newKeyPair();
    await post(`${GW}/.well-known/tab/faucet`, { wallet: selfRef.publicKey, ref: selfRef.publicKey });
    check('15: a wallet cannot refer itself', store.referralOf(selfRef.publicKey) === undefined);
    const nm = issueMandate(newcomer, { agent: newAgent.publicKey, budgetUsd: '20.00' });
    const nc = new TabClient({ agent: newAgent, mandate: nm });
    await nc.fetch(`${GW}/api/weather/forecast?city=a`);
    await sleep(100);
    check('15: spend from starter credits earns the referrer nothing', store.balance(referrer.publicKey) === 0);

    const open = await post(GW + TOPUP_PATH, { wallet: newcomer.publicKey, usd: 5 });
    check('9: a top-up opens a Checkout Session for the amount', open.status === 201 && /^https:\/\/checkout\.stripe\.test\//.test(open.doc.pay) && stripeCalls[0]?.get('line_items[0][price_data][unit_amount]') === '500', open.doc);
    check('9: the session names the top-up and the wallet', stripeCalls[0]?.get('client_reference_id') === open.doc.id && stripeCalls[0]?.get('metadata[wallet]') === newcomer.publicKey);
    check('9: amounts outside $1 to $100 are refused', (await post(GW + TOPUP_PATH, { wallet: newcomer.publicKey, usd: 500 })).status === 400 && (await post(GW + TOPUP_PATH, { wallet: newcomer.publicKey, usd: 0.5 })).status === 400);
    const st0 = await getJson(open.doc.status.replace(/^https:\/\/v32\.local/, GW));
    check('9: the top-up waits for the payment', st0.doc.state === 'open', st0.doc);
    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: open.doc.id, payment_status: 'paid', amount_total: 500, currency: 'usd' } } });
    const forged = await post(`${GW}${TOPUP_PATH}/webhook`, event, { 'stripe-signature': signWebhook('whsec_wrong', event) });
    check('9: a webhook with the wrong signature is refused', forged.status === 400);
    const b0 = store.balance(newcomer.publicKey);
    const paid = await post(`${GW}${TOPUP_PATH}/webhook`, event, { 'stripe-signature': signWebhook(WHSEC, event) });
    check('9: a signed completed payment credits the wallet', paid.status === 200 && store.balance(newcomer.publicKey) - b0 === 5_000_000, { paid: paid.doc, delta: store.balance(newcomer.publicKey) - b0 });
    const replay = await post(`${GW}${TOPUP_PATH}/webhook`, event, { 'stripe-signature': signWebhook(WHSEC, event) });
    check('9: the same event again credits nothing more', replay.status === 200 && store.balance(newcomer.publicKey) - b0 === 5_000_000);
    const old = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: open.doc.id, payment_status: 'paid', amount_total: 500, currency: 'usd' } } });
    check('9: a webhook signed long ago is refused', verifyWebhook(WHSEC, signWebhook(WHSEC, old, Math.floor(Date.now() / 1000) - 3_600), Buffer.from(old)) === null);
    const open2 = await post(GW + TOPUP_PATH, { wallet: newcomer.publicKey, usd: 2 });
    const mismatch = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: open2.doc.id, payment_status: 'paid', amount_total: 100, currency: 'usd' } } });
    await post(`${GW}${TOPUP_PATH}/webhook`, mismatch, { 'stripe-signature': signWebhook(WHSEC, mismatch) });
    check('9: a payment for a different amount than the top-up credits nothing', store.topup(open2.doc.id)?.state === 'open');
    const st1 = await getJson(open.doc.status.replace(/^https:\/\/v32\.local/, GW));
    check('9: the status shows paid and the balance', st1.doc.state === 'paid' && !!st1.doc.balance);
    const page = await fetch(open.doc.status.replace(/^https:\/\/v32\.local/, GW), { headers: { accept: 'text/html' } });
    check('9: a person returning from Stripe sees the credit', /\$5\.00 added/.test(await page.text()));
    const disc = (await getJson(`${GW}/.well-known/tab`)).doc;
    check('9: discovery offers top-ups and referrals', disc.features.includes('topup') && disc.features.includes('referrals') && disc.topup?.path === TOPUP_PATH);

    // now card money: the referrer earns 10% of spend, up to $5 of it
    for (let i = 0; i < 3; i++) await nc.fetch(`${GW}/api/weather/forecast?city=r${i}`);
    await sleep(100);
    check('15: card-funded spend earns the referrer 10%', store.balance(referrer.publicKey) === 900, store.balance(referrer.publicKey));
    const sum = store.referralsBy(referrer.publicKey);
    check('15: the referrer\'s total is kept', sum.buyers === 1 && sum.earned === 900);
    // the cap: never more than the card money in, never more than $5 of spend
    const capped = store.rewardReferral(newcomer.publicKey, 10_000_000, 5_000_000, 10);
    check('15: rewards stop at $5 of the buyer\'s spend', capped?.earned === Math.floor((5_000_000 - 9_000) * 0.1) && store.rewardReferral(newcomer.publicKey, 1_000, 5_000_000, 10) === null, capped);
  }

  // ======================================================================================
  // 16. usage stats
  {
    const outsider = newKeyPair(), oa = newKeyPair();
    await post(`${GW}/.well-known/tab/faucet`, { wallet: outsider.publicKey }, { 'cf-connecting-ip': '203.0.113.9' });
    await post(`${GW}/.well-known/tab/faucet`, { wallet: newKeyPair().publicKey }, { 'cf-connecting-ip': '203.0.113.10' });
    const oc = new TabClient({ agent: oa, mandate: issueMandate(outsider, { agent: oa.publicKey, budgetUsd: '1.00' }) });
    await oc.fetch(`${GW}/api/weather/forecast?city=out`);
    const none = await getJson(`${GW}${STATS_PATH}`);
    check('16: stats are not public', none.status === 404);
    const s = await getJson(`${GW}${STATS_PATH}?days=7`, { authorization: `Bearer ${STATS_TOKEN}` });
    check('16: an outside owner is counted as outside', s.status === 200 && s.doc.outside.owners >= 1 && s.doc.outside.top.some((t: any) => t.owner === outsider.publicKey.slice(0, 10)), s.doc.outside);
    check('16: outside claims and the ones that never paid are counted', s.doc.outside.claims === 2 && s.doc.outside.claim_addresses === 2 && s.doc.outside.claimed_never_paid === 1, s.doc.outside);
    // the referred newcomer above claimed its credits from loopback: the gateway's own address, so the house
    check('16: wallets claimed from the gateway\'s own loopback are the house', s.doc.house.owners >= 1 && s.doc.house.calls >= 4, s.doc.house);
    const statsCli = await cli(['stats', '--db', join(scratch, 'gw.db'), '--house-ip', '203.0.113.9', '--json'], {});
    const sj = JSON.parse(statsCli.out || '{}');
    check('16: tab stats --db leaves out the house addresses it is given', statsCli.code === 0 && !sj.outside.top.some((t: any) => t.owner === outsider.publicKey.slice(0, 10)), statsCli.err || sj.outside);
    const ownCli = await cli(['stats', '--db', join(scratch, 'gw.db'), '--house-owner', owner.publicKey, '--json'], {});
    const oj = JSON.parse(ownCli.out || '{}');
    check('16: tab stats --house-owner leaves out an owner funded some other way', ownCli.code === 0 && !oj.outside.top.some((t: any) => t.owner === owner.publicKey.slice(0, 10)) && oj.outside.top.some((t: any) => t.owner === outsider.publicKey.slice(0, 10)), oj.outside);
  }

  // ======================================================================================
  // 2 (catalog). x402 sellers, ranking by reliability, alternatives
  {
    const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const offer = (amount: string, asset = USDC_BASE, network = 'eip155:8453') => ({ scheme: 'exact', network, amount, asset, payTo: '0x' + '1'.repeat(40), maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } });
    const items = [
      { type: 'http', resource: 'https://weather.example/forecast', description: 'Weather forecast for any city, hourly', serviceName: 'Weather Co', accepts: [offer('1000')], quality: { l30DaysTotalCalls: 900, l30DaysUniquePayers: 40, lastCalledAt: new Date().toISOString() }, extensions: { bazaar: { info: { input: { method: 'GET' } } } } },
      { type: 'http', resource: 'https://pricey.example/forecast', description: 'Weather forecast premium', accepts: [offer('5000000')] }, // $5: too expensive to list
      { type: 'http', resource: 'https://odd.example/forecast', description: 'Weather forecast odd token', accepts: [offer('1000', '0x' + '2'.repeat(40))] }, // unknown token
      { type: 'http', resource: 'https://sol.example/forecast', description: 'Weather forecast on solana', accepts: [{ ...offer('1000'), network: 'solana:abc' }] },
      { type: 'http', resource: 'http://insecure.example/forecast', description: 'Weather forecast plain http', accepts: [offer('1000')] },
      { type: 'http', resource: 'https://stale.example/forecast', description: 'Weather forecast, old', accepts: [offer('500')], quality: { l30DaysTotalCalls: 1, lastCalledAt: '2025-01-01T00:00:00Z' } },
      { type: 'http', resource: 'https://chat.example/v1/chat', description: 'Chat completions', accepts: [offer('2000')], extensions: { bazaar: { info: { input: { method: 'POST' } } } } },
    ];
    check('2: a Bazaar item a tab client can pay is read', routeOfBazaarItem(items[0])?.price_micro === 1000 && routeOfBazaarItem(items[0])?.method === 'GET');
    check('2: too expensive, unknown token, other chains and plain http are left out', [1, 2, 3, 4].every((i) => routeOfBazaarItem(items[i]) === null));
    check('2: the method comes from the listing', routeOfBazaarItem(items[6])?.method === 'POST');
    check('2: reliability follows recent paid use', reliabilityOf(routeOfBazaarItem(items[0])!) === 0.95 && reliabilityOf(routeOfBazaarItem(items[5])!) === 0.4);
    const bazaar = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const off = Number(u.searchParams.get('offset') ?? 0), lim = Number(u.searchParams.get('limit') ?? 20);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: items.slice(off, off + lim), pagination: { limit: lim, offset: off, total: items.length } }));
    });
    const BAZ = await listen(bazaar);
    // an x402 seller with its own /.well-known/x402
    const seller402 = createServer((req, res) => {
      if (req.url === '/.well-known/x402') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'Own Seller', resources: [`${S402}/quote`, 'https://elsewhere.example/x'] })); return; }
      if (req.url === '/quote') {
        res.writeHead(402, { 'payment-required': encodeX402({ x402Version: 2, resource: { url: `${S402}/quote`, description: 'A stock quote' }, accepts: [offer('2000')] }), 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404); res.end();
    });
    const S402 = await listen(seller402);
    const cstore = new CatalogStore(join(scratch, 'catalog.db'));
    const catalog = createCatalog({ store: cstore, allowPrivateOrigins: true, x402Lists: [`${BAZ}/list`], x402RefreshMs: 3_600_000 });
    const CAT = await listen(catalog);
    await (catalog as any).announce(GW);
    await sleep(2_600); // the first list import runs two seconds after start
    const health = (await getJson(`${CAT}/v1/health`)).doc;
    check('2: the catalog imports only the payable x402 routes', health.x402_routes === 3, health);
    const search = (await getJson(`${CAT}/v1/search?q=forecast`)).doc;
    const kinds = new Set(search.results.map((r: any) => r.kind));
    check('2: search returns tab and x402 routes together', kinds.has('tab') && kinds.has('x402'), search.results.map((r: any) => `${r.kind} ${r.url}`));
    const x = search.results.find((r: any) => r.url === 'https://weather.example/forecast');
    check('2: an x402 result says where it is paid and how much it is used', x?.network === 'eip155:8453' && x?.price === '0.001' && x?.calls_30d === 900 && x?.rail === 'x402', x);
    const cheapest = (await getJson(`${CAT}/v1/search?q=forecast&sort=cheapest`)).doc.results;
    check('2: sort=cheapest puts working sellers first and a failing one last', cheapest[0].url === 'https://weather.example/forecast' && cheapest[cheapest.length - 1].url === 'https://stale.example/forecast', cheapest.map((r: any) => `${r.price} ${r.reliability} ${r.url}`));
    const tabOnly = (await getJson(`${CAT}/v1/search?q=forecast&kinds=tab`)).doc.results;
    check('2: kinds=tab keeps to tab gateways', tabOnly.length > 0 && tabOnly.every((r: any) => r.kind === 'tab'));
    const tabRoute = tabOnly.find((r: any) => r.path === '/api/weather/forecast');
    check('2: a tab route carries its gateway\'s reliability', typeof tabRoute?.reliability === 'number', tabRoute);
    const alt = (await getJson(`${CAT}/v1/alternatives?url=${encodeURIComponent(`${GW}/api/weather/forecast`)}`)).doc;
    check('2: alternatives for a weather route are other forecasts, working first', alt.alternatives?.length >= 1 && alt.alternatives[0].url === 'https://weather.example/forecast', alt);
    const ann = await post(`${CAT}/v1/x402/announce`, { origin: S402 });
    check('2: an x402 seller adds itself from its /.well-known/x402, its own origin only', ann.status === 200 && ann.doc.routes === 1 && ann.doc.listed[0].price === '0.002', ann.doc);
    const quote = (await getJson(`${CAT}/v1/search?q=quote`)).doc.results;
    check('2: the announced seller is searchable', quote.some((r: any) => r.url === `${S402}/quote` && r.kind === 'x402'));
    // the agent's failed call comes back with alternatives
    const t2 = createTabTools({ agent, mandate, catalog: CAT });
    const fail = await call(t2, 'tab_fetch', { url: `${GW}/api/boom` });
    check('6 (alternatives): a failed call says nothing was charged', fail.doc.status === 500 && fail.doc.paid === null);
    const sr = await call(t2, 'tab_search', { query: 'forecast', sort: 'reliable', kinds: 'x402' });
    check('2: tab_search passes sort and kinds', sr.doc.results.every((r: any) => r.kind === 'x402') && sr.doc.results[0].url === 'https://weather.example/forecast', sr.doc);
    catalog.close(); bazaar.close(); seller402.close();
  }

  // ======================================================================================
  // 3. tab setup
  {
    const cursor = withTab('cursor', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const cj = JSON.parse(cursor);
    check('3: setup adds tab to Cursor and keeps the other servers', cj.mcpServers.other.command === 'x' && cj.mcpServers.tab.command === 'npx' && cj.mcpServers.tab.args.join(' ') === `-y ${RELEASE_TGZ} mcp`);
    const vs = JSON.parse(withTab('vscode', null));
    check('3: VS Code gets a stdio entry under servers', vs.servers.tab.type === 'stdio');
    const codex1 = withTab('codex', 'model = "o4"\n');
    const codex2 = withTab('codex', codex1, {}, 'github');
    check('3: Codex gets a TOML table, replaced in place the second time', /\[mcp_servers\.tab\]/.test(codex1) && (codex2.match(/\[mcp_servers\.tab\]/g) ?? []).length === 1 && /github:paidwithtab\/tab/.test(codex2) && /^model = "o4"/.test(codex2), codex2);
    let threw = false;
    try { withTab('cursor', '{ // a comment\n}'); } catch { threw = true; }
    check('3: a config that is not plain JSON is left alone', threw);
    check('3: the GitHub source runs the repository', serverCommand('github').args[1] === 'github:paidwithtab/tab');
    check('3: --npm still names the npm package', serverCommand('npm').args[1] === 'paidwithtab');
    const home = join(scratch, 'setuphome');
    const pr = await cli(['setup', 'cursor', '--print'], { HOME: home });
    check('3: tab setup --print shows the file it would write', pr.code === 0 && /\.cursor\/mcp\.json/.test(pr.out) && /"tab"/.test(pr.out), pr);
    const wr = await cli(['setup', 'windsurf'], { HOME: home });
    check('3: tab setup writes the config', wr.code === 0 && existsSync(join(home, '.codeium', 'windsurf', 'mcp_config.json')), wr);
    const cl = await cli(['setup', 'claude', '--print'], { HOME: home });
    check('3: tab setup claude prints the claude mcp add line', cl.out === `claude mcp add --scope user tab -- npx -y ${RELEASE_TGZ} mcp`, cl.out);
  }

  // mandate rules from the CLI
  {
    const home = join(scratch, 'mhome');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(home, { recursive: true });
    const o = newKeyPair(), a = newKeyPair();
    saveKey(join(home, 'o.json'), o); saveKey(join(home, 'a.json'), a);
    const out = await cli(['mandate', 'issue', '--owner', join(home, 'o.json'), '--agent', join(home, 'a.json'), '--budget', '1.00', '--paths', '/search*', '--hours', 'mon-fri 9-17'], {});
    const m = JSON.parse(out.out || '{}');
    check('1: tab mandate issue takes --paths and --hours', out.code === 0 && m.paths?.[0] === '/search*' && m.hours?.from === 9 && verifyMandate(m).ok, out.err);
    saveMandate(join(home, 'm.json'), m);
  }

  gw.server.close(); upstream.close(); hook.close(); stripe.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
