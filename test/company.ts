// The company suite: accounts and the trust boundary (host, origin, rate
// limits, isolation), founding and funding a company, hiring, tickets, runs
// through the http adapter paying at a real in-process gateway, spend
// attribution, evidence before done, sub-tickets, approvals, budget warning
// and pause, signed board actions, and the claude adapter through a fake binary.
//   npm run test:company

import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newKeyPair, type KeyPair } from '../src/keys.js';
import { usdToMicro } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { createGateway, type Spec } from '../src/gateway.js';
import { TabClient, receiptOf } from '../src/client.js';
import type { Mandate } from '../src/mandate.js';
import { CompanyStore } from '../src/company/store.js';
import { Engine } from '../src/company/engine.js';
import { createCompanyServer } from '../src/company/server.js';
import { signBoardAction, verifyBoardAction } from '../src/company/board.js';
import { parseResult, validateResult } from '../src/company/packet.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-co-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // -- a gateway with starter credits, selling one route ---------------------
  const seller = newKeyPair();
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quote: 'stub', path: req.url }));
  });
  const upPort = await listen(upstream);
  const spec: Spec = {
    realm: 'quotes.local', recipient: seller.publicKey, public_receipts: true,
    services: [{ name: 'q', prefix: '', upstream: `http://127.0.0.1:${upPort}`, routes: [{ method: 'GET', path: '/quote', price: '0.01' }] }],
  };
  const gwStore = new Store(join(scratch, 'gw.db'));
  const gateway = createGateway(spec, { store: gwStore, faucetUsd: '1.00', faucetPerIpPerDay: 100 });
  const GW = `http://127.0.0.1:${await listen(gateway)}`;

  // -- an http agent endpoint: pays at the gateway under the packet's mandate --
  const keys: Record<string, KeyPair> = {};
  const A = newKeyPair(); keys[A.publicKey] = A;
  const B = newKeyPair(); keys[B.publicKey] = B;
  const D = newKeyPair(); keys[D.publicKey] = D;
  const modes: Record<string, string> = {};
  let lastPacket: any = null;
  const stub = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const packet = JSON.parse(Buffer.concat(chunks).toString());
    lastPacket = packet;
    const mode = modes[packet.agent.name] ?? 'pay';
    const json = (s: number, d: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (mode === 'fail') return json(500, { error: 'agent exploded' });
    if (mode === 'pay' || mode === 'prose') {
      const mandate = packet.budget.mandate as Mandate;
      const agent = keys[packet.agent.agent];
      const r = await new TabClient({ agent, mandate }).fetch(`${GW}/quote`);
      const receipt = receiptOf(r);
      const result = { status: 'done', summary: `bought a quote, HTTP ${r.status}`, evidence: receipt ? [{ kind: 'receipt', value: receipt.id }] : [], comment: 'the quote was: stub' };
      if (mode === 'prose') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`Here is what I did.\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n`);
      }
      return json(200, result);
    }
    if (mode === 'no-evidence') return json(200, { status: 'done', summary: 'trust me' });
    if (mode === 'blocked') return json(200, { status: 'blocked', summary: 'need the api key' });
    if (mode === 'progress') return json(200, { status: 'in_progress', summary: 'still at it' });
    if (mode === 'spawn') return json(200, { status: 'in_progress', summary: 'delegating', new_tickets: [{ title: 'sub task', body: 'buy a quote', assignee: 'bee', budget: '0.05' }] });
    if (mode === 'request') return json(200, { status: 'in_progress', summary: 'need more', requests: [{ kind: 'budget', amount: '1.00', reason: 'bigger job' }] });
    if (mode === 'costly') return json(200, { result: { status: 'done', summary: 'expensive', evidence: [{ kind: 'text', value: 'out' }] }, cost_usd: 1.0 });
    if (mode === 'mention') return json(200, { status: 'in_progress', summary: 'bee, look', mentions: ['@bee'] });
    return json(200, { status: 'in_progress', summary: mode });
  });
  const STUB = `http://127.0.0.1:${await listen(stub)}`;

  // -- the company server ----------------------------------------------------
  const store = new CompanyStore(join(scratch, 'company.db'));
  const engine = new Engine({ store, workDir: join(scratch, 'work'), tickMs: 3_600_000, runTimeoutMs: 10_000 });
  const server = createCompanyServer({ store, engine, hosts: ['app.test'], allowPrivateOrigins: true, defaultGateway: GW, authPerWindow: 6, secureCookies: false });
  const port = await listen(server);
  const APP = `http://127.0.0.1:${port}`;

  let token = '';
  const raw = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(APP + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const api = async (method: string, path: string, body?: unknown, tok = token) => {
    const r = await raw(method, path, body, { authorization: `Bearer ${tok}` });
    return { status: r.status, body: (await r.json()) as any };
  };
  // node's fetch refuses to send a custom Host header, so the rebinding check needs a plain http request
  const withHost = (host: string, path: string) => new Promise<number>((resolve, reject) => {
    const r = request(APP + path, { method: 'GET', headers: { host, authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject);
    r.end();
  });
  const view = async () => (await api('GET', `/api/companies/${cid}`)).body;
  const runAll = async () => { await engine.tick(); await engine.drain(); };

  // -- 1. accounts and the trust boundary --------------------------------------
  const su = await raw('POST', '/api/signup', { email: 'Owner@Example.com', password: 'correct horse' });
  const suBody = (await su.json()) as any;
  const cookie = su.headers.get('set-cookie') ?? '';
  token = suBody.token;
  check('signup sets an HttpOnly SameSite cookie and returns a token', su.status === 200 && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && typeof token === 'string' && suBody.user.email === 'owner@example.com');
  check('weak password refused', (await raw('POST', '/api/signup', { email: 'x@example.com', password: 'short' })).status === 400);
  check('duplicate signup refused', (await raw('POST', '/api/signup', { email: 'owner@example.com', password: 'correct horse' })).status === 409);
  check('bearer token authenticates', (await api('GET', '/api/me')).body.user.email === 'owner@example.com');
  check('unknown Host is refused (DNS rebinding)', (await withHost('evil.test', '/api/me')) === 421 && (await withHost('app.test.evil', '/api/me')) === 421);
  check('the configured host and loopback are accepted', (await withHost('app.test', '/api/me')) === 200 && (await withHost(`localhost:${port}`, '/api/me')) === 200);
  const sessionCookie = cookie.split(';')[0];
  check('cookie mutation without an origin is refused', (await raw('POST', '/api/companies', { name: 'x' }, { cookie: sessionCookie })).status === 403);
  check('cookie mutation from a foreign origin is refused', (await raw('POST', '/api/companies', { name: 'x' }, { cookie: sessionCookie, origin: 'http://evil.test' })).status === 403);
  check('cookie mutation from the app origin passes the check', (await raw('POST', '/api/companies', {}, { cookie: sessionCookie, origin: APP })).status === 400);
  check('cookie reads work without an origin', (await raw('GET', '/api/me', undefined, { cookie: sessionCookie })).status === 200);
  check('no session is 401', (await raw('GET', '/api/companies')).status === 401);
  check('form posts are refused', (await fetch(APP + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` }, body: 'email=a&password=b' })).status === 415);
  let limited = 0;
  // the form post above already counted once, so six more wrong passwords reach the limit of six and the last is refused
  for (let i = 0; i < 6; i++) if ((await raw('POST', '/api/login', { email: 'owner@example.com', password: 'wrong wrong' })).status === 429) limited++;
  check('login is rate limited per address', limited === 1, { limited });
  const u2 = (await (await raw('POST', '/api/signup', { email: 'other@example.com', password: 'another one' })).json()) as any;
  const token2 = u2.token as string;

  // -- 2. founding and funding --------------------------------------------------
  const dead = await api('POST', '/api/companies', { name: 'Dead', gateways: ['http://127.0.0.1:1'] });
  check('a gateway that does not answer refuses the company', dead.status === 400 && /not reachable/.test(dead.body.error));
  const founded = await api('POST', '/api/companies', { name: 'Acme', mission: 'buy quotes', budget: '5.00', gateways: [GW] });
  const cid: string = founded.body.company.id;
  check('company founded with the gateway realm, currency and budget', founded.status === 200 && founded.body.company.realms[0] === 'quotes.local'
    && founded.body.company.currency === 'USD' && founded.body.company.budget === '5.00' && founded.body.company.spent.total === '0.00'
    && founded.body.company.owner_priv === undefined);
  check("another user's company is a 404", (await api('GET', `/api/companies/${cid}`, undefined, token2)).status === 404);
  const fund = await api('POST', `/api/companies/${cid}/fund`, {});
  const bal = await api('GET', `/api/companies/${cid}/balances`);
  check('starter credits claimed for the owner wallet', fund.body.results[0].credited === '1.00' && bal.body.balances[0].micro === 1_000_000);

  // -- 3. hiring: a signed board action per hire --------------------------------
  const ant = await api('POST', `/api/companies/${cid}/agents`, { name: 'ant', role: 'buyer', adapter: 'http', agent_pub: A.publicKey, config: { url: STUB }, budget_per_run: '0.02' });
  check('http agent hired with its own key, no custodial secret', ant.status === 200 && ant.body.agent.custodial === false && ant.body.agent.agent_priv === undefined);
  check('http agent without a key is refused', (await api('POST', `/api/companies/${cid}/agents`, { name: 'nokey', role: 'x', adapter: 'http', config: { url: STUB } })).status === 400);
  check('duplicate agent name refused', (await api('POST', `/api/companies/${cid}/agents`, { name: 'ant', role: 'x', adapter: 'http', agent_pub: B.publicKey, config: { url: STUB } })).status === 409);
  const bee = await api('POST', `/api/companies/${cid}/agents`, { name: 'bee', role: 'helper', adapter: 'http', agent_pub: B.publicKey, config: { url: STUB }, budget_per_run: '0.05' });
  const cat = await api('POST', `/api/companies/${cid}/agents`, { name: 'cat', role: 'coder', adapter: 'claude', budget_per_run: '0.10' });
  check('claude agent gets a custodial key the API never shows', cat.status === 200 && cat.body.agent.custodial === true && cat.body.agent.agent_priv === undefined
    && store.agent(cat.body.agent.id)!.agent_priv !== null);
  const board1 = await api('GET', `/api/companies/${cid}/board`);
  check('hires are signed board actions that verify', board1.body.actions.length === 3 && board1.body.actions.every((a: any) => a.action === 'hire' && a.verified === true) && board1.body.next_seq === 4);

  // -- 4. a ticket, a run, a receipt ---------------------------------------------
  const t1 = await api('POST', `/api/companies/${cid}/tickets`, { title: 'buy a quote', body: 'one quote please', assignee: 'ant', budget: '0.03' });
  check('ticket opens assigned', t1.status === 200 && t1.body.ticket.state === 'open' && store.wakes().some((w) => w.ticket_id === t1.body.ticket.id));
  await runAll();
  let v = await view();
  let tk = v.tickets.find((t: any) => t.id === t1.body.ticket.id);
  let run = v.runs[0];
  check('the run paid at the gateway and the ticket closed on a receipt', tk.state === 'done' && tk.evidence[0].kind === 'receipt' && tk.spent === '0.01'
    && run.state === 'done' && run.spent === '0.01' && run.agent === 'ant' && run.reason === 'assigned by owner');
  check('the mandate was the minimum of company, agent and ticket caps, scoped to the gateway realm', run.mandate.budget === '0.02' && run.mandate.allow[0] === 'quotes.local');
  check('spend booked against the company', v.company.spent.tab === '0.01' && v.company.spent.total === '0.01' && v.company.spent.remaining === '4.99');
  check('receipts attributed to the run', v.receipts.length === 1 && v.receipts[0].run_id === run.id && v.receipts[0].agent === 'ant' && v.receipts[0].amount === '0.01');
  check('events tell the story', v.events.some((e: any) => e.kind === 'run-started') && v.events.some((e: any) => e.kind === 'run' && e.body.status === 'done') && v.events.some((e: any) => e.kind === 'evidence'));
  check('the packet carries the contract and the mandate for this agent', lastPacket.ver === 'tab-company/0' && lastPacket.budget.mandate.agent === A.publicKey
    && lastPacket.contract.status && /Nothing closes without evidence/.test(lastPacket.prompt) && lastPacket.ticket.title === 'buy a quote');
  const runsBefore = v.runs.length;
  await runAll();
  check('a served wake does not run again', (await view()).runs.length === runsBefore);
  const thread = await api('GET', `/api/companies/${cid}/tickets/${tk.id}`);
  check('ticket thread endpoint', thread.body.thread.some((e: any) => e.kind === 'comment' && e.body.text === 'the quote was: stub'));

  // -- 5. evidence before done; blocked; prose output; adapter failure ----------
  modes.ant = 'no-evidence';
  const t2 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'claim done', assignee: 'ant' })).body.ticket;
  await runAll();
  check('done without evidence goes to review', (await view()).tickets.find((t: any) => t.id === t2.id).state === 'review');
  check('the owner cannot close it without a reason either', (await api('POST', `/api/companies/${cid}/tickets/${t2.id}`, { state: 'done' })).status === 400);
  const closed = await api('POST', `/api/companies/${cid}/tickets/${t2.id}`, { state: 'done', reason: 'checked by hand' });
  check('an owner reason is evidence', closed.body.ticket.state === 'done' && closed.body.ticket.evidence[0].kind === 'owner');
  modes.ant = 'blocked';
  const t3 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'blocked one', assignee: 'ant' })).body.ticket;
  await runAll();
  check('blocked status blocks the ticket', (await view()).tickets.find((t: any) => t.id === t3.id).state === 'blocked');
  modes.ant = 'prose';
  const t4 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'prose', assignee: 'ant' })).body.ticket;
  await runAll();
  check('a result inside prose is parsed', (await view()).tickets.find((t: any) => t.id === t4.id).state === 'done');
  modes.ant = 'fail';
  const t5 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'boom', assignee: 'ant' })).body.ticket;
  await runAll();
  v = await view();
  check('an adapter failure fails the run and blocks the ticket, nothing spent', v.runs[0].state === 'failed' && /HTTP 500/.test(v.runs[0].error)
    && v.tickets.find((t: any) => t.id === t5.id).state === 'blocked' && v.runs[0].spent === '0.00');

  // -- 6. sub-tickets and mentions ---------------------------------------------------
  modes.ant = 'spawn';
  modes.bee = 'pay';
  const t6 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'parent', assignee: 'ant' })).body.ticket;
  await runAll();
  v = await view();
  const sub = v.tickets.find((t: any) => t.parent_id === t6.id);
  check('an agent opened a sub-ticket for a colleague', sub && sub.assignee === 'bee' && sub.budget === '0.05' && sub.created_by_name === 'ant' && sub.state === 'open');
  await runAll();
  v = await view();
  check('the colleague ran it and closed it', v.tickets.find((t: any) => t.id === sub.id).state === 'done' && v.runs[0].agent === 'bee');
  check('the finished sub-ticket woke the parent owner', store.wakes().some((w) => w.ticket_id === t6.id && /sub-ticket/.test(w.reason)));
  modes.ant = 'pay';
  await runAll();
  check('the parent closed on the next run', (await view()).tickets.find((t: any) => t.id === t6.id).state === 'done');
  modes.ant = 'mention';
  const t7 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'mention', assignee: 'ant' })).body.ticket;
  await runAll();
  check('a mention in the result wakes that agent on the ticket', store.wakes().some((w) => w.ticket_id === t7.id && w.agent_id === bee.body.agent.id));
  await runAll();
  check('the mentioned agent ran with the reason', (await view()).runs[0].agent === 'bee' && /mentioned/.test((await view()).runs[0].reason));
  await api('POST', `/api/companies/${cid}/tickets/${t7.id}/comment`, { text: '@bee please look again' });
  check('an owner comment wakes the named agent', store.wakes().some((w) => w.ticket_id === t7.id && w.agent_id === bee.body.agent.id && /owner/.test(w.reason)));
  await runAll();

  // -- 7. approvals ----------------------------------------------------------------
  modes.ant = 'request';
  const t8 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'needs money', assignee: 'ant' })).body.ticket;
  await runAll();
  v = await view();
  const ap = v.approvals.find((a: any) => a.state === 'pending');
  check('an agent request becomes a pending approval', ap && ap.kind === 'budget' && ap.payload.amount === '1.00' && ap.agent === 'ant' && ap.ticket_id === t8.id);
  const approved = await api('POST', `/api/companies/${cid}/approvals/${ap.id}`, { decision: 'approve' });
  v = await view();
  check('approving a budget request raises the budget by a signed action and wakes the agent', approved.status === 200 && v.company.budget === '6.00'
    && v.board.some((b: any) => b.action === 'approve' && b.verified) && store.wakes().some((w) => w.ticket_id === t8.id && /approved/.test(w.reason)));
  check('an approval decides once', (await api('POST', `/api/companies/${cid}/approvals/${ap.id}`, { decision: 'reject' })).status === 409);
  modes.ant = 'progress';
  await runAll();

  // -- 8. budget: warn at 80 percent, pause at 100 -----------------------------------
  const spentNow = usdToMicro((await view()).company.spent.total);
  const tight = (spentNow + usdToMicro('0.012')) / 1_000_000;
  await api('POST', `/api/companies/${cid}/budget`, { budget: tight.toFixed(6) });
  modes.ant = 'pay';
  const t9 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'warn', assignee: 'ant' })).body.ticket;
  await runAll();
  v = await view();
  check('crossing 80 percent writes a warning', v.company.warned === true && v.events.some((e: any) => e.kind === 'budget-warning') && v.company.state === 'active'
    && v.tickets.find((t: any) => t.id === t9.id).state === 'done');
  modes.ant = 'costly';
  const t10 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'pause', assignee: 'ant' })).body.ticket;
  await runAll();
  v = await view();
  check('model cost counts and exhausting the budget pauses the company', v.company.state === 'paused' && v.company.spent.model === '1.00'
    && v.events.some((e: any) => e.kind === 'paused' && e.body.reason === 'budget exhausted') && v.company.spent.percent === 100);
  const t11 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'while paused', assignee: 'ant' })).body.ticket;
  const runsPaused = v.runs.length;
  await runAll();
  check('a paused company runs nothing and keeps the wake', (await view()).runs.length === runsPaused && store.wakes().some((w) => w.ticket_id === t11.id));
  check('resume is refused while the budget is exhausted', (await api('POST', `/api/companies/${cid}/resume`, {})).status === 409);
  await api('POST', `/api/companies/${cid}/budget`, { budget: '20.00' });
  check('after a raise, resume works', (await api('POST', `/api/companies/${cid}/resume`, {})).status === 200 && (await view()).company.state === 'active');
  modes.ant = 'pay';
  await runAll();
  check('the kept wake ran after the resume', (await view()).tickets.find((t: any) => t.id === t11.id).state === 'done');

  // -- 9. board actions signed offline with the exported key -------------------------
  const key = (await api('GET', `/api/companies/${cid}/key`)).body;
  check('the owner key exports and the export is logged', typeof key.privateKey === 'string' && (await view()).events.some((e: any) => e.kind === 'key-exported'));
  const owner: KeyPair = { publicKey: key.publicKey, privateKey: key.privateKey };
  let next = (await api('GET', `/api/companies/${cid}/board`)).body.next_seq as number;
  const pauseAct = signBoardAction(owner, { company: cid, seq: next, action: 'pause', payload: { reason: 'offline' }, at: new Date().toISOString() });
  check('a pre-signed action is accepted', (await api('POST', `/api/companies/${cid}/board`, { action: pauseAct })).status === 200 && (await view()).company.state === 'paused');
  check('replaying it is refused', (await api('POST', `/api/companies/${cid}/board`, { action: pauseAct })).status === 400);
  next++;
  const wrongKey = signBoardAction(newKeyPair(), { company: cid, seq: next, action: 'resume', payload: {}, at: new Date().toISOString() });
  check('a stranger\'s signature is refused', (await api('POST', `/api/companies/${cid}/board`, { action: wrongKey })).status === 400);
  const skip = signBoardAction(owner, { company: cid, seq: next + 5, action: 'resume', payload: {}, at: new Date().toISOString() });
  check('a gap in the sequence is refused', (await api('POST', `/api/companies/${cid}/board`, { action: skip })).status === 400);
  const resumeAct = signBoardAction(owner, { company: cid, seq: next, action: 'resume', payload: {}, at: new Date().toISOString() });
  check('the right one resumes', (await api('POST', `/api/companies/${cid}/board`, { action: resumeAct })).status === 200 && (await view()).company.state === 'active');
  check('the stored log verifies end to end', (await view()).board.every((b: any) => b.verified));
  check('verifyBoardAction pins company and seq', !verifyBoardAction(owner.publicKey, resumeAct, { company: 'other' }).ok && !verifyBoardAction(owner.publicKey, resumeAct, { seq: 1 }).ok
    && !verifyBoardAction(owner.publicKey, { ...resumeAct, payload: { reason: 'edited' } }).ok);

  // -- 10. retire and heartbeat --------------------------------------------------------
  await api('POST', `/api/companies/${cid}/agents/${bee.body.agent.id}/retire`, {});
  await api('POST', `/api/companies/${cid}/tickets/${t7.id}/comment`, { text: '@bee are you there' });
  const runsBeforeRetired = (await view()).runs.length;
  await runAll();
  check('a retired agent is never woken', (await view()).runs.length === runsBeforeRetired && (await view()).agents.find((a: any) => a.name === 'bee').state === 'retired');
  const dog = await api('POST', `/api/companies/${cid}/agents`, { name: 'dog', role: 'patroller', adapter: 'http', agent_pub: D.publicKey, config: { url: STUB }, budget_per_run: '0.01', heartbeat_s: 1 });
  modes.dog = 'progress';
  const t12 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'patrol', assignee: 'dog' })).body.ticket;
  await runAll();
  await sleep(1_100);
  await runAll();
  v = await view();
  check('a heartbeat re-runs an agent with open work', dog.status === 200 && v.runs[0].agent === 'dog' && v.runs[0].reason === 'heartbeat' && v.tickets.find((t: any) => t.id === t12.id).state === 'in_progress');

  // -- 11. the claude adapter through a fake binary ----------------------------------------
  const fake = join(scratch, 'fake-claude');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const i = process.argv.indexOf('--mcp-config');
  const mcp = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  const env = mcp.mcpServers.tab.env;
  const agent = JSON.parse(fs.readFileSync(env.TAB_AGENT, 'utf8'));
  const mandate = JSON.parse(fs.readFileSync(env.TAB_MANDATE, 'utf8'));
  const tools = process.argv[process.argv.indexOf('--allowedTools') + 1];
  const ok = mandate.agent === agent.publicKey && /tab_fetch/.test(tools) && process.argv[2] === '-p' && /work packet/.test(process.argv[3]) && /You are cat/.test(input) && process.argv.includes('--strict-mcp-config');
  const result = 'Done.\\n\`\`\`json\\n' + JSON.stringify({ status: 'done', summary: 'fake run', evidence: [{ kind: 'text', value: 'mcp:' + ok + ' cwd:' + process.cwd() }] }) + '\\n\`\`\`';
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result, total_cost_usd: 0.0123 }));
});
`);
  chmodSync(fake, 0o755);
  store.updateAgent(cat.body.agent.id, { config: { command: fake } });
  const t13 = (await api('POST', `/api/companies/${cid}/tickets`, { title: 'code it', assignee: 'cat' })).body.ticket;
  await runAll();
  v = await view();
  tk = v.tickets.find((t: any) => t.id === t13.id);
  check('claude adapter: key files, mcp config, prompt on stdin, result and cost parsed', tk.state === 'done' && /mcp:true/.test(tk.evidence[0].value)
    && tk.evidence[0].value.includes(join(scratch, 'work', cid)) && v.runs[0].model_cost === '0.0123' && v.runs[0].agent === 'cat');

  // -- 12. packet parsing and the rest of the surface ----------------------------------------
  check('parseResult takes the last fence or a bare object', parseResult('x ```json\n{"status":"blocked","summary":"a"}\n``` y ```json\n{"status":"done","summary":"b"}\n```')?.summary === 'b'
    && parseResult('nope {"status":"in_progress","summary":"c"} done')?.status === 'in_progress' && parseResult('nothing here') === null);
  check('validateResult rejects bad shapes and trims', validateResult({ status: 'later' }) === null && validateResult(null) === null
    && validateResult({ status: 'done', summary: 1, evidence: [{ kind: 'x', value: '' }, { value: 'ok' }] })?.evidence?.length === 1);
  const templates = await api('GET', '/api/templates');
  check('templates are served from examples/companies', templates.body.templates.length >= 2 && templates.body.templates.every((t: any) => t.name && t.agents.length));
  const fromTemplate = await api('POST', '/api/companies', { ...templates.body.templates[0], gateways: [GW] });
  check('a template founds a company with its agents and tickets', fromTemplate.status === 200 && fromTemplate.body.agents.length === 2
    && (await api('GET', `/api/companies/${fromTemplate.body.company.id}`)).body.tickets.length === 1);
  const page = await fetch(APP + '/');
  check('the dashboard is served with a CSP', page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? '') && /default-src 'self'/.test(page.headers.get('content-security-policy') ?? ''));
  const out = await raw('POST', '/api/logout', {}, { authorization: `Bearer ${token}` });
  check('logout ends the session', out.status === 200 && (await api('GET', '/api/me')).status === 401);

  // -- done ---------------------------------------------------------------------------
  server.close();
  stub.close();
  gateway.close();
  upstream.close();
  store.close();
  gwStore.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
