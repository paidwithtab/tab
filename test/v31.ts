// tab 3.1 end to end, on the ledger rail, in one process on random ports with temp SQLite files:
// the MCP server setting itself up on first launch, proof folders and tab verify, hosted listings
// paid to the seller's own wallet (and every way a listing is refused), MCP servers sold per tool
// call, and spend alerts with a daily statement.
//   npm run test:v31

import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newKeyPair } from '../src/keys.js';
import { usdToMicro, parseChallengeHeader, encodeReceiptHeader } from '../src/protocol.js';
import { issueMandate } from '../src/mandate.js';
import { Store } from '../src/store.js';
import { createGateway, type Spec } from '../src/gateway.js';
import { TabClient, receiptOf } from '../src/client.js';
import { createTabTools } from '../src/tools.js';
import { signListing, LISTING_PATH, type Listing } from '../src/listings.js';
import { signAlertSub, ALERTS_PATH } from '../src/alerts.js';
import { verifyProof, listProofs } from '../src/proof.js';
import { connectTools, serveMcpHttp, listMcpTools } from '../src/mcp-bridge.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-v31-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
const gatewayAt = async (spec: Spec, o: Omit<Parameters<typeof createGateway>[1], 'origin'>): Promise<{ server: Server; url: string }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = createGateway(spec, { ...o, origin: url });
  await new Promise<void>((r) => server.listen(port, () => r()));
  return { server, url };
};
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, doc: (await r.json().catch(() => ({}))) as any };
};

/** Run the CLI with stdin, and collect what it printed. */
function cli(args: string[], env: Record<string, string>, input = ''): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code: code ?? 1 }));
    p.stdin.end(input);
  });
}

async function main(): Promise<void> {
  // -- an upstream API and a webhook that records what it gets --------------------------
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (s: number, d: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/hello') return send(200, { hello: 'world', q: u.search });
    if (u.pathname === '/echo') return send(200, { echo: body });
    if (u.pathname === '/quote') return send(200, { quote: 'q' });
    if (u.pathname === '/penny') return send(200, { penny: 1 });
    send(404, { error: 'no' });
  });
  const upPort = await freePort();
  await new Promise<void>((r) => upstream.listen(upPort, '127.0.0.1', () => r()));
  const UP = `http://127.0.0.1:${upPort}`;

  const hooks: any[] = [];
  const hook = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    try { hooks.push({ ...JSON.parse(body), _title: req.headers.title }); } catch { hooks.push({ text: body, _title: req.headers.title, _format: 'text' }); }
    res.writeHead(200); res.end('ok');
  });
  const hookPort = await freePort();
  await new Promise<void>((r) => hook.listen(hookPort, '127.0.0.1', () => r()));
  const HOOK = `http://127.0.0.1:${hookPort}/hook`;

  // -- the gateway: its own routes, plus hosted listings and alerts ----------------------
  const operator = newKeyPair();
  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  const store = new Store(join(scratch, 'gw.db'));
  store.credit(owner.publicKey, usdToMicro('5.00'));
  const REALM = 'gw.test';
  const spec: Spec = { realm: REALM, recipient: operator.publicKey, channels: { min_deposit: '0.05' }, services: [{ name: 'own', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/quote', price: '0.05' }, { method: 'GET', path: '/penny', price: '0.01' }] }] };
  const gw = await gatewayAt(spec, { store, faucetUsd: '1.00', listings: true, alerts: true, allowPrivateEgress: true, egressFetch: fetch, listingRatePerMinute: 60_000, statementCheckMs: 300, statementPeriodMs: 2500 });
  const GW = gw.url;
  const mandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '2.00', window: 'day', allow: ['*'] });
  const client = new TabClient({ agent, mandate });

  // -- 1. the MCP server sets itself up on first launch ----------------------------------
  {
    const home = join(scratch, 'home1');
    const env = { TAB_HOME: home, TAB_GATEWAY: GW, TAB_AGENT: '', TAB_MANDATE: '' };
    const handshake = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n';
    const first = await cli(['mcp'], env, handshake);
    const lines = first.out.split('\n').filter(Boolean);
    check('1: first launch with nothing set up writes a mandate', existsSync(join(home, 'mandate.json')), first);
    check('1: and claims the starter credits, telling stderr', /credits\s+1\.00 starter credits/.test(first.err), first.err);
    check('1: stdout stays pure JSON-RPC while it sets up', lines.length === 2 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), lines);
    check('1: and serves the tools', lines.length === 2 && JSON.parse(lines[1]).result.tools.some((t: { name: string }) => t.name === 'tab_fetch'), lines[1]);
    check('1: the owner really got the credits', store.balance(JSON.parse(readFileSync(join(home, 'owner.json'), 'utf8')).publicKey) === usdToMicro('1.00'));
    const second = await cli(['mcp'], env, handshake);
    check('1: the second launch reuses what is there', !/owner key/.test(second.err) && second.out.split('\n').filter(Boolean).length === 2, second.err);
  }

  // -- 2. hosted listings ----------------------------------------------------------------
  const listing = signListing(seller, {
    realm: REALM, slug: 'hello-api', name: 'Hello API', description: 'says hello', upstream: UP,
    routes: [{ method: 'GET', path: '/hello', price: '0.02' }, { method: 'POST', path: '/echo', price: '0.03' }],
  });
  const added = await post(GW + LISTING_PATH, listing);
  check('2: a signed listing is taken', added.status === 201 && added.doc.url === `${GW}/s/hello-api` && added.doc.paid_to === seller.publicKey, added);
  const disc = await (await fetch(GW + '/.well-known/tab')).json() as any;
  const hosted = disc.services.find((s: any) => s.prefix === '/s/hello-api');
  check('2: discovery lists it, naming who is paid', hosted && hosted.recipient === seller.publicKey && hosted.hosted?.seller === seller.publicKey && disc.features.includes('listings'), hosted);
  const listed = await (await fetch(GW + LISTING_PATH)).json() as any;
  check('2: GET listings shows it', listed.listings.length === 1 && listed.listings[0].slug === 'hello-api' && listed.listings[0].routes === 2, listed);

  const bare = await fetch(GW + '/s/hello-api/hello');
  const chal = parseChallengeHeader(bare.headers.get('www-authenticate'));
  check('2: the challenge names the seller as recipient', bare.status === 402 && chal?.recipient === seller.publicKey, chal);
  const opBefore = store.balance(operator.publicKey);
  const r1 = await client.fetch(GW + '/s/hello-api/hello?x=1');
  const b1 = await r1.json() as any;
  const rc1 = receiptOf(r1);
  check('2: a buyer pays and gets the seller\'s answer', r1.status === 200 && b1.hello === 'world' && b1.q === '?x=1', b1);
  check('2: the seller\'s own wallet is paid', store.balance(seller.publicKey) === usdToMicro('0.02') && rc1?.recipient === seller.publicKey, { bal: store.balance(seller.publicKey), rc1 });
  check('2: the operator is not', store.balance(operator.publicKey) === opBefore);
  const r2 = await client.fetch(GW + '/s/hello-api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  check('2: POST routes forward the body', r2.status === 200 && (await r2.json() as any).echo === '{"a":1}' && store.balance(seller.publicKey) === usdToMicro('0.05'));
  const opRoute = await client.fetch(GW + '/penny');
  check('2: the gateway\'s own routes still pay the operator', opRoute.status === 200 && store.balance(operator.publicKey) === opBefore + usdToMicro('0.01'), { status: opRoute.status, before: opBefore, after: store.balance(operator.publicKey) });

  // every way a listing is refused
  const other = newKeyPair();
  const taken = await post(GW + LISTING_PATH, signListing(other, { realm: REALM, slug: 'hello-api', name: 'Mine now', upstream: UP, routes: [{ method: 'GET', path: '/', price: '0.01' }] }));
  check('2: another seller cannot take the slug', taken.status === 409, taken);
  const takeDown = await post(GW + LISTING_PATH, signListing(other, { realm: REALM, slug: 'hello-api', name: '', upstream: '', routes: [], remove: true }));
  check('2: nor take it down', takeDown.status === 409, takeDown);
  check('2: a replayed listing is refused', (await post(GW + LISTING_PATH, listing)).status === 409);
  check('2: a tampered listing is refused', (await post(GW + LISTING_PATH, { ...listing, upstream: 'http://127.0.0.1:1/', at: new Date().toISOString() })).status === 400);
  const wrongRealm = await post(GW + LISTING_PATH, signListing(seller, { realm: 'other.gw', slug: 'x-api', name: 'X', upstream: UP, routes: [{ method: 'GET', path: '/', price: '0.01' }] }));
  check('2: a listing signed for another gateway is refused', wrongRealm.status === 400 && /not gw\.test/.test(wrongRealm.doc.error), wrongRealm);
  const stale = await post(GW + LISTING_PATH, signListing(seller, { realm: REALM, slug: 'old-api', name: 'Old', upstream: UP, routes: [{ method: 'GET', path: '/', price: '0.01' }], at: new Date(Date.now() - 3_600_000).toISOString() }));
  check('2: a listing signed an hour ago is refused', stale.status === 400 && /10 minutes/.test(stale.doc.error), stale);
  for (const [price, label] of [['5.00', 'above 1.00'], ['0.0001', 'below 0.001'], ['0', 'free']] as const) {
    const r = await post(GW + LISTING_PATH, signListing(seller, { realm: REALM, slug: 'p-api', name: 'P', upstream: UP, routes: [{ method: 'GET', path: '/', price }] }));
    check(`2: a price ${label} is refused`, r.status === 400 && /price/.test(r.doc.error), r);
  }
  const notMcp = await post(GW + LISTING_PATH, signListing(seller, { realm: REALM, slug: 't-api', name: 'T', upstream: UP, routes: [{ method: 'POST', path: '/t', price: '0.01', mcp_tool: 't' }] }));
  check('2: mcp_tool without mcp: true is refused', notMcp.status === 400, notMcp);
  const badPath = await post(GW + LISTING_PATH, signListing(seller, { realm: REALM, slug: 'b-api', name: 'B', upstream: UP, routes: [{ method: 'GET', path: '/../admin', price: '0.01' }] }));
  check('2: a route path with a dot segment is refused', badPath.status === 400, badPath);

  // a gateway that guards its egress refuses any upstream that is not public https
  const strictStore = new Store(join(scratch, 'strict.db'));
  const strict = await gatewayAt({ ...spec, realm: 'strict.test', services: [spec.services[0]] }, { store: strictStore, listings: true, alerts: true });
  for (const [up, label] of [[UP, 'http'], ['https://127.0.0.1/api', 'a loopback address'], ['https://10.1.2.3/', 'a private address'], ['https://localhost/', 'localhost'], ['https://user:pw@example.com/', 'credentials'], ['https://strict.test/', 'the gateway itself']] as const) {
    const r = await post(strict.url + LISTING_PATH, signListing(seller, { realm: 'strict.test', slug: 's-api', name: 'S', upstream: up, routes: [{ method: 'GET', path: '/', price: '0.01' }] }));
    check(`2: a strict gateway refuses an upstream that is ${label}`, r.status === 400, r);
  }
  const httpHook = await post(strict.url + ALERTS_PATH, signAlertSub(owner, { realm: 'strict.test', url: 'http://example.com/hook' }));
  check('2: and a webhook that is not https', httpHook.status === 400 && /webhook/.test(httpHook.doc.error), httpHook);
  strict.server.close();

  // a seller has at most five listings
  const busy = newKeyPair();
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await post(GW + LISTING_PATH, signListing(busy, { realm: REALM, slug: `busy-${i}`, name: `Busy ${i}`, upstream: UP, routes: [{ method: 'GET', path: '/hello', price: '0.01' }] }))).status);
  check('2: the sixth listing of one seller is refused', codes.slice(0, 5).every((c) => c === 201) && codes[5] === 429, codes);

  // hosted routes are paid per call with a Tab credential only
  const x402 = await fetch(GW + '/s/hello-api/hello', { headers: { 'payment-signature': 'e30' } });
  check('2: x402 is refused on a hosted listing (it would pay the operator)', x402.status === 400, x402.status);
  const voucher = await fetch(GW + '/s/hello-api/hello', { headers: { authorization: 'TabVoucher abc' } });
  check('2: so is a channel voucher', voucher.status === 402 && /per call/.test((await voucher.json() as any).detail ?? ''), voucher.status);

  // -- 3. proofs and tab verify ------------------------------------------------------------
  const proofDir = join(scratch, 'proofs');
  const tools = createTabTools({ agent, mandate, proofDir });
  const fetched = JSON.parse((await tools.call('tab_fetch', { url: GW + '/s/hello-api/hello?city=lisbon' })).text);
  check('3: tab_fetch keeps a proof folder', typeof fetched.proof === 'string' && existsSync(join(fetched.proof, 'body')) && existsSync(join(fetched.proof, 'mandate.json')), fetched);
  const keyOf = async () => (await (await fetch(GW + '/.well-known/tab')).json() as any).receipt_key as string;
  const good = await verifyProof(fetched.proof, { publishedKey: keyOf });
  check('3: the proof holds, every check ok', good.ok && good.checks.every((c) => c.ok === true), good.checks);
  check('3: listProofs finds it', listProofs(proofDir)[0] === fetched.proof);
  const offline = await verifyProof(fetched.proof);
  check('3: offline, the published key is not compared but the rest holds', offline.ok && offline.checks.find((c) => c.name === 'gateway key')?.ok === null);
  const copy = (name: string) => { const d = join(scratch, name); cpSync(fetched.proof, d, { recursive: true }); return d; };
  const t1 = copy('t-body'); writeFileSync(join(t1, 'body'), '{"hello":"forged"}');
  check('3: a changed body fails', !(await verifyProof(t1)).ok);
  const t2 = copy('t-receipt'); const rc = JSON.parse(readFileSync(join(t2, 'receipt.json'), 'utf8')); rc.amount = '1'; writeFileSync(join(t2, 'receipt.json'), JSON.stringify(rc));
  check('3: a changed receipt fails its signature', (await verifyProof(t2)).checks.find((c) => c.name === 'gateway signature')?.ok === false);
  const t3 = copy('t-request'); const rq = JSON.parse(readFileSync(join(t3, 'request.json'), 'utf8')); rq.url = rq.url.replace('lisbon', 'paris'); writeFileSync(join(t3, 'request.json'), JSON.stringify(rq));
  check('3: a changed request fails', (await verifyProof(t3)).checks.find((c) => c.name === 'request')?.ok === false);
  const t4 = copy('t-mandate'); writeFileSync(join(t4, 'mandate.json'), JSON.stringify(issueMandate(owner, { agent: newKeyPair().publicKey, budgetUsd: '1.00' })));
  check('3: a different mandate fails', (await verifyProof(t4)).checks.find((c) => c.name === 'mandate')?.ok === false);
  check('3: a key other than the published one fails', !(await verifyProof(fetched.proof, { key: newKeyPair().publicKey })).ok);
  const t5 = copy('t-credential'); const rc5 = JSON.parse(readFileSync(join(t5, 'receipt.json'), 'utf8'));
  check('3: the agent\'s own signature authorizes the payment', good.checks.find((c) => c.name === 'agent authorization')?.ok === true && typeof rc5.credential === 'string');
  const verifyCli = await cli(['verify', fetched.proof, '--offline'], {});
  check('3: tab verify prints the checks and exits 0', verifyCli.code === 0 && /proof holds/.test(verifyCli.out) && /agent authorization/.test(verifyCli.out), verifyCli);
  const verifyBad = await cli(['verify', t1, '--offline'], {});
  check('3: and exits 1 on a forged body', verifyBad.code === 1 && /does NOT hold/.test(verifyBad.out), verifyBad);
  void encodeReceiptHeader;

  // -- 4. an MCP server sold per tool call ------------------------------------------------
  const mcpPort = await freePort();
  const mcpHttp = serveMcpHttp({ command: process.execPath, args: ['test/mcp-echo.mjs'], port: mcpPort, host: '127.0.0.1' });
  await sleep(300);
  const MCP = `http://127.0.0.1:${mcpPort}/mcp`;
  const found = await listMcpTools(MCP);
  check('4: tab mcp http puts a stdio server on HTTP, and its tools list', found.map((t) => t.name).join(',') === 'shout,fail', found);
  const sellHome = join(scratch, 'sellhome');
  const sold = await cli(['sell', MCP, '--mcp', '--price', '0.004', '--tool-price', 'shout=0.006', '--name', 'Echo tools', '--gateway', GW], { TAB_HOME: sellHome });
  check('4: tab sell --mcp lists one paid route per tool', sold.code === 0 && /listed at .*\/s\/echo-tools/.test(sold.out) && /tools\/shout\s+0\.006/.test(sold.out) && /tools\/fail\s+0\.004/.test(sold.out), sold);
  const mcpSeller = JSON.parse(readFileSync(join(sellHome, 'seller.json'), 'utf8')).publicKey as string;
  const connected = await connectTools({ url: GW + '/s/echo-tools', agent, mandate, proofDir });
  check('4: tab mcp connect offers the tools with their schemas', connected.list.map((t: any) => t.name).join(',') === 'shout,fail' && (connected.list[0] as any).inputSchema.required?.[0] === 'text', connected.list);
  const shout = await connected.call('shout', { text: 'pay per call' });
  check('4: calling a tool pays the MCP seller and returns its result', !shout.isError && /PAY PER CALL/.test(shout.text) && /paid \$0\.006/.test(shout.text) && store.balance(mcpSeller) === usdToMicro('0.006'), shout);
  const failing = await connected.call('fail', {});
  check('4: a tool that reports an error is not charged', failing.isError === true && /not charged/.test(failing.text) && store.balance(mcpSeller) === usdToMicro('0.006'), failing);
  const badArgs = await client.fetch(GW + '/s/echo-tools/tools/shout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' });
  check('4: arguments that are not an object get a 400 and no charge', badArgs.status === 400 && store.balance(mcpSeller) === usdToMicro('0.006'), badArgs.status);
  const mine = await cli(['sell', 'list', '--gateway', GW], { TAB_HOME: sellHome });
  check('4: tab sell list marks the seller\'s own listing', /echo-tools .*\(yours\)/.test(mine.out), mine.out);
  const removed = await cli(['sell', 'remove', 'echo-tools', '--gateway', GW], { TAB_HOME: sellHome });
  const gone = await fetch(GW + '/s/echo-tools/tools/shout', { method: 'POST' });
  check('4: tab sell remove takes it down', removed.code === 0 && gone.status === 404, { removed, status: gone.status });
  mcpHttp.close();

  // an MCP server that answers over SSE with a session, as remote MCP servers do
  let sessionsSeen = 0;
  const sse = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const m = JSON.parse(body);
    if (m.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {} } })); return; }
    if (m.id === undefined) { res.writeHead(202); res.end(); return; }
    if (req.headers['mcp-session-id'] !== 'S1') { res.writeHead(400); res.end('no session'); return; }
    sessionsSeen++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'from sse' }] } })}\n\n`);
  });
  const ssePort = await freePort();
  await new Promise<void>((r) => sse.listen(ssePort, '127.0.0.1', () => r()));
  const sseListing = signListing(seller, { realm: REALM, slug: 'sse-tools', name: 'SSE', upstream: `http://127.0.0.1:${ssePort}/mcp`, mcp: true, routes: [{ method: 'POST', path: '/tools/hi', price: '0.002', mcp_tool: 'hi' }] });
  check('4: an MCP listing posts', (await post(GW + LISTING_PATH, sseListing)).status === 201);
  const viaSse = await client.fetch(GW + '/s/sse-tools/tools/hi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const sseBody = await viaSse.json() as any;
  check('4: the gateway speaks to an SSE MCP server with its session id', viaSse.status === 200 && sseBody.content?.[0]?.text === 'from sse' && sessionsSeen === 1 && !!receiptOf(viaSse), sseBody);
  sse.close();

  // -- 5. spend alerts -------------------------------------------------------------------
  const owner2 = newKeyPair();
  const agent2 = newKeyPair();
  store.credit(owner2.publicKey, usdToMicro('1.00'));
  const small = issueMandate(owner2, { agent: agent2.publicKey, budgetUsd: '0.10', window: 'day', allow: ['*'] });
  const client2 = new TabClient({ agent: agent2, mandate: small });
  const badThreshold = await post(GW + ALERTS_PATH, signAlertSub(owner2, { realm: REALM, url: HOOK, thresholds: [0] }));
  check('5: a threshold of 0% is refused', badThreshold.status === 400, badThreshold);
  const forged = signAlertSub(owner2, { realm: REALM, url: HOOK });
  check('5: a subscription with someone else\'s signature is refused', (await post(GW + ALERTS_PATH, { ...forged, owner: owner.publicKey })).status === 400);
  const sub = await post(GW + ALERTS_PATH, signAlertSub(owner2, { realm: REALM, url: HOOK, daily: true }));
  await sleep(200);
  check('5: subscribing sends a test message that arrives', sub.status === 200 && sub.doc.test_delivered === true && hooks.some((h) => h.event === 'subscribed' && h.owner === owner2.publicKey), { sub, hooks });
  const r50 = await client2.fetch(GW + '/quote');
  await sleep(300);
  const t50 = hooks.filter((h) => h.event === 'threshold');
  check('5: half the budget spent sends the 50% alert', r50.status === 200 && t50.length === 1 && t50[0].percent === 50 && t50[0].spent === '0.05' && t50[0].budget === '0.10', t50);
  for (let i = 0; i < 4; i++) await client2.fetch(GW + '/penny');
  await sleep(300);
  const t90 = hooks.filter((h) => h.event === 'threshold');
  check('5: crossing 90% sends one more alert, not one per call', t90.length === 2 && t90[1].percent === 90, t90.map((h) => h.percent));
  await client2.fetch(GW + '/penny');
  await sleep(300);
  const t100 = hooks.filter((h) => h.event === 'threshold');
  check('5: the whole budget sends the 100% alert', t100.length === 3 && t100[2].percent === 100 && /whole budget/.test(t100[2]._title ?? t100[2].title), t100.map((h) => [h.percent, h.title]));
  const over = await client2.fetch(GW + '/penny').catch((e) => e);
  await sleep(300);
  check('5: a refused payment sends nothing more', hooks.filter((h) => h.event === 'threshold').length === 3, over?.status ?? String(over));
  await sleep(2800);
  const daily = hooks.filter((h) => h.event === 'daily');
  check('5: the daily statement sums what the agents paid', daily.length === 1 && daily[0].total === '0.10' && daily[0].calls === 6 && daily[0].top[0].resource === 'GET /quote', daily);
  const off = await post(GW + ALERTS_PATH, signAlertSub(owner2, { realm: REALM, off: true }));
  check('5: alerts off removes the subscription', off.status === 200 && store.alertSub(owner2.publicKey) === undefined, off);
  // text format, for ntfy
  const owner3 = newKeyPair();
  await post(GW + ALERTS_PATH, signAlertSub(owner3, { realm: REALM, url: HOOK, format: 'text' }));
  await sleep(200);
  check('5: the text format posts a plain message with a title header', hooks.some((h) => h._format === 'text' && h._title === 'tab: alerts are on'), hooks.slice(-1));
  const alertCli = await cli(['alerts', 'set', '--url', HOOK, '--at', '25,75', '--gateway', GW], { TAB_HOME: join(scratch, 'home1') });
  check('5: tab alerts set subscribes and reports the test message', alertCli.code === 0 && /alerts at 25, 75%/.test(alertCli.out) && /test message delivered/.test(alertCli.out), alertCli);

  gw.server.close(); upstream.close(); hook.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
