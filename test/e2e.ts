// End-to-end checks, all in one process on random ports with a temp SQLite
// file (plus one spawned MCP subprocess). Safe to run next to a live gateway.
//   npm test

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { newKeyPair, saveKey } from '../src/keys.js';
import {
  canonicalJson, usdToMicro, microToUsd, makeChallenge, signCredential,
  encodeCredentialHeader, parseChallengeHeader,
} from '../src/protocol.js';
import { issueMandate, verifyMandate, realmAllowed, saveMandate } from '../src/mandate.js';
import { Store, CatalogStore } from '../src/store.js';
import { createGateway, loadSpec, matchRoute, type Spec } from '../src/gateway.js';
import { createCatalog } from '../src/catalog.js';
import { TabClient, tabFetch, receiptOf, PaymentRefused } from '../src/client.js';

// -- tiny harness -----------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-e2e-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));

async function main(): Promise<void> {
  // -- 1. primitives --------------------------------------------------------

  check('canonical json sorts keys', canonicalJson({ b: 1, a: { d: 2, c: [3, null] } }) === '{"a":{"c":[3,null],"d":2},"b":1}');
  check('usd <-> micro', usdToMicro('0.05') === 50_000 && usdToMicro('1') === 1_000_000 && usdToMicro('0.000001') === 1
    && microToUsd(10_000) === '0.01' && microToUsd(5_000) === '0.005' && microToUsd(1_000_000) === '1.00');

  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  const webAgent = newKeyPair();

  const mandate = issueMandate(owner, {
    agent: agent.publicKey, budgetUsd: '1.00', window: 'day', maxPerCallUsd: '0.05', allow: ['quotes.local'], days: 30,
  });
  check('mandate verifies', verifyMandate(mandate).ok);
  check('tampered mandate rejected', !verifyMandate({ ...mandate, budget: '999000000' }).ok);
  check('realm globs', realmAllowed(mandate, 'quotes.local')
    && !realmAllowed(mandate, 'evil.example')
    && realmAllowed(issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', allow: ['*.local'] }), 'quotes.local'));

  // -- 2. upstream (counts hits so we can prove what was and wasn't proxied) --

  let upstreamHits = 0;
  const upstream = createServer(async (req, res) => {
    upstreamHits++;
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const json = (s: number, d: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/quote') return json(200, { quote: 'stub' });
    if (u.pathname === '/echo') return json(200, { echo: body, payer: req.headers['tab-payer'] ?? null, hold: req.headers['tab-hold'] ?? null, auth: req.headers.authorization ?? null });
    if (u.pathname === '/secret') return json(req.headers['x-api-key'] === 'k-123' ? 200 : 401, { via: 'secret' });
    if (u.pathname === '/boom') return json(500, { error: 'boom' });
    if (u.pathname === '/free') return json(200, { free: true, q: u.search });
    if (u.pathname === '/bounded') return json(200, { got: body });
    return json(404, { error: 'upstream 404' });
  });
  const upPort = await listen(upstream);

  const spec: Spec = {
    realm: 'quotes.local',
    recipient: seller.publicKey,
    public_receipts: true,
    services: [
      {
        name: 'demo', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
        description: 'demo service',
        routes: [
          { method: 'GET', path: '/quote', price: '0.01', description: 'a quote' },
          { method: 'POST', path: '/echo', price: '0.005', description: 'echo body' },
          { method: 'GET', path: '/boom', price: '0.01', description: 'always fails' },
          { method: 'GET', path: '/things/:id', price: '0.01', description: 'param route' },
          { method: 'GET', path: '/free', price: '0', description: 'free route' },
          { method: 'POST', path: '/bounded', price: '0.005', description: 'one bounded op', body_allow: ['hi'], body_fixed: { max_results: 1 } },
        ],
      },
      {
        // a provider that takes its key in the query string
        name: 'keyed', prefix: '/keyed', upstream: `http://127.0.0.1:${upPort}`, upstream_query: { key: 'k-456' },
        routes: [{ method: 'GET', path: '/free', price: '0', description: 'query key injected' }],
      },
      {
        name: 'premium', prefix: '/premium', upstream: `http://127.0.0.1:${upPort}`,
        upstream_headers: { 'X-Api-Key': 'k-123' },
        routes: [{ method: 'GET', path: '/secret', price: '0.02', description: 'injected key' }],
      },
      {
        // an upstream that names its endpoint, with a root route: forwards to /quote, not /quote/
        name: 'rooted', prefix: '/rooted', upstream: `http://127.0.0.1:${upPort}/quote`,
        routes: [{ method: 'GET', path: '/', price: '0', description: 'endpoint in the upstream url' }],
      },
    ],
  };

  check('route matching: longest prefix + params',
    matchRoute(spec, 'GET', '/premium/secret')?.service.name === 'premium'
    && matchRoute(spec, 'GET', '/things/42')?.route.path === '/things/:id'
    && matchRoute(spec, 'GET', '/things/') === null
    && matchRoute(spec, 'DELETE', '/quote') === null);

  const store = new Store(join(scratch, 'tab.db'));
  store.credit(owner.publicKey, usdToMicro('5.00'));
  const gateway = createGateway(spec, { store });
  const gwPort = await listen(gateway);
  const GW = `http://127.0.0.1:${gwPort}`;

  // -- 3. discovery, free routes, 404 --------------------------------------

  const disc = await (await fetch(`${GW}/.well-known/tab`)).json() as any;
  check('discovery document', disc.ver === 'tab/0' && disc.realm === 'quotes.local'
    && disc.rail === 'ledger' && disc.recipient === seller.publicKey && disc.services.length === 4);
  check('body constraints stay out of discovery', !JSON.stringify(disc).includes('body_fixed') && !JSON.stringify(disc).includes('max_results'));

  {
    const keyed = await fetch(`${GW}/keyed/free?x=1`);
    check('upstream_query adds the provider key to the forwarded url', keyed.status === 200 && /x=1/.test((await keyed.json() as any).q) && /key=k-456/.test((await (await fetch(`${GW}/keyed/free?x=1`)).json() as any).q));
  }

  const freeRes = await fetch(`${GW}/free?x=1`);
  check('free route forwarded unpaid', freeRes.status === 200 && (await freeRes.json() as any).q === '?x=1' && receiptOf(freeRes) === null);

  const hitsBefore404 = upstreamHits;
  const nf = await fetch(`${GW}/nope`);
  check('unpriced path is 404, never proxied', nf.status === 404
    && (await nf.json() as any).type === 'urn:tab:problem:not-found' && upstreamHits === hitsBefore404);

  // -- 4. the 402 handshake -------------------------------------------------

  const c402 = await fetch(`${GW}/quote`);
  const chal = parseChallengeHeader(c402.headers.get('www-authenticate'));
  check('402 challenge issued with the right terms', c402.status === 402 && chal !== null
    && (await c402.json() as any).type === 'urn:tab:problem:payment-required'
    && chal!.amount === '10000' && chal!.rail === 'ledger'
    && chal!.recipient === seller.publicKey && chal!.resource === 'GET /quote' && chal!.realm === 'quotes.local');

  const client = new TabClient({ agent, mandate });
  const paid = await client.fetch(`${GW}/quote`);
  const receipt = receiptOf(paid);
  check('paid call succeeds with a sound receipt', paid.status === 200 && (await paid.json() as any).quote === 'stub'
    && receipt !== null && receipt.amount === '10000'
    && receipt.ref.startsWith('ledger:') && receipt.payer === agent.publicKey
    && receipt.owner === owner.publicKey && receipt.resource === 'GET /quote');
  {
    const rooted = await fetch(`${GW}/rooted`);
    check('a root route on an upstream that names its endpoint forwards there without a trailing slash',
      rooted.status === 200 && (await rooted.json() as any).quote === 'stub' && receiptOf(rooted) === null);
  }
  check('seller paid, owner debited', store.balance(seller.publicKey) === 10_000
    && store.balance(owner.publicKey) === usdToMicro('5.00') - 10_000);

  const echoRes = await client.fetch(`${GW}/echo`, { method: 'POST', body: JSON.stringify({ hi: 1 }), headers: { 'content-type': 'application/json', authorization: 'Bearer buyer-token-should-be-stripped' } });
  const echoBody = await echoRes.json() as any;
  check('body forwarded, attribution headers added', echoRes.status === 200
    && echoBody.echo === '{"hi":1}' && echoBody.payer === agent.publicKey && typeof echoBody.hold === 'string'
    && echoBody.auth === null); // and the buyer's Authorization was stripped

  {
    const hits = upstreamHits;
    const bounded = await client.fetch(`${GW}/bounded`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1, max_results: 500 }) });
    const got = JSON.parse((await bounded.json() as any).got);
    check('body_fixed overrides what the buyer sent and the paid call still verifies', bounded.status === 200 && got.hi === 1 && got.max_results === 1 && receiptOf(bounded)?.amount === '5000');
    const extra = await fetch(`${GW}/bounded`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hi: 1, model: 'huge' }) });
    const notJson = await fetch(`${GW}/bounded`, { method: 'POST', body: 'hi=1' });
    const empty = await client.fetch(`${GW}/bounded`, { method: 'POST' });
    check('body_allow refuses extra keys and non-JSON before any challenge', extra.status === 400 && (await extra.json() as any).type === 'urn:tab:problem:bad-request'
      && notJson.status === 400 && empty.status === 200 && JSON.parse((await empty.json() as any).got).max_results === 1 && upstreamHits === hits + 2);
  }

  const secretRes = await client.fetch(`${GW}/premium/secret`);
  check('prefix stripped and upstream_headers injected', secretRes.status === 200 && (await secretRes.json() as any).via === 'secret' && receiptOf(secretRes)!.amount === '20000');

  // -- 5. replay, tampering, expiry -----------------------------------------

  const c2 = await fetch(`${GW}/quote`);
  const chal2 = parseChallengeHeader(c2.headers.get('www-authenticate'))!;
  const cred2 = encodeCredentialHeader(signCredential(agent, chal2, mandate));
  const r1 = await fetch(`${GW}/quote`, { headers: { authorization: cred2 } });
  const r2 = await fetch(`${GW}/quote`, { headers: { authorization: cred2 } });
  check('credential redeems once, replay names the reason', r1.status === 200 && r2.status === 402
    && (await r2.json() as any).type === 'urn:tab:problem:invalid-challenge');

  const c3 = await fetch(`${GW}/quote`);
  const chal3 = parseChallengeHeader(c3.headers.get('www-authenticate'))!;
  const tampered = { ...chal3, amount: '1' }; // pay less than priced
  const r3 = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, tampered, mandate)) } });
  check('tampered challenge rejected', r3.status === 402 && (await r3.json() as any).type === 'urn:tab:problem:invalid-challenge');

  const expired = makeChallenge(store.secret, {
    realm: 'quotes.local', rail: 'ledger', amount: '10000', recipient: seller.publicKey,
    resource: 'GET /quote', expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const r4 = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, expired, mandate)) } });
  check('expired challenge rejected', r4.status === 402 && (await r4.json() as any).type === 'urn:tab:problem:payment-expired');

  const r5 = await fetch(`${GW}/quote`, { headers: { authorization: 'Tab not-base64-json!!!' } });
  check('malformed credential rejected', r5.status === 402 && (await r5.json() as any).type === 'urn:tab:problem:malformed-credential');

  // -- 6. mandate enforcement ----------------------------------------------

  // pay the gateway directly, past the client's own mandate checks, to test what the gateway enforces
  const rawPay = async (url: string, m: any, init: { method?: string; body?: string } = {}) => {
    const c = parseChallengeHeader((await fetch(url, init)).headers.get('www-authenticate'))!;
    return fetch(url, { ...init, headers: { authorization: encodeCredentialHeader(signCredential(agent, c, m, { query: new URL(url).search, body: init.body })) } });
  };

  const strangerMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['other.realm'] });
  const deniedRes = await rawPay(`${GW}/quote`, strangerMandate);
  const deniedBody = await deniedRes.json() as any;
  check('wrong-realm mandate denied', deniedRes.status === 402
    && deniedBody.type === 'urn:tab:problem:mandate-denied'
    && String(deniedBody.detail).includes('not in mandate allow list'));

  const capMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', maxPerCallUsd: '0.005', allow: ['quotes.local'] });
  const capRes = await rawPay(`${GW}/quote`, capMandate);
  check('per-call cap enforced by gateway', capRes.status === 402 && (await capRes.json() as any).type === 'urn:tab:problem:mandate-exceeded');
  const refusals: string[] = [];
  for (const m of [strangerMandate, capMandate]) {
    try { await tabFetch(`${GW}/quote`, {}, { agent, mandate: m }); refusals.push('signed'); } catch (e) { refusals.push(e instanceof PaymentRefused ? e.reason : String(e)); }
  }
  check('the client enforces the mandate too, refusing before it signs', /allow list/.test(refusals[0]) && /per-call cap/.test(refusals[1]));

  const tinyMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.015', allow: ['quotes.local'] });
  const tinyClient = new TabClient({ agent, mandate: tinyMandate });
  const t1 = await tinyClient.fetch(`${GW}/quote`);
  const t2 = await tinyClient.fetch(`${GW}/quote`);
  check('budget window enforced', t1.status === 200 && t2.status === 402
    && (await t2.json() as any).type === 'urn:tab:problem:mandate-exceeded');

  const poorOwner = newKeyPair();
  const poorMandate = issueMandate(poorOwner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['quotes.local'] });
  const poorRes = await tabFetch(`${GW}/quote`, {}, { agent, mandate: poorMandate });
  check('insufficient funds rejected', poorRes.status === 402 && (await poorRes.json() as any).type === 'urn:tab:problem:insufficient-funds');

  // -- 7. voids: upstream non-2xx and upstream down -------------------------

  const exactMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.01', allow: ['quotes.local'] });
  const exactClient = new TabClient({ agent, mandate: exactMandate });
  const ownerBefore = store.balance(owner.publicKey);
  const boom = await exactClient.fetch(`${GW}/boom`);
  check('upstream non-2xx passed through and voided', boom.status === 500
    && boom.headers.get('tab-void') !== null && receiptOf(boom) === null);
  check('void released the hold', store.balance(owner.publicKey) === ownerBefore);
  const afterBoom = await exactClient.fetch(`${GW}/quote`);
  check('void refunded the mandate budget', afterBoom.status === 200);

  const deadSpec: Spec = { ...spec, services: [{ name: 'dead', prefix: '', upstream: 'http://127.0.0.1:1', routes: [{ method: 'GET', path: '/quote', price: '0.01' }] }] };
  const deadStore = new Store(join(scratch, 'dead.db'));
  deadStore.credit(owner.publicKey, usdToMicro('1.00'));
  const deadGw = createGateway(deadSpec, { store: deadStore });
  const deadPort = await listen(deadGw);
  const deadRes = await tabFetch(`http://127.0.0.1:${deadPort}/quote`, {}, { agent, mandate });
  check('unreachable upstream: 502, nothing charged', deadRes.status === 502
    && (await deadRes.json() as any).type === 'urn:tab:problem:upstream-failed'
    && deadStore.balance(owner.publicKey) === usdToMicro('1.00'));
  deadGw.close();

  // -- 8. the client's own guardrails ---------------------------------------

  let refused: unknown = null;
  try {
    await tabFetch(`${GW}/quote`, {}, { agent, mandate, maxPerCallUsd: '0.005' });
  } catch (err) { refused = err; }
  check('client cap refuses before paying', refused instanceof PaymentRefused);

  let sawAmount = '';
  let vetoed: unknown = null;
  try {
    await tabFetch(`${GW}/quote`, {}, { agent, mandate, onChallenge: (_c, req) => { sawAmount = req.amount; return false; } });
  } catch (err) { vetoed = err; }
  check('onChallenge veto, amounts in micro-USD', vetoed instanceof PaymentRefused && sawAmount === '10000');

  let ctorThrew = false;
  try { new TabClient({ agent: webAgent, mandate }); } catch { ctorThrew = true; }
  check('mandate/agent mismatch caught client-side', ctorThrew);

  // -- 9. wallet + receipts endpoints ---------------------------------------

  const wallet = await (await fetch(`${GW}/.well-known/tab/wallet/${seller.publicKey}`)).json() as any;
  check('wallet endpoint', wallet.micro === store.balance(seller.publicKey) && wallet.rail === 'ledger');

  const recs = await (await fetch(`${GW}/.well-known/tab/receipts?limit=100`)).json() as any;
  check('public receipts', Array.isArray(recs.receipts) && recs.receipts.length >= 5
    && recs.receipts.every((r: any) => typeof r.ref === 'string' && r.ref.startsWith('ledger:')));
  {
    const byPayer = await (await fetch(`${GW}/.well-known/tab/receipts?payer=${encodeURIComponent(agent.publicKey)}&since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).json() as any;
    const nobody = await (await fetch(`${GW}/.well-known/tab/receipts?payer=${encodeURIComponent(webAgent.publicKey)}`)).json() as any;
    check('receipts filter by payer and since', byPayer.receipts.length >= 5 && byPayer.receipts.every((r: any) => r.payer === agent.publicKey) && nobody.receipts.length === 0);
    const spent = await (await fetch(`${GW}/.well-known/tab/mandate/${mandate.id}/spent`)).json() as any;
    check('spend by mandate id, by window', spent.mandate_id === mandate.id && spent.micro === store.spentAll(mandate.id).reduce((n, w) => n + w.spent, 0)
      && spent.micro >= 40_000 && spent.windows.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(spent.windows[0].window_key) && spent.currency === 'USD');
    const unknown = await (await fetch(`${GW}/.well-known/tab/mandate/${strangerMandate.id}/spent`)).json() as any;
    check('an unspent mandate reports zero, a malformed id is refused', unknown.micro === 0 && (await fetch(`${GW}/.well-known/tab/mandate/nope/spent`)).status === 400);
  }

  // -- 9a. per-service upstream rate limit ---------------------------------

  {
    const slowSpec: Spec = { ...spec, services: [{ name: 'slow', prefix: '/slow', upstream: `http://127.0.0.1:${upPort}/quote`, rate_limit_per_minute: 1,
      routes: [{ method: 'GET', path: '/', price: '0.01', description: 'one call a minute upstream' }] }] };
    const slowGw = createGateway(slowSpec, { store });
    const SGW = `http://127.0.0.1:${await listen(slowGw)}`;
    const sDisc = await (await fetch(`${SGW}/.well-known/tab`)).json() as any;
    const before = store.balance(owner.publicKey);
    const r1 = await client.fetch(`${SGW}/slow`);
    const afterOne = store.balance(owner.publicKey);
    const r2 = await client.fetch(`${SGW}/slow`);
    const p2 = await r2.json() as any;
    check('a rate-limited service serves within its limit, then answers 429 with Retry-After and charges nothing',
      sDisc.services[0].rate_limit_per_minute === 1 && r1.status === 200 && before - afterOne === 10_000
      && r2.status === 429 && Number(r2.headers.get('retry-after')) > 0 && p2.type === 'urn:tab:problem:rate-limited'
      && store.balance(owner.publicKey) === afterOne);
    const unpaid = await fetch(`${SGW}/slow`);
    check('the 402 challenge itself is not rate limited', unpaid.status === 402);
    slowGw.close();
    const groupSpec: Spec = { ...spec, services: ['ga', 'gb'].map((n) => ({ name: n, prefix: '/' + n, upstream: `http://127.0.0.1:${upPort}/quote`,
      rate_limit_per_minute: 1, rate_limit_group: 'shared', routes: [{ method: 'GET', path: '/', price: '0.01', description: 'grouped' }] })) };
    const groupGw = createGateway(groupSpec, { store });
    const GGW = `http://127.0.0.1:${await listen(groupGw)}`;
    const ga = await client.fetch(`${GGW}/ga`);
    const gb = await client.fetch(`${GGW}/gb`);
    check('services in one rate limit group share its budget', ga.status === 200 && gb.status === 429);
    groupGw.close();
  }

  // -- 9b. starter credits (faucet) + tab init ------------------------------

  const faucetStore = new Store(join(scratch, 'faucet.db'));
  const faucetGw = createGateway(spec, { store: faucetStore, faucetUsd: '1.00', faucetPerIpPerDay: 3 });
  const FGW = `http://127.0.0.1:${await listen(faucetGw)}`;
  const fDisc = await (await fetch(`${FGW}/.well-known/tab`)).json() as any;
  check('faucet advertised in discovery', fDisc.faucet === '1.00' && disc.faucet === undefined);
  const claimer = newKeyPair();
  const claim = async (wallet: string) => fetch(`${FGW}/.well-known/tab/faucet`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
  });
  const fc1 = await (await claim(claimer.publicKey)).json() as any;
  const fc2 = await (await claim(claimer.publicKey)).json() as any;
  check('faucet credits once per wallet', fc1.credited === '1.00' && fc1.available === '1.00'
    && fc2.credited === '0.00' && fc2.already_claimed === true && faucetStore.balance(claimer.publicKey) === 1_000_000);
  const cBad = await claim('not-a-wallet');
  check('faucet rejects a malformed wallet', cBad.status === 400);
  check('no faucet on a plain gateway', (await fetch(`${GW}/.well-known/tab/faucet`, { method: 'POST', body: '{}' })).status === 404);

  const initDir = join(scratch, 'home');
  const initRun = () => new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'init',
      '--dir', initDir, '--gateway', FGW, '--catalog', 'http://127.0.0.1:1', '--budget', '0.50', '--max-per-call', '0.02'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout!.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const i1 = await initRun();
  const initOwner = JSON.parse(readFileSync(join(initDir, 'owner.json'), 'utf8')).publicKey as string;
  const initMandate = JSON.parse(readFileSync(join(initDir, 'mandate.json'), 'utf8'));
  check('tab init writes keys, a mandate and claims credits', i1.code === 0
    && verifyMandate(initMandate).ok && initMandate.owner === initOwner && initMandate.budget === '500000'
    && initMandate.max_per_call === '20000' && faucetStore.balance(initOwner) === 1_000_000
    && /1\.00 starter credits/.test(i1.out) && /claude mcp add/.test(i1.out));
  const i2 = await initRun();
  check('tab init is idempotent', i2.code === 0 && /already claimed/.test(i2.out)
    && JSON.parse(readFileSync(join(initDir, 'owner.json'), 'utf8')).publicKey === initOwner);
  const paidByInit = await new TabClient({
    agent: JSON.parse(readFileSync(join(initDir, 'agent.json'), 'utf8')),
    mandate: JSON.parse(readFileSync(join(initDir, 'mandate.json'), 'utf8')),
  }).fetch(`${FGW}/quote`);
  check('init credentials pay on the faucet gateway', paidByInit.status === 200 && receiptOf(paidByInit)?.amount === '10000');
  await claim(newKeyPair().publicKey); // third claim from this address: allowed
  check('faucet rate limits per address', (await claim(newKeyPair().publicKey)).status === 429);
  faucetGw.close();
  faucetStore.close();

  // -- 10. spec loading -----------------------------------------------------

  process.env.TEST_SELLER_E2E = seller.publicKey;
  const specPath = join(scratch, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ realm: 'r', recipient: '${TEST_SELLER_E2E}', upstream: 'http://x', routes: [{ method: 'GET', path: '/a', price: '0.01' }] }));
  const loaded = loadSpec(specPath);
  check('spec env expansion + single-service shorthand', loaded.recipient === seller.publicKey
    && loaded.services.length === 1 && loaded.services[0].prefix === '');
  writeFileSync(specPath, JSON.stringify({ realm: 'r', recipient: '${UNSET_VAR_E2E}', upstream: 'http://x', routes: [] }));
  let specThrew = false;
  try { loadSpec(specPath); } catch { specThrew = true; }
  check('unset ${VAR} makes an empty recipient refuse to load', specThrew);
  {
    const two = { realm: 'r', recipient: seller.publicKey, services: [
      { name: 'free', prefix: '/free', upstream: 'http://x', routes: [{ method: 'GET', path: '/a', price: '0.01' }] },
      { name: 'paid', prefix: '/paid', upstream: 'http://y', upstream_headers: { Authorization: 'Bearer ${PAID_KEY_E2E}' }, requires: ['PAID_KEY_E2E'], routes: [{ method: 'GET', path: '/b', price: '0.02' }] },
    ] };
    writeFileSync(specPath, JSON.stringify(two));
    delete process.env.PAID_KEY_E2E;
    const without = loadSpec(specPath);
    check('a service whose required key is unset is skipped and named', without.services.length === 1 && without.services[0].name === 'free'
      && without.skipped?.length === 1 && /paid \(needs PAID_KEY_E2E\)/.test(without.skipped[0]));
    process.env.PAID_KEY_E2E = 'k';
    const withKey = loadSpec(specPath);
    check('the same service is listed once the key is set', withKey.services.length === 2 && withKey.skipped === undefined
      && withKey.services[1].upstream_headers?.Authorization === 'Bearer k');
    writeFileSync(specPath, JSON.stringify({ ...two, services: [two.services[1]] }));
    delete process.env.PAID_KEY_E2E;
    let allSkipped = '';
    try { loadSpec(specPath); } catch (e) { allSkipped = (e as Error).message; }
    check('every service skipped is a clear refusal to start', /every service was skipped/.test(allSkipped));
  }

  // -- 11. catalog ----------------------------------------------------------

  const webMandate = issueMandate(owner, { agent: webAgent.publicKey, budgetUsd: '0.50', window: 'day', maxPerCallUsd: '0.05', allow: ['quotes.local'] });
  const catStore = new CatalogStore(join(scratch, 'catalog.db'));
  const catalog = createCatalog({ store: catStore, tryAgent: webAgent, tryMandate: webMandate, tryMaxPerCallUsd: '0.05', allowPrivateOrigins: true });
  const catPort = await listen(catalog);
  const CAT = `http://127.0.0.1:${catPort}`;

  const ann = await (await fetch(`${CAT}/v1/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: GW }) })).json() as any;
  check('announce verifies and stores', ann.ok === true && ann.origin === GW);

  const badAnn = await (await fetch(`${CAT}/v1/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'http://127.0.0.1:1' }) })).json() as any;
  check('unreachable gateway stored with ok:false', badAnn.ok === false && typeof badAnn.error === 'string');

  const catDoc = await (await fetch(`${CAT}/v1/catalog.json`)).json() as any;
  check('catalog.json lists gateways', catDoc.gateways.length === 2
    && catDoc.gateways.some((g: any) => g.origin === GW && g.ok && g.realm === 'quotes.local'));

  const s1 = await (await fetch(`${CAT}/v1/search?q=quote`)).json() as any;
  check('search finds routes with full urls', s1.results.length >= 1
    && s1.results[0].url === `${GW}/quote` && s1.results[0].price === '0.01');
  const s2 = await (await fetch(`${CAT}/v1/search`)).json() as any;
  check('empty search lists everything, cheapest first', s2.results.length === 9
    && s2.results[0].price_micro <= s2.results[s2.results.length - 1].price_micro);
  const s3 = await (await fetch(`${CAT}/v1/search?max_price=0.005`)).json() as any;
  check('max_price filter', s3.results.length >= 1 && s3.results.every((r: any) => usdToMicro(r.price) <= 5000));
  const s4 = await (await fetch(`${CAT}/v1/search?limit=2&offset=1`)).json() as any;
  check('search pages with limit and offset and reports the total', s4.total === 9 && s4.offset === 1 && s4.results.length === 2
    && s4.results[0].url === s2.results[1].url);
  const slim = await (await fetch(`${CAT}/v1/catalog.json?services=0`)).json() as any;
  const full = catDoc.gateways.find((g: any) => g.origin === GW);
  const slimGw = slim.gateways.find((g: any) => g.origin === GW);
  check('catalog.json?services=0 gives counts without the route lists', slimGw && slimGw.services === undefined
    && slimGw.route_count === full.services.reduce((n: number, sv: any) => n + sv.routes.length, 0) && slimGw.service_count === full.services.length);

  const health = await fetch(`${CAT}/v1/health`);
  const hBody = await health.json() as any;
  check('health ignores an origin that never served a document, and reports the routes and the version', health.status === 200 && hBody.ok === true && hBody.routes === 9
    && hBody.version === JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version);
  // a refresh that fails keeps the last good routes in search, for a while
  const goodRow = catStore.all().find((r) => r.origin === GW)!;
  catStore.put({ origin: GW, ok: false, error: 'discovery document too large', payload: null, fetched_at: new Date().toISOString() });
  const stale = await (await fetch(`${CAT}/v1/search`)).json() as any;
  const staleGw = (await (await fetch(`${CAT}/v1/catalog.json?services=0`)).json() as any).gateways.find((g: any) => g.origin === GW);
  check('a gateway that fails a refresh stays searchable on its last good document, marked stale', stale.total === 9 && staleGw.ok === false && staleGw.stale === true);
  check('and health goes 503 while a gateway that used to work fails', (await fetch(`${CAT}/v1/health`)).status === 503);
  catStore.put({ ...goodRow, fetched_at: new Date(Date.now() - 7 * 3_600_000).toISOString() });
  catStore.put({ origin: GW, ok: false, error: 'down', payload: null, fetched_at: new Date().toISOString() });
  check('after six hours of failures its routes leave search', ((await (await fetch(`${CAT}/v1/search`)).json()) as any).total === 0);
  await fetch(`${CAT}/v1/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: GW }) });
  check('the next good refresh brings them back', ((await (await fetch(`${CAT}/v1/search`)).json()) as any).total === 9);

  const mv1 = await (await fetch(`${CAT}/v1/mandate/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandate, realm: 'quotes.local' }) })).json() as any;
  const mv2 = await (await fetch(`${CAT}/v1/mandate/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandate: { ...mandate, budget: '9' }, realm: 'quotes.local' }) })).json() as any;
  check('mandate verify endpoint', mv1.ok === true && mv1.mandate.budget_usd === '1.00' && mv2.ok === false);

  const wproxy = await (await fetch(`${CAT}/v1/wallet?origin=${encodeURIComponent(GW)}&wallet=${encodeURIComponent(seller.publicKey)}`)).json() as any;
  check('wallet proxied through the catalog', wproxy.micro === store.balance(seller.publicKey));

  const tryInfo = await (await fetch(`${CAT}/v1/try`)).json() as any;
  check('try-it advertised', tryInfo.enabled === true && tryInfo.max_per_call_usd === '0.05');

  const sellerBeforeTry = store.balance(seller.publicKey);
  const tried = await (await fetch(`${CAT}/v1/try`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${GW}/quote`, method: 'GET' }) })).json() as any;
  check('try-it pays and returns the receipt', tried.status === 200
    && tried.receipt?.payer === webAgent.publicKey && store.balance(seller.publicKey) === sellerBeforeTry + 10_000);

  const triedBad = await fetch(`${CAT}/v1/try`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://evil.example/steal', method: 'GET' }) });
  check('try-it refuses uncatalogued urls', triedBad.status === 403);

  const agg = await (await fetch(`${CAT}/v1/receipts?limit=10`)).json() as any;
  check('receipts aggregated across gateways', agg.receipts.length >= 1 && agg.receipts[0].origin === GW);

  // -- 12. the MCP server (a real subprocess on stdio) ----------------------

  const agentPath = join(scratch, 'agent.json');
  const mandatePath = join(scratch, 'mandate.json');
  saveKey(agentPath, agent);
  saveMandate(mandatePath, mandate);
  const mcp = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'mcp'], {
    env: { ...process.env, TAB_AGENT: agentPath, TAB_MANDATE: mandatePath, TAB_MAX_PER_CALL: '0.05', TAB_CATALOG: CAT },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<number, (v: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } catch { /* ignore */ }
  });
  let mcpId = 0;
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++mcpId;
      pending.set(id, resolve);
      mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`mcp ${method} timed out`)); }, 30_000);
    });

  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  check('mcp initialize', init.result?.serverInfo?.name === 'tab');
  const tools = await rpc('tools/list');
  check('mcp lists five tools', tools.result?.tools?.length === 5
    && tools.result.tools.map((t: any) => t.name).join(',') === 'tab_limits,tab_search,tab_discover,tab_fetch,tab_balance');
  const limits = await rpc('tools/call', { name: 'tab_limits', arguments: {} });
  check('mcp tab_limits', JSON.parse(limits.result.content[0].text).budget_usd === '1.00');
  const search = await rpc('tools/call', { name: 'tab_search', arguments: { query: 'quote' } });
  check('mcp tab_search via catalog', JSON.parse(search.result.content[0].text).results[0].url === `${GW}/quote`);
  const fetched = await rpc('tools/call', { name: 'tab_fetch', arguments: { url: `${GW}/quote` } });
  const fetchedBody = JSON.parse(fetched.result.content[0].text);
  check('mcp tab_fetch pays and returns the receipt', fetchedBody.status === 200 && fetchedBody.paid_usd === '0.01');
  const bal = await rpc('tools/call', { name: 'tab_balance', arguments: {} });
  const balBody = JSON.parse(bal.result.content[0].text);
  check('mcp tab_balance via catalog', balBody.wallet === owner.publicKey
    && balBody.balances.some((b: any) => b.origin === GW && b.micro === store.balance(owner.publicKey)));
  mcp.kill();

  // -- done -----------------------------------------------------------------

  gateway.close();
  catalog.close();
  upstream.close();
  store.close();
  deadStore.close();
  catStore.close();
  rmSync(scratch, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
