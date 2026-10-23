// The torture suite: try to steal money, get free service, exceed mandates,
// replay purchases, mutate requests, forge mandates, abuse the catalog, and
// crash the accounting. Every check asserts an invariant an attacker would
// want broken. Runs in-process on random ports with a temp SQLite file.
//   npm run test:adversarial

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newKeyPair } from '../src/keys.js';
import {
  usdToMicro, signCredential, encodeCredentialHeader, parseChallengeHeader,
  verifyReceipt, signReceipt, bodyDigest, type Receipt,
} from '../src/protocol.js';
import { issueMandate, realmAllowed } from '../src/mandate.js';
import { Store, CatalogStore } from '../src/store.js';
import { createGateway, loadSpec, type Spec } from '../src/gateway.js';
import { createCatalog } from '../src/catalog.js';
import { TabClient, receiptOf, PaymentRefused } from '../src/client.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-adv-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
const b64u = (s: string) => Buffer.from(s).toString('base64url');

async function main(): Promise<void> {
  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  const attacker = newKeyPair();

  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/destroy') { req.socket.destroy(); return; }
    if (path === '/hang') return; // never answers
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    // an upstream that tries to speak for the gateway
    if (path === '/forge') res.setHeader('tab-receipt', 'FORGED');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path, body: Buffer.concat(chunks).toString(), payer: req.headers['tab-payer'] ?? null }));
  });
  const upPort = await listen(upstream);

  const spec: Spec = {
    realm: 'adv.local',
    recipient: seller.publicKey,
    public_receipts: true,
    services: [{
      name: 'adv', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
      routes: [
        { method: 'GET', path: '/quote', price: '0.01' },
        { method: 'POST', path: '/echo', price: '0.01' },
        { method: 'GET', path: '/destroy', price: '0.01' },
        { method: 'GET', path: '/hang', price: '0.01' },
        { method: 'POST', path: '/bounded', price: '0.01', body_allow: ['q'], body_fixed: { n: 1 } },
        { method: 'GET', path: '/forge', price: '0.01' },
        { method: 'GET', path: '/free/:id', price: '0' },
        { method: 'GET', path: '/item/:id', price: '0.01' },
      ],
    }],
  };
  const dbPath = join(scratch, 'adv.db');
  let store = new Store(dbPath);
  store.credit(owner.publicKey, usdToMicro('50.00'));
  let gateway = createGateway(spec, { store, upstreamTimeoutMs: 500 });
  const gwPort = await listen(gateway);
  const GW = `http://127.0.0.1:${gwPort}`;
  const sellerBal = () => store.balance(seller.publicKey);
  const ownerBal = () => store.balance(owner.publicKey);

  // pay the gateway directly, past the client's own mandate checks, to test what the gateway enforces
  const rawPay = async (url: string, m: any, init: { method?: string; body?: string } = {}) => {
    const c = parseChallengeHeader((await fetch(url, init)).headers.get('www-authenticate'))!;
    return fetch(url, { ...init, headers: { authorization: encodeCredentialHeader(signCredential(agent, c, m, { query: new URL(url).search, body: init.body })) } });
  };

  // ==========================================================================
  // A. concurrency: the budget must be a hard boundary
  // ==========================================================================

  {
    const m = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.local'] });
    const sellerBefore = sellerBal();
    const ownerBefore = ownerBal();
    const results = await Promise.all(
      Array.from({ length: 150 }, () => new TabClient({ agent, mandate: m }).fetch(`${GW}/quote`)),
    );
    const ok = results.filter((r) => r.status === 200).length;
    const denied = results.filter((r) => r.status === 402).length;
    check('150 concurrent calls on a $1.00 budget: exactly 100 succeed', ok === 100 && denied === 50, { ok, denied });
    check('the money is exact under concurrency', sellerBal() - sellerBefore === usdToMicro('1.00')
      && ownerBefore - ownerBal() === usdToMicro('1.00'));
  }

  {
    const m = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.local'] });
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const auth = encodeCredentialHeader(signCredential(agent, chal, m));
    const sellerBefore = sellerBal();
    const replays = await Promise.all(
      Array.from({ length: 25 }, () => fetch(`${GW}/quote`, { headers: { authorization: auth } })),
    );
    const ok = replays.filter((r) => r.status === 200).length;
    check('25 concurrent copies of one credential: exactly 1 pays', ok === 1
      && sellerBal() - sellerBefore === usdToMicro('0.01'), { ok });

    // two *different* credentials signed over the same challenge also cannot both pay
    const chal2 = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const c1 = encodeCredentialHeader(signCredential(agent, chal2, m));
    const c2 = encodeCredentialHeader(signCredential(agent, chal2, m));
    const r1 = await fetch(`${GW}/quote`, { headers: { authorization: c1 } });
    const r2 = await fetch(`${GW}/quote`, { headers: { authorization: c2 } });
    check('a challenge id is spendable once, not per-credential', r1.status === 200 && r2.status === 402);
  }

  // ==========================================================================
  // B. request binding: an authorization buys THIS request, not the route
  // ==========================================================================

  const mandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5.00', allow: ['adv.local'] });

  {
    const chal = parseChallengeHeader(
      (await fetch(`${GW}/echo`, { method: 'POST', body: '{"a":1}' })).headers.get('www-authenticate'),
    )!;
    const cred = encodeCredentialHeader(signCredential(agent, chal, mandate, { body: '{"a":1}' }));
    const sellerBefore = sellerBal();
    const swapped = await fetch(`${GW}/echo`, { method: 'POST', body: '{"a":2}', headers: { authorization: cred } });
    check('body swap after signing is rejected, nothing charged', swapped.status === 402
      && ((await swapped.json()) as any).type === 'urn:tab:problem:verification-failed'
      && sellerBal() === sellerBefore);
    const honest = await fetch(`${GW}/echo`, { method: 'POST', body: '{"a":1}', headers: { authorization: cred } });
    check('...while the exact signed body still pays', honest.status === 200
      && ((await honest.json()) as any).body === '{"a":1}');
  }

  {
    const chal = parseChallengeHeader((await fetch(`${GW}/quote?x=1`)).headers.get('www-authenticate'))!;
    const cred = encodeCredentialHeader(signCredential(agent, chal, mandate, { query: '?x=1' }));
    const moved = await fetch(`${GW}/quote?x=2`, { headers: { authorization: cred } });
    check('query-string mutation is rejected', moved.status === 402
      && ((await moved.json()) as any).type === 'urn:tab:problem:verification-failed');
  }

  {
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const cred = signCredential(agent, chal, mandate) as any;
    delete cred.request;
    const r = await fetch(`${GW}/quote`, { headers: { authorization: `Tab ${b64u(JSON.stringify(cred))}` } });
    check('credential without a request commitment is malformed', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:malformed-credential');
  }

  // ==========================================================================
  // C. hostile input never crashes and never pays
  // ==========================================================================

  {
    const deep = '['.repeat(2000) + ']'.repeat(2000);
    const garbage = [
      'Tab', 'Tab ', 'Tab !!!!', 'Basic dXNlcjpwYXNz', 'Bearer xyz',
      `Tab ${b64u('null')}`, `Tab ${b64u('[]')}`, `Tab ${b64u('{}')}`, `Tab ${b64u('"x"')}`,
      `Tab ${b64u('{"ver":9,"sig":1}')}`,
      `Tab ${b64u(deep)}`,
      `Tab ${b64u(JSON.stringify({ ver: 'tab/0', agent: 0, challenge: { id: [] }, mandate: {}, sig: {} }))}`,
      `Tab ${b64u('{"challenge":{"id":"x"},"mandate":{},"sig":" ￿\uD800"}')}`,
      `Tab ${'A'.repeat(8000)}`,
    ];
    const sellerBefore = sellerBal();
    let fiveHundreds = 0;
    let paid = 0;
    for (const auth of garbage) {
      const r = await fetch(`${GW}/quote`, { headers: { authorization: auth } }).catch(() => null);
      if (r && r.status >= 500) fiveHundreds++;
      if (r && r.status === 200) paid++;
    }
    check('garbage credentials: never 5xx, never paid, never charged',
      fiveHundreds === 0 && paid === 0 && sellerBal() === sellerBefore, { fiveHundreds, paid });
  }

  {
    // one valid credential, every load-bearing field mutated one at a time
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const good = signCredential(agent, chal, mandate);
    const mutations: Array<(c: any) => void> = [
      (c) => { c.agent = attacker.publicKey; },
      (c) => { c.sig = signCredential(attacker, chal, mandate).sig; },
      (c) => { c.challenge.amount = '1'; },
      (c) => { c.challenge.recipient = attacker.publicKey; },
      (c) => { c.challenge.resource = 'GET /somewhere-else'; },
      (c) => { c.challenge.expires_at = '2999-01-01T00:00:00Z'; },
      (c) => { c.challenge.realm = 'other.realm'; },
      (c) => { c.mandate.budget = '999999999999'; },
      (c) => { c.mandate.agent = attacker.publicKey; },
      (c) => { c.mandate.allow = ['*']; },
      (c) => { c.mandate.expires_at = '2999-01-01T00:00:00Z'; },
      (c) => { c.request.body_sha256 = 'AAAA'; },
      (c) => { c.request.query = '?free=1'; },
    ];
    const sellerBefore = sellerBal();
    let paidCount = 0;
    for (const mutate of mutations) {
      const c = JSON.parse(JSON.stringify(good));
      mutate(c);
      const r = await fetch(`${GW}/quote`, { headers: { authorization: `Tab ${b64u(JSON.stringify(c))}` } });
      if (r.status === 200) paidCount++;
    }
    check('every single-field mutation of a valid credential is rejected',
      paidCount === 0 && sellerBal() === sellerBefore, { paidCount });
    // ...and the untouched original still redeems (nothing above burned it)
    const r = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(good) } });
    check('the untouched credential still pays after the mutation storm', r.status === 200);
  }

  // ==========================================================================
  // D. mandate forgery and abuse
  // ==========================================================================

  {
    // an attacker "mandating" itself is cryptographically fine — and worthless
    const selfMandate = issueMandate(attacker, { agent: attacker.publicKey, budgetUsd: '100.00', allow: ['*'] });
    const r = await new TabClient({ agent: attacker, mandate: selfMandate }).fetch(`${GW}/quote`);
    check('self-issued mandate spends only its own (empty) wallet', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:insufficient-funds');

    // naming the victim as owner without the victim's key fails the signature
    const forged = { ...issueMandate(attacker, { agent: attacker.publicKey, budgetUsd: '100.00', allow: ['*'] }), owner: owner.publicKey };
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const ownerBefore = ownerBal();
    const r2 = await fetch(`${GW}/quote`, {
      headers: { authorization: `Tab ${b64u(JSON.stringify(signCredential(attacker, chal, forged as any)))}` },
    });
    check('mandate naming a victim owner fails, victim untouched', r2.status === 402
      && ((await r2.json()) as any).type === 'urn:tab:problem:mandate-invalid' && ownerBal() === ownerBefore);
  }

  {
    const stale = issueMandate(owner, {
      agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.local'], days: 1,
      now: new Date(Date.now() - 3 * 86_400_000),
    });
    const r = await rawPay(`${GW}/quote`, stale);
    let clientRefused = false;
    try { await new TabClient({ agent, mandate: stale }).fetch(`${GW}/quote`); } catch (e) { clientRefused = e instanceof PaymentRefused; }
    check('an expired mandate is refused by the client, and by the gateway when sent anyway', clientRefused && r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:mandate-invalid');
  }

  // ==========================================================================
  // E. settlement failure always lands in the buyer's favor
  // ==========================================================================

  {
    const ownerBefore = ownerBal();
    const cut = await new TabClient({ agent, mandate }).fetch(`${GW}/destroy`);
    check('upstream cutting the socket: 502, hold released', cut.status === 502
      && ((await cut.json()) as any).type === 'urn:tab:problem:upstream-failed' && ownerBal() === ownerBefore);
    const hang = await new TabClient({ agent, mandate }).fetch(`${GW}/hang`);
    check('upstream hanging: gateway times out, hold released', hang.status === 502 && ownerBal() === ownerBefore);
  }

  // ==========================================================================
  // F. catalog SSRF and hostile gateways
  // ==========================================================================

  {
    const publicCat = createCatalog({ store: new CatalogStore(join(scratch, 'cat-public.db')) });
    const catPort = await listen(publicCat);
    const CAT = `http://127.0.0.1:${catPort}`;
    const targets = [
      'http://127.0.0.1:1', 'http://localhost:80', 'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.8', 'http://192.168.1.1', 'http://[::1]:80', 'http://metadata.internal',
      // IPv4 in IPv6 clothing, and the special ranges the first guard missed
      'http://[::ffff:127.0.0.1]:1', 'http://[::ffff:a9fe:a9fe]', 'http://[::7f00:1]', 'http://[64:ff9b::7f00:1]',
      'http://[2002:7f00:1::]', 'http://198.18.0.1', 'http://127.0.0.1.nip.io:1',
    ];
    let refused = 0;
    for (const origin of targets) {
      const r = await fetch(`${CAT}/v1/announce`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }),
      });
      if (r.status === 403) refused++;
    }
    const stored = ((await (await fetch(`${CAT}/v1/catalog.json`)).json()) as any).gateways.length;
    check('a public catalog refuses every private/metadata announce', refused === targets.length && stored === 0,
      { refused, stored });
    const w = await fetch(`${CAT}/v1/wallet?origin=${encodeURIComponent('http://10.0.0.8')}&wallet=x`);
    check('the wallet proxy only fetches catalogued gateways', w.status === 403);
    publicCat.close();
  }

  {
    const devCat = createCatalog({ store: new CatalogStore(join(scratch, 'cat-dev.db')), allowPrivateOrigins: true });
    const catPort = await listen(devCat);
    const CAT = `http://127.0.0.1:${catPort}`;
    const announce = async (origin: string) =>
      (await (await fetch(`${CAT}/v1/announce`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }),
      })).json()) as any;

    const huge = createServer((_req, res) => { res.writeHead(200); res.end('x'.repeat(17_000_000)); });
    const hugePort = await listen(huge);
    const hugeRow = await announce(`http://127.0.0.1:${hugePort}`);
    check('multi-megabyte discovery documents are refused', hugeRow.ok === false && /large/.test(hugeRow.error));
    huge.close();

    const redirector = createServer((_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); });
    const redirPort = await listen(redirector);
    const redirRow = await announce(`http://127.0.0.1:${redirPort}`);
    check('discovery fetches refuse to follow redirects', redirRow.ok === false);
    redirector.close();

    const polluter = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"realm":"evil","services":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    });
    const polPort = await listen(polluter);
    await announce(`http://127.0.0.1:${polPort}`);
    check('hostile discovery JSON cannot pollute prototypes', ({} as any).polluted === undefined);
    polluter.close();

    // a hostile gateway: routes aimed at another host and port, its own origin and ok fields,
    // and receipts carrying markup
    const hostile = createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (p === '/.well-known/tab/receipts') {
        res.end(JSON.stringify({ receipts: [
          { id: 'aaaa', realm: 'evil', resource: 'GET /x', amount: '1', currency: '<img src=x onerror=alert(1)>', rail: 'ledger', ref: 'ledger:aaaa', at: new Date().toISOString() },
          { id: 'bbbb', realm: 'evil', resource: 'GET /x', amount: '1', currency: 'USD', rail: 'ledger', ref: 'ledger:bbbb', at: '9999-01-01T00:00:00Z' },
          { id: 'cccc', realm: 'evil', resource: 'GET /x', amount: '1', currency: 'USD', rail: 'ledger', ref: 'ledger:cccc', at: new Date().toISOString() },
        ] }));
        return;
      }
      res.end(JSON.stringify({ realm: 'evil', origin: 'javascript:alert(1)//', ok: true, public_receipts: true, services: [
        { name: 'a', prefix: ':6379/x', routes: [{ method: 'GET', path: '/admin', price: '0.01' }] },
        { name: 'b', prefix: '.127.0.0.1.nip.io', routes: [{ method: 'GET', path: '/admin', price: '0.01' }] },
        { name: 'c', prefix: '/fine', routes: [{ method: 'GET', path: '/ok', price: '0.01' }] },
      ] }));
    });
    const hostilePort = await listen(hostile);
    await announce(`http://127.0.0.1:${hostilePort}`);
    const found = ((await (await fetch(`${CAT}/v1/search?limit=100`)).json()) as any).results.filter((r: any) => r.realm === 'evil');
    check('a gateway cannot aim a route at another host or port through its prefix', found.length === 1 && found[0].url === `http://127.0.0.1:${hostilePort}/fine/ok`, found.map((r: any) => r.url));
    const gw = ((await (await fetch(`${CAT}/v1/catalog.json?services=0`)).json()) as any).gateways.find((g: any) => g.realm === 'evil');
    check("a gateway's discovery document cannot overwrite the catalog's origin and status", gw.origin === `http://127.0.0.1:${hostilePort}`);
    const rel = ((await (await fetch(`${CAT}/v1/receipts`)).json()) as any).receipts.filter((r: any) => r.realm === 'evil').map((r: any) => r.id);
    check('relayed receipts drop markup and future dates', rel.length === 1 && rel[0] === 'cccc', rel);
    check('a bad max_price is a 400, not a crash', (await fetch(`${CAT}/v1/search?max_price=abc`)).status === 400);
    hostile.close();
    devCat.close();
  }

  // ==========================================================================
  // G. durability and spec hygiene
  // ==========================================================================

  {
    // a credential paid before a restart must stay burned after it
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const auth = encodeCredentialHeader(signCredential(agent, chal, mandate));
    const first = await fetch(`${GW}/quote`, { headers: { authorization: auth } });
    const sellerBefore = sellerBal();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    store.close();
    store = new Store(dbPath);
    gateway = createGateway(spec, { store, upstreamTimeoutMs: 500 });
    const newPort = await listen(gateway);
    const replay = await fetch(`http://127.0.0.1:${newPort}/quote`, { headers: { authorization: auth } });
    check('restart forgets nothing: balances persist, replay stays dead', first.status === 200
      && replay.status === 402 && store.balance(seller.publicKey) === sellerBefore);
  }

  {
    let bad = 0;
    for (const price of ['-1', '1e3', '0.0000001', 'free', '1,00']) {
      const p = join(scratch, 'bad-spec.json');
      writeFileSync(p, JSON.stringify({ realm: 'r', recipient: 'x', upstream: 'http://x', routes: [{ method: 'GET', path: '/a', price }] }));
      try { loadSpec(p); } catch { bad++; }
    }
    check('malformed prices never load', bad === 5, { bad });
  }

  // ==========================================================================
  // G2. body constraints: a flat price buys one bounded operation
  // ==========================================================================

  {
    const client = new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.local'] }) });
    const GW = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`; // G restarted the gateway on a new port
    const before = ownerBal();
    // smuggle a key the route forbids, in every shape: prototype-ish, array body, a bare string, form text, a case variant
    const bodies = ['{"q":"x","__proto__":{"n":9}}', '[{"q":"x"}]', '"q"', 'q=x', '{"q":"x","N":1}', '{"q":"x","model":"huge"}'];
    let refused = 0;
    for (const body of bodies) {
      const r = await client.fetch(`${GW}/bounded`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.status === 400 && ((await r.json()) as any).type === 'urn:tab:problem:bad-request') refused++;
    }
    check('every smuggled body is refused before money moves', refused === bodies.length && ownerBal() === before, { refused });
    // a buyer may send the fixed key; the gateway overwrites it, so the flat price buys the bounded call either way
    const ok = await client.fetch(`${GW}/bounded`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"x","n":999}' });
    check('the allowed shape pays once and the upstream sees the fixed key, not the buyer\'s', ok.status === 200 && JSON.parse(((await ok.json()) as any).body).n === 1 && ownerBal() === before - 10_000);
  }

  // ==========================================================================
  // H. a dead settlement rail degrades, never crashes
  // ==========================================================================

  {
    const deadSpec: Spec = {
      ...spec, rail: 'evm',
      evm: { rpc: 'http://127.0.0.1:1', chain_id: 46630, token: '0x' + '11'.repeat(20),
        decimals: 6, recipient: '0x' + '22'.repeat(20) },
      services: [{ name: 'x', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
        routes: [{ method: 'GET', path: '/quote', price: '0.01' }, { method: 'GET', path: '/free', price: '0' }] }],
    };
    const deadStore = new Store(join(scratch, 'dead-rail.db'));
    const deadGw = createGateway(deadSpec, { store: deadStore });
    const port = await listen(deadGw);
    const priced = await fetch(`http://127.0.0.1:${port}/quote`);
    const free = await fetch(`http://127.0.0.1:${port}/free`);
    check('dead chain RPC: priced routes 502 cleanly, free routes still work',
      priced.status === 502 && ((await priced.json()) as any).type === 'urn:tab:problem:upstream-failed'
      && free.status === 200);
    deadGw.close();
    deadStore.close();
  }

  // ==========================================================================
  // J. hostile paths, globs and headers
  // ==========================================================================

  {
    const GW = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const bad = await fetch(`${GW}/%E0%A4%A`);
    const alive = await fetch(`${GW}/.well-known/tab`);
    check('a malformed percent escape is a 400, and the gateway is still up', bad.status === 400 && alive.status === 200);
    const walk = await (await fetch(`${GW}/free/..%2Fadmin`)).text();
    const walk2 = await fetch(`${GW}/item/%2e%2e%2Fadmin`);
    check('a :param cannot carry an encoded slash or dot segment to the upstream', !walk.includes('"/admin"') && walk2.status === 400);

    const stars = issueMandate(attacker, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*'.repeat(40) + 'Z'] });
    const t0 = Date.now();
    const r = await rawPay(`${GW}/quote`, stars).catch(() => null);
    check('a mandate glob of forty stars is refused in milliseconds, not minutes', Date.now() - t0 < 2_000 && r?.status === 402, Date.now() - t0);
    const m = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.*', '*.local'] });
    check('globs still match', realmAllowed(m, 'adv.local') && realmAllowed(m, 'x.local') && !realmAllowed(m, 'adv'));

    const paid = await new TabClient({ agent, mandate: m }).fetch(`${GW}/forge`);
    const rec = receiptOf(paid);
    check('an upstream cannot replace the signed receipt with its own Tab-Receipt', paid.status === 200 && !!rec && rec.sig !== undefined);
    const spoof = await (await fetch(`${GW}/free/1`, { headers: { 'tab-payer': 'someone-else' } })).json() as any;
    check('a buyer cannot name a payer to the upstream', spoof.payer === null);
    const junk = await fetch(`${GW}/quote`, { headers: { authorization: 'Tab ' + Buffer.from(JSON.stringify({ challenge: { id: 'x' }, mandate: {}, sig: '' })).toString('base64url') } });
    check('a credential over a challenge this gateway never issued is refused before the rate limit', junk.status === 402
      && ((await junk.json()) as any).type === 'urn:tab:problem:invalid-challenge');
  }

  // ==========================================================================
  // I. signed receipts: a receipt proves what was bought, not just that money moved
  // ==========================================================================

  {
    const GW = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const m = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['adv.local'] });
    const client = new TabClient({ agent, mandate: m });
    const init = { method: 'POST', body: '{"ask":"receipt"}' };
    const res = await client.fetch(`${GW}/echo?x=1`, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const rec = receiptOf(res)!;
    const key = ((await (await fetch(`${GW}/.well-known/tab`)).json()) as { receipt_key: string }).receipt_key;
    check('discovery publishes the receipt key, and it survived the restart in G', key === store.receiptKey.publicKey && rec.gateway === key);
    check('a paid receipt verifies: key, mandate, request and the body received', (await client.verify(`${GW}/echo?x=1`, res, bytes, init))?.ok === true);
    check('the receipt binds policy, request, response and payment', rec.mandate === m.id && rec.request?.query === '?x=1'
      && rec.request?.body_sha256 === bodyDigest(init.body) && rec.response?.status === 200
      && rec.response?.body_sha256 === bodyDigest(bytes) && typeof rec.challenge === 'string' && rec.ref.startsWith('ledger:'));

    const swapped = new TextEncoder().encode('{"path":"/echo","body":"something else"}');
    check('a body swapped in transit fails the receipt', (await client.verify(`${GW}/echo?x=1`, res, swapped, init))?.reason === 'response body does not match the receipt');
    check('a receipt for a different request fails', verifyReceipt(rec, { key, request: { query: '?x=2', body_sha256: rec.request!.body_sha256 } }).ok === false);
    check('a receipt under a different mandate fails', verifyReceipt(rec, { key, mandate: mandate.id }).reason === 'receipt names a different mandate');
    const inflated: Receipt = { ...rec, amount: '1' };
    check('editing any field breaks the signature', verifyReceipt(inflated, { key }).reason === 'receipt signature does not verify');
    const forged = signReceipt(attacker, { ...rec, response: { status: 200, body_sha256: bodyDigest(swapped) } });
    check('a receipt re-signed by another key fails against the published key', verifyReceipt(forged, { key, body: swapped }).reason === 'receipt was signed by a key the gateway does not publish');
    const legacy: Receipt = { ...rec, sig: undefined, gateway: undefined };
    check('an unsigned receipt never counts as verified', verifyReceipt(legacy, { key }).reason === 'unsigned receipt');

    const listed = ((await (await fetch(`${GW}/.well-known/tab/receipts?payer=${encodeURIComponent(agent.publicKey)}&limit=200`)).json()) as { receipts: Receipt[] }).receipts.find((r) => r.id === rec.id);
    check('the receipts endpoint returns the receipt exactly as signed', !!listed && verifyReceipt(listed, { key, mandate: m.id, body: bytes }).ok);

    const res402 = await client.fetch(`${GW}/destroy`);
    check('a failed upstream issues no receipt', res402.status === 502 && receiptOf(res402) === null);
  }

  gateway.close();
  upstream.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
