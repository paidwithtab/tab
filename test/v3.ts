// tab 3.0 end to end, on the ledger rail, all in one process on random ports with
// temp SQLite files: instant revoke (and gateways sharing revocations), sub-mandates,
// approval above a threshold, pay on delivery, payment channels with metered routes,
// and the MCP tools for each. The evm side of escrow and channels is in test/evm.ts.
//   npm run test:v3

import { createServer as createNetServer } from 'node:net';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { newKeyPair, saveKey, signBytes } from '../src/keys.js';
import { canonicalJson, sha256b64url, usdToMicro, verifyReceipt, parseChallengeHeader, signCredential, encodeCredentialHeader, VERSION } from '../src/protocol.js';
import { issueMandate, delegateMandate, verifyMandate, saveMandate, MAX_DELEGATION_DEPTH, type Mandate } from '../src/mandate.js';
import { signRevocation, verifyRevocation } from '../src/revoke.js';
import { signApproval, approvalRequestValid, type ApprovalRequest } from '../src/approval.js';
import { signVoucher, encodeVoucherHeader } from '../src/channel.js';
import { encodeX402 } from '../src/x402.js';
import { Store } from '../src/store.js';
import { LedgerRail } from '../src/rails/ledger.js';
import { createGateway, loadSpec, type Spec } from '../src/gateway.js';
import { TabClient, PaymentRefused, receiptOf, escrowOf, approvalRequestOf } from '../src/client.js';
import { createTabTools } from '../src/tools.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-v3-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
/** A gateway on a port chosen first, so its --origin is known: pay on delivery and channels require one. */
const gatewayAt = async (spec: Spec, o: Omit<Parameters<typeof createGateway>[1], 'origin'>): Promise<{ server: Server; url: string }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = createGateway(spec, { ...o, origin: url });
  await new Promise<void>((r) => server.listen(port, () => r()));
  return { server, url };
};
const execFileP = promisify(execFile);
async function cli(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8', env: { ...process.env, TAB_HOME: join(scratch, 'home') } });
    return { out: stdout.trim(), err: stderr.trim(), code: 0 };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number };
    return { out: (x.stdout ?? '').trim(), err: (x.stderr ?? '').trim(), code: x.code ?? 1 };
  }
}
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, doc: (await r.json()) as any };
};
const json = async (r: Response) => (await r.json()) as any;

async function main(): Promise<void> {
  // -- upstream: quotes, a long job that answers 202 and delivers later, a metered model ----

  let lastDelivery: { url: string; token: string; deadline: string } | null = null;
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    for await (const _ of req) { /* drain */ }
    const send = (s: number, d: unknown, h: Record<string, string> = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(d)); };
    if (u.pathname === '/quote') return send(200, { quote: 'q' });
    if (u.pathname === '/big') return send(200, { big: true });
    if (u.pathname === '/boom') return send(500, { error: 'boom' });
    if (u.pathname === '/job') {
      lastDelivery = { url: String(req.headers['tab-deliver']), token: String(req.headers['tab-delivery-token']), deadline: String(req.headers['tab-escrow-deadline']) };
      return send(202, { accepted: true });
    }
    if (u.pathname === '/now') return send(200, { delivered: 'at once' });
    if (u.pathname === '/model') return send(200, { completion: 'hi' }, { 'tab-units': u.searchParams.get('tokens') ?? '1234' });
    return send(404, { error: 'no' });
  });
  const UP = `http://127.0.0.1:${await listen(upstream)}`;

  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  const spec = (realm: string): Spec => ({
    realm, recipient: seller.publicKey, public_receipts: true, channels: { min_deposit: '0.05' },
    services: [{
      name: 'demo', prefix: '', upstream: UP, routes: [
        { method: 'GET', path: '/quote', price: '0.01' },
        { method: 'GET', path: '/big', price: '0.40' },
        { method: 'GET', path: '/boom', price: '0.01' },
        { method: 'POST', path: '/job', price: '0.05', escrow: { timeout_s: 30 } },
        { method: 'GET', path: '/now', price: '0.02', escrow: true },
        { method: 'GET', path: '/late', price: '0.03', escrow: { timeout_s: 1 } },
        { method: 'GET', path: '/model', price: '0.01', meter: { unit: 'token', per_unit: '0.000002' } },
      ],
    }],
  });
  // three gateways: A, B pushed to by A, C that polls A
  const storeA = new Store(join(scratch, 'a.db'));
  const storeB = new Store(join(scratch, 'b.db'));
  const storeC = new Store(join(scratch, 'c.db'));
  for (const st of [storeA, storeB, storeC]) st.credit(owner.publicKey, usdToMicro('20.00'));
  const { url: B } = await gatewayAt(spec('b.local'), { store: storeB, sweepMs: 200 });
  const { server: gwA, url: A } = await gatewayAt(spec('a.local'), { store: storeA, revocationPeers: [B], sweepMs: 200 });
  const { server: gwC, url: C } = await gatewayAt(spec('c.local'), { store: storeC, revocationPeers: [A], revocationPollMs: 300, sweepMs: 200 });

  const disc = await json(await fetch(`${A}/.well-known/tab`));
  check('discovery names the 3.0 features and where they live', disc.features.join(',') === 'revoke,delegation,approval,escrow,channels'
    && disc.revocations === '/.well-known/tab/revocations' && disc.channels.min_deposit === '0.05'
    && disc.services[0].routes.find((r: any) => r.path === '/job').escrow.timeout_s === 30
    && disc.services[0].routes.find((r: any) => r.path === '/model').meter.unit === 'token'
    && disc.services[0].routes.find((r: any) => r.path === '/quote').escrow === undefined);

  // -- 1. instant revoke ---------------------------------------------------------------

  const m1 = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5.00', maxPerCallUsd: '0.50', allow: ['*.local'] });
  const c1 = new TabClient({ agent, mandate: m1 });
  for (const g of [A, B, C]) check(`a fresh mandate pays at ${g === A ? 'A' : g === B ? 'B' : 'C'}`, (await c1.fetch(`${g}/quote`)).status === 200);

  const stranger = newKeyPair();
  const bogus = signRevocation(stranger, m1.id, 'not mine');
  check('a revocation verifies on its own', verifyRevocation(bogus) && !verifyRevocation({ ...bogus, mandate: m1.id.replace(/^./, 'x') }));
  const bogusRes = await post(`${A}/.well-known/tab/revocations`, bogus);
  check('a stranger\'s revocation is refused on intake and revokes nothing', bogusRes.status === 400 && /may not revoke/.test(bogusRes.doc.results[0].error)
    && (await c1.fetch(`${A}/quote`)).status === 200);
  check('a revocation that does not verify is refused', (await post(`${A}/.well-known/tab/revocations`, { ...bogus, reason: 'edited' })).status === 400);

  const rev = signRevocation(owner, m1.id, 'agent key leaked');
  const t0 = Date.now();
  check('the owner publishes a revocation', (await post(`${A}/.well-known/tab/revocations`, rev)).doc.results[0].new === true);
  const r1 = await c1.fetch(`${A}/quote`);
  const p1 = await json(r1);
  check('the gateway it went to refuses the mandate at once', r1.status === 402 && p1.type === 'urn:tab:problem:mandate-revoked');
  // B was pushed to; C polls A
  let bRefused = false, cRefused = false;
  while (Date.now() - t0 < 5_000 && !(bRefused && cRefused)) {
    await sleep(100);
    if (!bRefused) bRefused = (await json(await fetch(`${B}/.well-known/tab/revocations/${m1.id}`))).revoked;
    if (!cRefused) cRefused = (await json(await fetch(`${C}/.well-known/tab/revocations/${m1.id}`))).revoked;
  }
  check('a peer it pushes to has the revocation within seconds', bRefused && (await c1.fetch(`${B}/quote`)).status === 402);
  check('a peer that polls has it within seconds', cRefused && (await c1.fetch(`${C}/quote`)).status === 402, Date.now() - t0);
  const list = await json(await fetch(`${A}/.well-known/tab/revocations?after=0`));
  check('the revocation list serves peers in order, with a sequence and the mandate that authorizes it', list.revocations.length === 1 && list.revocations[0].mandate === m1.id
    && typeof list.revocations[0].seq === 'number' && list.revocations[0].mandate_doc?.id === m1.id);

  const m2 = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5.00', allow: ['*.local'] });
  const c2 = new TabClient({ agent, mandate: m2 });
  check('a new mandate for the same agent is unaffected', (await c2.fetch(`${A}/quote`)).status === 200);
  const self = signRevocation(agent, m2.id, 'done with it');
  await post(`${A}/.well-known/tab/revocations`, self);
  check('an agent can give up its own mandate', (await c2.fetch(`${A}/quote`)).status === 402);

  // the CLI: issue, revoke, status
  const ownerFile = join(scratch, 'owner.json'), agentFile = join(scratch, 'agent.json'), mFile = join(scratch, 'm3.json');
  saveKey(ownerFile, owner);
  saveKey(agentFile, agent);
  const m3 = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
  saveMandate(mFile, m3);
  const cliRev = await cli('mandate', 'revoke', '--key', ownerFile, '--mandate', mFile, '--reason', 'demo', '--gateway', C);
  check('tab mandate revoke signs and publishes', cliRev.code === 0 && JSON.parse(cliRev.out).mandate === m3.id && /revoked/.test(cliRev.err));
  const cliStatus = await cli('mandate', 'status', '--mandate', mFile, '--gateway', C);
  check('tab mandate status reports it revoked', cliStatus.code === 0 && JSON.parse(cliStatus.out)[C].revoked === true);

  // -- 2. sub-mandates ---------------------------------------------------------------------

  const manager = newKeyPair(), worker = newKeyPair(), helper = newKeyPair();
  const root = issueMandate(owner, { agent: manager.publicKey, budgetUsd: '1.00', maxPerCallUsd: '0.50', allow: ['a.local', 'b.local'], days: 1 });
  const child = delegateMandate(manager, root, { agent: worker.publicKey, budgetUsd: '0.10', maxPerCallUsd: '0.05', allow: ['a.local'] });
  check('a sub-mandate verifies with its whole chain', verifyMandate(child).ok && child.owner === owner.publicKey && child.parent?.id === root.id);
  check('a tampered sub-mandate fails', !verifyMandate({ ...child, budget: '900000' }).ok && !verifyMandate({ ...child, parent: { ...root, budget: '9000000' } }).ok);
  const refusedDelegations = [
    () => delegateMandate(manager, root, { agent: worker.publicKey, budgetUsd: '2.00' }),
    () => delegateMandate(manager, root, { agent: worker.publicKey, maxPerCallUsd: '0.60' }),
    () => delegateMandate(manager, root, { agent: worker.publicKey, allow: ['*.local'] }),
    () => delegateMandate(manager, root, { agent: worker.publicKey, window: 'day' }),
    () => delegateMandate(worker, root, { agent: helper.publicKey }),
  ].map((f) => { try { f(); return false; } catch { return true; } });
  check('a sub-mandate cannot exceed its parent: budget, per call, allow list, window, or be signed by another agent', refusedDelegations.every(Boolean), refusedDelegations);
  // a forged child that claims more than its parent, signed properly by the parent's agent: the gateway checks
  const loose = (() => {
    const body = { ...child, budget: '5000000', id: undefined, sig: undefined } as any;
    const canonical = canonicalJson({ ver: body.ver, owner: body.owner, agent: body.agent, budget: body.budget, window: body.window, max_per_call: body.max_per_call, allow: body.allow, issued_at: body.issued_at, expires_at: body.expires_at, evm_owner: body.evm_owner, approve_above: body.approve_above, parent: body.parent });
    return { ...body, id: sha256b64url(canonical), sig: signBytes(manager, Buffer.from(canonical)) } as Mandate;
  })();
  check('a signed sub-mandate wider than its parent is invalid', /budget exceeds its parent/.test(verifyMandate(loose).error ?? ''));
  let deep: Mandate = root;
  const keys = [manager];
  for (let i = 0; i < MAX_DELEGATION_DEPTH; i++) { const k = newKeyPair(); deep = delegateMandate(keys[i], deep, { agent: k.publicKey }); keys.push(k); }
  let tooDeep = false;
  try { delegateMandate(keys.at(-1)!, deep, { agent: helper.publicKey }); } catch (e) { tooDeep = /at most 3/.test((e as Error).message); }
  check(`chains stop at ${MAX_DELEGATION_DEPTH} delegations`, verifyMandate(deep).ok && tooDeep);

  const cw = new TabClient({ agent: worker, mandate: child });
  const paidChild = await cw.fetch(`${A}/quote`);
  const rec = receiptOf(paidChild)!;
  check('a worker pays under its sub-mandate', paidChild.status === 200 && rec.mandate === child.id && rec.owner === owner.publicKey && rec.payer === worker.publicKey);
  const spentRoot = await json(await fetch(`${A}/.well-known/tab/mandate/${root.id}/spent`));
  check('the spend counts against the parent too', spentRoot.micro === 10_000);
  let refusedRealm = '';
  try { await cw.fetch(`${B}/quote`); } catch (e) { refusedRealm = (e as PaymentRefused).reason; }
  check('the worker cannot spend where only the parent may', /not in the mandate's allow list/.test(refusedRealm));
  // two siblings share the parent's budget: the parent's counter stops them both
  const tight = issueMandate(owner, { agent: manager.publicKey, budgetUsd: '0.03', allow: ['a.local'] });
  const sibA = delegateMandate(manager, tight, { agent: worker.publicKey, budgetUsd: '0.02' });
  const sibB = delegateMandate(manager, tight, { agent: helper.publicKey, budgetUsd: '0.02' });
  const ca = new TabClient({ agent: worker, mandate: sibA }), cb = new TabClient({ agent: helper, mandate: sibB });
  const sib = [await ca.fetch(`${A}/quote`), await ca.fetch(`${A}/quote`), await cb.fetch(`${A}/quote`), await cb.fetch(`${A}/quote`)].map((r) => r.status);
  check('siblings together cannot spend past the parent budget', sib.join(',') === '200,200,200,402', sib);
  const failSpent = (await json(await fetch(`${A}/.well-known/tab/mandate/${tight.id}/spent`))).micro;
  await ca.fetch(`${A}/boom`).catch(() => null);
  check('a voided call gives the spend back to every level', (await json(await fetch(`${A}/.well-known/tab/mandate/${tight.id}/spent`))).micro === failSpent);
  // revoking the parent kills the child
  await post(`${A}/.well-known/tab/revocations`, signRevocation(owner, root.id));
  const afterParent = await cw.fetch(`${A}/quote`);
  check('revoking a parent kills every sub-mandate under it', afterParent.status === 402 && /sits under .*revoked/.test((await json(afterParent)).detail));
  // the delegating agent may revoke its own child
  const child2 = delegateMandate(manager, tight, { agent: worker.publicKey, budgetUsd: '0.01' });
  await post(`${A}/.well-known/tab/revocations`, { revocation: signRevocation(manager, child2.id), mandate: child2 });
  check('the delegating agent can revoke the sub-mandate it signed', (await new TabClient({ agent: worker, mandate: child2 }).fetch(`${A}/quote`)).status === 402);
  // the CLI delegates
  const mgrFile = join(scratch, 'manager.json'), rootFile = join(scratch, 'root.json'), childFile = join(scratch, 'child.json');
  saveKey(mgrFile, manager);
  const root2 = issueMandate(owner, { agent: manager.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
  saveMandate(rootFile, root2);
  const del = await cli('mandate', 'delegate', '--agent-key', mgrFile, '--mandate', rootFile, '--to', worker.publicKey, '--budget', '0.20', '--out', childFile);
  const delTooBig = await cli('mandate', 'delegate', '--agent-key', mgrFile, '--mandate', rootFile, '--to', worker.publicKey, '--budget', '2.00');
  check('tab mandate delegate writes a sub-mandate and refuses one wider than its parent', del.code === 0 && /sub-mandate/.test(del.err) && delTooBig.code !== 0 && /budget exceeds its parent/.test(delTooBig.err));

  // -- 3. approval above a threshold -------------------------------------------------------

  const careful = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5.00', allow: ['*.local'], approveAboveUsd: '0.10' });
  const cc = new TabClient({ agent, mandate: careful });
  check('payments at or under the threshold go through', (await cc.fetch(`${A}/quote`)).status === 200);
  const big = await cc.fetch(`${A}/big`);
  const req = (await approvalRequestOf(big))!;
  check('above it the gateway asks for the owner\'s approval', big.status === 402 && req && approvalRequestValid(req) && req.amount === '400000'
    && req.owner === owner.publicKey && req.payer === agent.publicKey && req.resource === 'GET /big');
  check('the approval request is the same on a retry, so the owner signs one thing', (await approvalRequestOf(await cc.fetch(`${A}/big`)))?.id === req.id);
  const before = storeA.balance(owner.publicKey);
  const theApproval = signApproval(owner, req);
  const approved = await cc.fetch(`${A}/big`, {}, { approval: theApproval });
  check('with the owner\'s approval attached the payment goes through', approved.status === 200 && storeA.balance(owner.publicKey) === before - 400_000);
  const again = await cc.fetch(`${A}/big`, {}, { approval: theApproval });
  check('an approval pays once; the gateway asks again', again.status === 402 && (await approvalRequestOf(again))?.id === req.id);
  let wrongSigner = '';
  try { signApproval(agent, req); } catch (e) { wrongSigner = (e as Error).message; }
  const forged = { ...signApproval(owner, req), by: agent.publicKey };
  const forgedRes = await cc.fetch(`${A}/big`, {}, { approval: forged });
  check('only the owner can approve', /another owner/.test(wrongSigner) && forgedRes.status === 402 && /not signed by the owner/.test((await json(forgedRes)).detail));
  // posted to the gateway, the agent's plain retry finds it; and a waiting client resumes by itself
  const waiting = cc.fetch(`${A}/big`, {}, { waitForApprovalMs: 8_000 });
  await sleep(600);
  const fresh = (await approvalRequestOf(await cc.fetch(`${A}/big`)))!;
  const postRes = await post(`${A}/.well-known/tab/approvals`, { request: fresh, approval: signApproval(owner, fresh) });
  const waited = await waiting;
  check('an approval posted to the gateway lets a waiting agent pay', postRes.status === 200 && waited.status === 200 && receiptOf(waited)?.amount === '400000');
  const childOfCareful = delegateMandate(agent, careful, { agent: worker.publicKey, budgetUsd: '1.00' });
  check('a sub-mandate keeps its parent\'s approval threshold', childOfCareful.approve_above === '100000'
    && (await approvalRequestOf(await new TabClient({ agent: worker, mandate: childOfCareful }).fetch(`${A}/big`)))?.owner === owner.publicKey);
  // the CLI approves a request file and posts it
  const reqFile = join(scratch, 'req.json');
  const r3 = (await approvalRequestOf(await cc.fetch(`${A}/big`)))!;
  writeFileSync(reqFile, JSON.stringify(r3));
  const cliApprove = await cli('mandate', 'approve', '--owner', ownerFile, '--request', reqFile, '--gateway', A);
  check('tab mandate approve signs and posts; the plain retry pays', cliApprove.code === 0 && /posted/.test(cliApprove.err) && (await cc.fetch(`${A}/big`)).status === 200);

  // -- 4. pay on delivery ------------------------------------------------------------------

  const buyer = new TabClient({ agent, mandate: m2.id ? issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5.00', allow: ['*.local'] }) : m2 });
  const balOwner = storeA.balance(owner.publicKey), balSeller = storeA.balance(seller.publicKey);
  const accepted = await buyer.fetch(`${A}/job`, { method: 'POST', body: '{"task":"write"}' }, { escrow: true });
  const ticket = escrowOf(accepted)!;
  check('an escrow call the seller accepts is held, not paid', accepted.status === 202 && ticket.state === 'held' && !receiptOf(accepted)
    && storeA.balance(owner.publicKey) === balOwner - 50_000 && storeA.balance(seller.publicKey) === balSeller);
  check('the seller is told where and by when to deliver', lastDelivery !== null && lastDelivery!.url.endsWith(`/.well-known/tab/escrow/${ticket.id}/deliver`) && lastDelivery!.deadline === ticket.deadline);
  const st1 = await json(await fetch(`${ticket.status}?token=${ticket.token}`));
  check('the buyer sees the order held', st1.state === 'held' && st1.amount === '0.05' && st1.result === null);
  check('the order needs its token', (await fetch(ticket.status)).status === 403 && (await fetch(`${lastDelivery!.url}`, { method: 'POST', body: 'x' })).status === 403);
  const result = '{"essay":"done"}';
  const del1 = await fetch(lastDelivery!.url, { method: 'POST', headers: { 'tab-delivery-token': lastDelivery!.token, 'content-type': 'application/json' }, body: result });
  const delDoc = await json(del1);
  check('the seller delivers and is paid', del1.status === 200 && delDoc.state === 'delivered' && storeA.balance(seller.publicKey) === balSeller + 50_000);
  check('a second delivery is refused', (await fetch(lastDelivery!.url, { method: 'POST', headers: { 'tab-delivery-token': lastDelivery!.token }, body: 'again' })).status === 409);
  const out = await buyer.escrowResult(ticket, 0);
  check('the buyer reads the result with a delivery receipt that binds request and result', out.state === 'delivered' && new TextDecoder().decode(out.body!) === result
    && out.verified?.ok === true && out.receipt?.escrow?.delivered_at !== undefined && out.receipt?.request?.body_sha256 === sha256b64url('{"task":"write"}'), out.verified);
  // the seller gives up: refunded at once
  const acc2 = await buyer.fetch(`${A}/job`, { method: 'POST', body: '{"task":"fail"}' }, { escrow: true });
  const t2 = escrowOf(acc2)!;
  const failed2 = await fetch(lastDelivery!.url.replace('/deliver', '/fail'), { method: 'POST', headers: { 'tab-delivery-token': lastDelivery!.token, 'tab-reason': 'out of stock' } });
  const st2 = await json(await fetch(`${t2.status}?token=${t2.token}`));
  check('a seller that cannot deliver refunds the buyer', failed2.status === 200 && st2.state === 'refunded' && /out of stock/.test(st2.reason) && storeA.balance(owner.publicKey) === balOwner - 50_000);
  // nobody delivers: the deadline refunds, and the budget comes back
  const lateMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.03', allow: ['*.local'] });
  const lateBuyer = new TabClient({ agent, mandate: lateMandate });
  lastDelivery = null;
  const acc3 = await lateBuyer.fetch(`${A}/late`, {}, { escrow: true });
  check('a route the upstream does not know still goes to escrow only on 2xx', acc3.status === 404 && !escrowOf(acc3));
  const jobLate = createServer((q, s) => { s.writeHead(202); s.end('{}'); });
  const lateUp = `http://127.0.0.1:${await listen(jobLate)}`;
  const lateStore = new Store(join(scratch, 'late.db'));
  lateStore.credit(owner.publicKey, usdToMicro('1.00'));
  const { server: lateGw, url: L } = await gatewayAt({ realm: 'late.local', recipient: seller.publicKey, services: [{ name: 'l', prefix: '', upstream: lateUp, routes: [{ method: 'GET', path: '/late', price: '0.03', escrow: { timeout_s: 1 } }] }] }, { store: lateStore, sweepMs: 200 });
  const acc4 = await lateBuyer.fetch(`${L}/late`, {}, { escrow: true });
  const t4 = escrowOf(acc4)!;
  const spentHeld = (await json(await fetch(`${L}/.well-known/tab/mandate/${lateMandate.id}/spent`))).micro;
  const waitOut = await lateBuyer.escrowResult(t4, 4_000);
  check('undelivered by the deadline, the order is refunded to the owner and the budget', acc4.status === 202 && spentHeld === 30_000 && waitOut.state === 'refunded'
    && lateStore.balance(owner.publicKey) === 1_000_000 && (await json(await fetch(`${L}/.well-known/tab/mandate/${lateMandate.id}/spent`))).micro === 0);
  // delivered at once: the receipt says it went through escrow
  const now1 = await buyer.fetch(`${A}/now`, {}, { escrow: true });
  const nowRec = receiptOf(now1)!;
  check('a seller that answers at once is paid at once, through escrow', now1.status === 200 && escrowOf(now1)?.state === 'delivered' && nowRec.escrow?.delivered_at !== undefined
    && (await buyer.verify(`${A}/now`, now1, new Uint8Array(Buffer.from(JSON.stringify({ delivered: 'at once' })))))?.ok === true);
  let notOffered = '';
  try { await buyer.fetch(`${A}/quote`, {}, { escrow: true }); } catch (e) { notOffered = (e as PaymentRefused).reason; }
  check('a buyer cannot ask for escrow on a route that does not offer it', /does not take pay on delivery/.test(notOffered));
  // a credential that claims escrow under a challenge without it is refused by the gateway too
  const plainChal = parseChallengeHeader((await fetch(`${A}/quote`)).headers.get('www-authenticate'))!;
  const sneaky = await fetch(`${A}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, plainChal, careful, { escrow: true })) } });
  check('the gateway refuses escrow it did not offer', sneaky.status === 402 && /does not take pay on delivery/.test((await json(sneaky)).detail));
  const orders = await json(await fetch(`${A}/.well-known/tab/escrow?payer=${agent.publicKey}`));
  check('a public gateway lists a payer\'s orders with their state', orders.orders.length >= 3 && orders.orders.some((o: any) => o.state === 'refunded') && orders.orders.some((o: any) => o.state === 'delivered' && o.receipt));

  // -- 5. payment channels -----------------------------------------------------------------

  const chMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', maxPerCallUsd: '0.05', allow: ['*.local'] });
  const chFile = join(scratch, 'channels.json');
  const payer = new TabClient({ agent, mandate: chMandate, channels: { file: chFile } });
  const ownerBefore = storeB.balance(owner.publicKey), sellerBefore = storeB.balance(seller.publicKey);
  let tooSmall = '';
  try { await payer.openChannel(B, '0.01'); } catch (e) { tooSmall = (e as Error).message; }
  check('a deposit under the gateway\'s minimum is refused', /smallest deposit is \$0\.05/.test(tooSmall));
  const opened = await payer.openChannel(B, '0.10');
  check('one deposit opens a channel, held by the gateway and counted against the mandate', opened.state === 'open' && opened.deposit === '100000'
    && storeB.balance(owner.publicKey) === ownerBefore - 100_000 && (await json(await fetch(`${B}/.well-known/tab/mandate/${chMandate.id}/spent`))).micro === 100_000);
  const v1 = await payer.fetch(`${B}/quote`);
  const vr1 = receiptOf(v1)!;
  check('a call pays by voucher: no new money moves', v1.status === 200 && vr1.channel?.kind === 'call' && vr1.amount === '10000' && vr1.ref === `channel:${opened.id}`
    && storeB.balance(owner.publicKey) === ownerBefore - 100_000);
  const v2 = await payer.fetch(`${B}/model?tokens=1234`);
  const vr2 = receiptOf(v2)!;
  check('a metered call costs the units the upstream reported, under a cent', vr2.amount === '2468' && vr2.channel?.units === 1234 && vr2.channel?.spent === '12468');
  const v3 = await payer.fetch(`${B}/model?tokens=999999`);
  check('a metered call never costs more than the route price', receiptOf(v3)?.amount === '10000');
  check('every voucher receipt is signed and verifies', (await payer.verify(`${B}/model?tokens=1234`, v2, new Uint8Array(Buffer.from(JSON.stringify({ completion: 'hi' })))))?.ok === true);
  const boom = await payer.fetch(`${B}/boom`);
  check('a failed upstream call charges the channel nothing', boom.status === 500 && payer.channels()[B].spent === '22468' && payer.channels()[B].held === '0');
  // a replayed voucher, and one that does not cover the call
  const held = payer.channels()[B];
  const vq = signVoucher(agent, { channel: held.id, amount: String(Number(held.spent) + 10_000), resource: 'GET /quote', query: '', body_sha256: sha256b64url('') });
  const once = await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(vq) } });
  const twice = await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(vq) } });
  check('a voucher pays once', once.status === 200 && twice.status === 402 && /already used/.test((await json(twice)).detail));
  const low = signVoucher(agent, { channel: held.id, amount: '1', resource: 'GET /quote', query: '', body_sha256: sha256b64url('') });
  const lowRes = await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(low) } });
  check('a voucher that does not cover the call is refused', lowRes.status === 402 && (await json(lowRes)).type === 'urn:tab:problem:channel-exhausted');
  const wrongReq = signVoucher(agent, { channel: held.id, amount: '99000', resource: 'GET /quote', query: '?x=1', body_sha256: sha256b64url('') });
  check('a voucher is bound to its request', (await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(wrongReq) } })).status === 402);
  const forgedV = signVoucher(stranger, { channel: held.id, amount: '99000', resource: 'GET /quote', query: '', body_sha256: sha256b64url('') });
  check('only the channel agent can sign its vouchers', (await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(forgedV) } })).status === 402);
  // spend the rest, then the client pays per call
  const spentNow = Number((await json(await fetch(`${B}/.well-known/tab/channels/${held.id}`))).channel.spent);
  const paidCalls: number[] = [];
  for (let i = 0; i < 8; i++) { const r = await payer.fetch(`${B}/quote`); paidCalls.push(receiptOf(r)?.channel ? 1 : 0); }
  check('when the deposit runs out the client pays per call', paidCalls.includes(0) && paidCalls.indexOf(0) === Math.floor((100_000 - spentNow) / 10_000), { paidCalls, spentNow });
  const st = (await json(await fetch(`${B}/.well-known/tab/channels/${held.id}`))).channel;
  check('the stranger cannot close it early', (await post(`${B}/.well-known/tab/channels/${held.id}/close`, { sig: 'x' })).status === 403);
  const sellerMid = storeB.balance(seller.publicKey), ownerMid = storeB.balance(owner.publicKey);
  const fresh2 = new TabClient({ agent, mandate: chMandate, channels: { file: chFile } });
  // the client forgot the exhausted channel; close it at the gateway with the agent's signature
  const closed = await post(`${B}/.well-known/tab/channels/${held.id}/close`, { sig: (await import('../src/channel.js')).signClose(agent, held.id) });
  check('closing settles once: the spent part to the seller, the rest back', closed.status === 200 && closed.doc.channel.state === 'closed'
    && storeB.balance(seller.publicKey) === sellerMid + Number(st.spent) && storeB.balance(owner.publicKey) === ownerMid + (100_000 - Number(st.spent))
    && closed.doc.receipt.channel.kind === 'settle' && verifyReceipt(closed.doc.receipt).ok, { st, closed: closed.doc });
  const spentAfter = (await json(await fetch(`${B}/.well-known/tab/mandate/${chMandate.id}/spent`))).micro;
  const perCall = Number(storeB.receipts(200, { payer: agent.publicKey }).filter((r) => r.mandate === chMandate.id && !r.channel).reduce((n, r) => n + Number(r.amount), 0));
  check('after close the mandate is charged what was used, not the deposit', spentAfter === Number(st.spent) + perCall, { spentAfter, st: st.spent, perCall });
  check('a closed channel takes no vouchers', (await fetch(`${B}/quote`, { headers: { authorization: encodeVoucherHeader(signVoucher(agent, { channel: held.id, amount: '100000', resource: 'GET /quote', query: '', body_sha256: sha256b64url('') })) } })).status === 402);
  void fresh2;
  // auto open from discovery, then revoke: vouchers stop and the sweeper settles
  const auto = new TabClient({ agent, mandate: chMandate, channels: { depositUsd: '0.05' } });
  const a1 = await auto.fetch(`${C}/quote`);
  const autoCh = auto.channels()[C];
  check('with a deposit set the client opens a channel on first use', receiptOf(a1)?.channel?.kind === 'call' && autoCh?.deposit === '50000');
  await post(`${C}/.well-known/tab/revocations`, signRevocation(owner, chMandate.id));
  let settled = false;
  for (let i = 0; i < 30 && !settled; i++) { await sleep(100); settled = (await json(await fetch(`${C}/.well-known/tab/channels/${autoCh.id}`))).channel.state === 'closed'; }
  check('revoking the mandate stops its channel and settles it', settled && storeC.balance(seller.publicKey) >= 10_000);
  // the CLI: open, list, close against A
  const home = join(scratch, 'home');
  const chM = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
  saveMandate(join(home, 'mandate.json'), chM);
  saveKey(join(home, 'agent.json'), agent);
  const o = await cli('channel', 'open', '--gateway', A, '--deposit', '0.20');
  const f1 = await cli('fetch', '--channel', `${A}/model?tokens=500`);
  const l1 = await cli('channel', 'list');
  const x1 = await cli('channel', 'close', '--gateway', A);
  check('tab channel open, fetch --channel, list, close', o.code === 0 && /of \$0\.20 spent over 0 calls/.test(o.out) && f1.code === 0 && /from channel/.test(f1.err)
    && /\$0\.001 of \$0\.20 spent over 1 call/.test(l1.out) && x1.code === 0 && /closed/.test(x1.out), { o, f1: f1.err, l1: l1.out, x1 });

  // -- 6. the MCP tools ---------------------------------------------------------------------

  const asked: ApprovalRequest[] = [];
  const toolsMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '2.00', maxPerCallUsd: '0.50', allow: ['*.local'], approveAboveUsd: '0.10' });
  const tools = createTabTools({ agent, mandate: toolsMandate, allowDelegate: true, onApprovalRequired: (r) => { asked.push(r); } });
  const plain = createTabTools({ agent, mandate: toolsMandate });
  check('B7: tab_delegate is off unless the host turns it on', !plain.list.some((t) => t.name === 'tab_delegate') && (await plain.call('tab_delegate', { agent: worker.publicKey, budget: '0.01' })).isError);
  const lim = JSON.parse((await tools.call('tab_limits', {})).text);
  check('tab_limits shows the approval threshold', lim.approve_above === '0.10' && lim.delegated_from === null);
  const pend = await tools.call('tab_fetch', { url: `${A}/big` });
  check('tab_fetch reports a pending approval and tells the host', pend.isError && JSON.parse(pend.text).approval_required === true && asked.length === 1 && asked[0].amount === '400000');
  await post(`${A}/.well-known/tab/approvals`, { request: asked[0], approval: signApproval(owner, asked[0]) });
  check('after the owner approves, the same tab_fetch pays', JSON.parse((await tools.call('tab_fetch', { url: `${A}/big` })).text).status === 200);
  const dl = await tools.call('tab_delegate', { agent: worker.publicKey, budget: '0.25' });
  const sub = JSON.parse(dl.text).sub_mandate as Mandate;
  check('tab_delegate hands out a verified sub-mandate', !dl.isError && verifyMandate(sub).ok && sub.parent?.id === toolsMandate.id && sub.approve_above === '100000');
  check('tab_delegate refuses more than it holds', (await tools.call('tab_delegate', { agent: worker.publicKey, budget: '9' })).isError);
  const subLimits = JSON.parse((await createTabTools({ agent: worker, mandate: sub }).call('tab_limits', {})).text);
  check('a delegated agent\'s tab_limits names the chain above it', subLimits.delegated_from?.[0]?.mandate === toolsMandate.id);
  const esc = JSON.parse((await tools.call('tab_fetch', { url: `${A}/job`, method: 'POST', body: '{"t":1}', escrow: true })).text);
  check('tab_fetch with escrow returns the order', esc.status === 202 && esc.escrow.state === 'held');
  await fetch(lastDelivery!.url, { method: 'POST', headers: { 'tab-delivery-token': lastDelivery!.token }, body: 'the result' });
  const escOut = JSON.parse((await tools.call('tab_escrow', { status: esc.escrow.status, token: esc.escrow.token })).text);
  check('tab_escrow reads the delivered result with its verified receipt', escOut.state === 'delivered' && escOut.body === 'the result' && escOut.receipt_verified === true);
  const chanOpen = await tools.call('tab_channel', { action: 'open', origin: A, deposit: '0.10' });
  const viaChan = JSON.parse((await tools.call('tab_fetch', { url: `${A}/quote` })).text);
  const chanList = JSON.parse((await tools.call('tab_channel', { action: 'list' })).text);
  const chanClose = JSON.parse((await tools.call('tab_channel', { action: 'close', origin: A })).text);
  check('tab_channel opens, tab_fetch pays from it, and it closes', !chanOpen.isError && viaChan.receipt.channel.kind === 'call' && chanList.channels.length === 1 && chanClose.channel.state === 'closed');

  // -- 7. specs and compatibility ---------------------------------------------------------

  const specFile = join(scratch, 'spec.json');
  writeFileSync(specFile, JSON.stringify({ realm: 'x', recipient: seller.publicKey, services: [{ name: 's', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/a', price: '0.01', meter: { unit: 'token' } }] }] }));
  let badMeter = '';
  try { loadSpec(specFile); } catch (e) { badMeter = (e as Error).message; }
  check('a meter without a unit price is a clear spec error', /meter needs/.test(badMeter));
  const old = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
  check('a 2.x mandate carries none of the new fields and still verifies', old.parent === undefined && old.approve_above === undefined && verifyMandate(old).ok
    && !JSON.stringify(old).includes('approve_above') && (await new TabClient({ agent, mandate: old }).fetch(`${A}/quote`)).status === 200);
  const legacyCred = signCredential(agent, parseChallengeHeader((await fetch(`${A}/quote`)).headers.get('www-authenticate'))!, old);
  check('a credential without escrow signs the 2.x message', legacyCred.escrow === undefined && !('escrow' in JSON.parse(JSON.stringify(legacyCred))) && VERSION === 'tab/0');

  // -- 8. security review: escrow and channels ------------------------------------------------

  {
    // R1: a buyer's Host header must not redirect the seller's delivery (and its token) to the buyer
    let stolen: string | null = null;
    const evil = createServer(async (q, r) => { for await (const _ of q) { /* drain */ } stolen = String(q.headers['tab-delivery-token'] ?? 'request'); r.writeHead(200); r.end('{}'); });
    const EVIL = `127.0.0.1:${await listen(evil)}`;
    let delivered: { url: string; token: string } | null = null;
    const honest = createServer(async (q, r) => {
      for await (const _ of q) { /* drain */ }
      delivered = { url: String(q.headers['tab-deliver']), token: String(q.headers['tab-delivery-token']) };
      r.writeHead(202, { 'content-type': 'application/json' }); r.end('{"accepted":true}');
      setTimeout(() => { void fetch(delivered!.url, { method: 'POST', headers: { 'tab-delivery-token': delivered!.token }, body: 'THE RESULT' }).catch(() => {}); }, 100);
    });
    const HON = `http://127.0.0.1:${await listen(honest)}`;
    const hs = new Store(join(scratch, 'host.db'));
    hs.credit(owner.publicKey, usdToMicro('1.00'));
    const hostSpec: Spec = { realm: 'g.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: HON, routes: [{ method: 'POST', path: '/job', price: '0.50', escrow: { timeout_s: 600 } }] }] };
    let noOrigin = '';
    try { createGateway(hostSpec, { store: hs }); } catch (e) { noOrigin = (e as Error).message; }
    check('R1: a gateway that takes pay on delivery refuses to start without --origin', /--origin/.test(noOrigin));
    const { server: hg, url: H } = await gatewayAt(hostSpec, { store: hs, sweepMs: 100 });
    const hostFetch = (url: any, init: any = {}) => new Promise<Response>((resolve, reject) => {
      const u = new URL(String(url)); const h: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => { h[k] = v; }); h.host = EVIL;
      const r = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: h }, async (resp) => {
        const chunks: Buffer[] = []; for await (const c of resp) chunks.push(c as Buffer);
        const hdrs = new Headers(); for (const [k, v] of Object.entries(resp.headers)) if (v !== undefined) hdrs.set(k, Array.isArray(v) ? v.join(', ') : v);
        resolve(new Response(resp.statusCode === 204 ? null : Buffer.concat(chunks), { status: resp.statusCode, headers: hdrs }));
      });
      r.on('error', reject); if (init.body) r.write(init.body); r.end();
    });
    const hm = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
    const hres = await new TabClient({ agent, mandate: hm, fetch: hostFetch as typeof fetch }).fetch(`${H}/job`, { method: 'POST', body: '{"task":"x"}' }, { escrow: true });
    const ht = escrowOf(hres)!;
    await sleep(500);
    check('R1: with a forged Host the seller still delivers to the gateway\'s own origin and nothing reaches the buyer\'s host', stolen === null && delivered!.url.startsWith(`${H}/`)
      && ht.status.startsWith(`${H}/`) && hs.escrow(ht.id)?.state === 'delivered' && hs.balance(seller.publicKey) === 500_000, { stolen, delivered, status: ht.status });
    hg.close(); evil.close(); honest.close();

    // R2: a payout that went out but reported an error never reopens the escrow to a second outcome
    let dl = { url: '', token: '' };
    const up2 = createServer(async (q, r) => { for await (const _ of q) { /* drain */ } dl = { url: String(q.headers['tab-deliver']), token: String(q.headers['tab-delivery-token']) }; r.writeHead(202); r.end('{}'); });
    const U2 = `http://127.0.0.1:${await listen(up2)}`;
    const s2 = new Store(join(scratch, 'ambig.db'));
    s2.credit(owner.publicKey, usdToMicro('1.00'));
    class Flaky extends LedgerRail {
      first = true;
      async payoutLocked(h: any, to: 'seller' | 'buyer', micro: number, key: string) {
        const r = await super.payoutLocked(h, to, micro, key);
        if (to === 'buyer' && this.first) { this.first = false; throw new Error('no receipt within 30000ms'); }
        return r;
      }
    }
    const { server: g2, url: G2 } = await gatewayAt({ realm: 'g.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: U2, routes: [{ method: 'POST', path: '/job', price: '0.50', escrow: { timeout_s: 600 } }] }] }, { store: s2, rail: new Flaky(s2), sweepMs: 100, payoutRetryMs: 100 });
    const am = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] });
    await new TabClient({ agent, mandate: am }).fetch(`${G2}/job`, { method: 'POST', body: '{}' }, { escrow: true });
    const f2 = await fetch(dl.url.replace('/deliver', '/fail'), { method: 'POST', headers: { 'tab-delivery-token': dl.token } });
    const d2 = await fetch(dl.url, { method: 'POST', headers: { 'tab-delivery-token': dl.token }, body: 'x' });
    await sleep(800);
    check('R2: after an ambiguous refund the seller cannot also be paid, and the retry credits nothing twice', f2.status === 200 && d2.status === 409
      && s2.balance(owner.publicKey) === 1_000_000 && s2.balance(seller.publicKey) === 0 && s2.escrow(dl.url.split('/').at(-2)!)?.payout_state === 'done', { owner: s2.balance(owner.publicKey), seller: s2.balance(seller.publicKey) });
    g2.close();

    // R5a, R5c: the result is served as an attachment, never as a page; an echoing upstream does not leak the token
    const echo = createServer(async (q, r) => { for await (const _ of q) { /* drain */ } r.writeHead(200, { 'content-type': 'text/html', 'x-echo': String(q.headers['tab-delivery-token']) }); r.end(`<script>alert(1)</script>${q.headers['tab-delivery-token']}`); });
    const s3 = new Store(join(scratch, 'echo.db'));
    s3.credit(owner.publicKey, usdToMicro('1.00'));
    const { server: g3, url: G3 } = await gatewayAt({ realm: 'g.local', recipient: seller.publicKey, public_receipts: false, channels: {}, services: [{ name: 'd', prefix: '', upstream: `http://127.0.0.1:${await listen(echo)}`, routes: [{ method: 'GET', path: '/page', price: '0.01', escrow: true }] }] }, { store: s3 });
    const ec = new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] }) });
    const er = await ec.fetch(`${G3}/page`, {}, { escrow: true });
    const ebody = await er.text();
    check('R5c: an upstream that echoes the delivery token hands the buyer "[redacted]", not the token', er.status === 200 && ebody.includes('[redacted]') && er.headers.get('x-echo') === null);
    const et = escrowOf(er)!;
    const asQuery = await fetch(`${et.status}/result?token=${et.token}`);
    const rr = await fetch(`${et.status}/result`, { headers: { 'tab-escrow-token': et.token } });
    check('R5a: the result is an attachment the browser will not sniff or run, and the token works in a header', rr.status === 200 && asQuery.status === 200
      && rr.headers.get('x-content-type-options') === 'nosniff' && rr.headers.get('content-disposition') === 'attachment' && /sandbox/.test(rr.headers.get('content-security-policy') ?? ''));
    check('R5b: channels are not listed on a gateway whose receipts are private', (await fetch(`${G3}/.well-known/tab/channels?agent=${agent.publicKey}`)).status === 404);
    g3.close(); echo.close();

    // R5d: a payout that keeps failing backs off and is marked stuck, not retried forever
    const s4 = new Store(join(scratch, 'stuck.db'));
    s4.credit(owner.publicKey, usdToMicro('1.00'));
    let tries = 0;
    class Broken extends LedgerRail { async payoutLocked(): Promise<string | null> { tries++; throw new Error('transfer reverts'); } }
    const { server: g4, url: G4 } = await gatewayAt({ realm: 'g.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: U2, routes: [{ method: 'POST', path: '/job', price: '0.10', escrow: { timeout_s: 600 } }] }] }, { store: s4, rail: new Broken(s4), sweepMs: 50, payoutRetryMs: 20, maxPayoutTries: 4 });
    await new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1.00', allow: ['*.local'] }) }).fetch(`${G4}/job`, { method: 'POST', body: '{}' }, { escrow: true });
    await fetch(dl.url.replace('/deliver', '/fail'), { method: 'POST', headers: { 'tab-delivery-token': dl.token } });
    await sleep(1500);
    const stuckId = dl.url.split('/').at(-2)!;
    check('R5d: a payout that keeps failing stops at its cap and shows stuck', tries === 4 && s4.escrow(stuckId)?.payout_state === 'stuck' && s4.payout(`escrow:${stuckId}:buyer`)?.state === 'stuck', { tries });
    g4.close(); up2.close();
  }

  // -- 9. security review: revoke, approvals ---------------------------------------------------

  {
    // B1: an approval dated in the future is refused, and a spent approval stays spent past the redeemed-set prune
    const rs = new Store(join(scratch, 'replay.db'));
    rs.credit(owner.publicKey, usdToMicro('10.00'));
    const { server: rg, url: RG } = await gatewayAt({ realm: 'a.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/big', price: '0.40' }, { method: 'GET', path: '/quote', price: '0.01' }] }] }, { store: rs });
    const rm = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '5', allow: ['*.local'], approveAboveUsd: '0.10' });
    const rc = new TabClient({ agent, mandate: rm });
    const strangerReq = approvalRequestOf(await rc.fetch(`${RG}/big`));
    const unseenPost = await post(`${RG}/.well-known/tab/approvals`, { request: await strangerReq, approval: signApproval(owner, (await strangerReq)!) });
    check('LOW a: a gateway takes posted approvals only for owners it was paid under', unseenPost.status === 400 && /not been paid under/.test(unseenPost.doc.error));
    await rc.fetch(`${RG}/quote`); // now this owner has paid here
    const rq = (await approvalRequestOf(await rc.fetch(`${RG}/big`)))!;
    const ahead = signApproval(owner, rq, 3_600_000, new Date(Date.now() + 3 * 3_600_000));
    const aheadPost = await post(`${RG}/.well-known/tab/approvals`, { request: rq, approval: ahead });
    check('B1: an approval dated hours ahead is refused', aheadPost.status === 400 && /future/.test(aheadPost.doc.error));
    await post(`${RG}/.well-known/tab/approvals`, { request: rq, approval: signApproval(owner, rq) });
    const paidOnce = await rc.fetch(`${RG}/big`);
    const gone = await json(await fetch(`${RG}/.well-known/tab/approvals/${rq.id}`));
    rs.pruneRedeemed(new Date(Date.now() + 3_600_000 + 1000).toISOString());
    const again = await rc.fetch(`${RG}/big`);
    check('B1: an approval pays once, its posted copy is gone, and pruning the redeemed set does not bring it back', paidOnce.status === 200 && gone.approved === false
      && again.status === 402 && (await json(await fetch(`${RG}/.well-known/tab/mandate/${rm.id}/spent`))).micro === 410_000);
    rg.close();

    // B4: intake checks authority, takes a batch in one go, and is rate limited per address
    const fs4 = new Store(join(scratch, 'flood.db'));
    const { server: fg, url: FG } = await gatewayAt({ realm: 'a.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/q', price: '0.01' }] }] }, { store: fs4, revocationPostsPerMinute: 5 });
    const junk = Array.from({ length: 100 }, () => signRevocation(newKeyPair(), 'A'.repeat(43), 'x'.repeat(400)));
    const flood = await post(`${FG}/.well-known/tab/revocations`, junk);
    const unseen = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', allow: ['*.local'] });
    const bare = await post(`${FG}/.well-known/tab/revocations`, signRevocation(owner, unseen.id));
    const withDoc = await post(`${FG}/.well-known/tab/revocations`, { revocation: signRevocation(owner, unseen.id), mandate: unseen });
    check('B4: revocations no mandate authorizes are refused and nothing is stored', flood.status === 200 && flood.doc.results.every((r: any) => r.error)
      && bare.status === 400 && /has not seen/.test(bare.doc.results[0].error) && withDoc.doc.results[0].new === true);
    // M4: a mandate this gateway was never paid under (anyone can mint one and revoke it) is held aside, not shared
    check('M4: a revocation for a chain this gateway never saw is kept pending: not listed for peers, but in force here', withDoc.doc.results[0].pending === true
      && fs4.revocationsAfter(0).length === 0 && fs4.pendingRevocationCount() === 1 && (await json(await fetch(`${FG}/.well-known/tab/revocations/${unseen.id}`))).revoked === true);
    fs4.credit(owner.publicKey, usdToMicro('1.00'));
    const presented = await new TabClient({ agent, mandate: unseen }).fetch(`${FG}/q`);
    check('M4: when that mandate is presented it is refused, and its revocation joins the shared list', presented.status === 402 && (await json(presented)).type === 'urn:tab:problem:mandate-revoked'
      && fs4.revocationsAfter(0).length === 1 && fs4.pendingRevocationCount() === 0);
    let limited = 0;
    for (let i = 0; i < 6; i++) if ((await post(`${FG}/.well-known/tab/revocations`, signRevocation(owner, unseen.id))).status === 429) limited++;
    check('B4: revocation posts are rate limited per address', limited >= 3, { limited });
    fg.close();

    // B5: a peer reading more than one page misses nothing, whatever the clock says
    const ps = new Store(join(scratch, 'pa.db')), pc = new Store(join(scratch, 'pc.db'));
    const { server: pa, url: PA } = await gatewayAt({ realm: 'a.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/q', price: '0.01' }] }] }, { store: ps });
    const many = Array.from({ length: 650 }, (_, i) => issueMandate(owner, { agent: agent.publicKey, budgetUsd: (1 + i / 1_000_000).toFixed(6), allow: ['*.local'] }));
    ps.rememberMandates(many); // as if each had paid here: their revocations are shared
    for (let i = 0; i < many.length; i += 100) await post(`${PA}/.well-known/tab/revocations`, many.slice(i, i + 100).map((m) => ({ revocation: signRevocation(owner, m.id), mandate: m })));
    const { server: pcg, url: PC } = await gatewayAt({ realm: 'c.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/q', price: '0.01' }] }] }, { store: pc, revocationPeers: [PA], revocationPollMs: 200 });
    for (let i = 0; i < 50 && pc.revocationsAfter(0, 1000).length < 650; i++) await sleep(100);
    check('B5: a polling peer gets every revocation across pages', pc.revocationsAfter(0, 1000).length === 650 && (await json(await fetch(`${PC}/.well-known/tab/revocations/${many[649].id}`))).revoked === true, { a: ps.revocationsAfter(0, 1000).length, c: pc.revocationsAfter(0, 1000).length });
    pa.close(); pcg.close();

    // M4: the post limiter forgets the least recently seen address past its cap, never everyone at once
    const ls = new Store(join(scratch, 'lru.db'));
    const { server: lg, url: LG } = await gatewayAt({ realm: 'a.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/q', price: '0.01' }] }] }, { store: ls, revocationPostsPerMinute: 2, rateBucketCap: 3 });
    const from = async (ip: string) => (await fetch(`${LG}/.well-known/tab/revocations`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '[]' })).status;
    await from('10.0.0.1'); await from('10.0.0.1');
    const limitedX = await from('10.0.0.1');
    await from('10.0.0.2'); await from('10.0.0.3');
    await from('10.0.0.1'); // still limited, and now the most recently seen
    await from('10.0.0.4'); // past the cap: 10.0.0.2 is forgotten, not everyone
    check('M4: a limited address stays limited when other addresses fill the limiter', limitedX === 429 && (await from('10.0.0.1')) === 429);
    lg.close();

    // LOW d: what the client paid tab gateways counts toward the mandate's budget at x402 sites
    const x402site = createServer((q, r) => {
      r.writeHead(402, { 'payment-required': encodeX402({ x402Version: 2, resource: { url: 'http://site/x' }, accepts: [{ scheme: 'exact', network: 'eip155:46630', amount: '5000', asset: '0x5b6c7caf7f99f99154fd8375ec935fcf03f326f5', payTo: '0x' + '55'.repeat(20), maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] }) });
      r.end('{}');
    });
    const XS = `http://127.0.0.1:${await listen(x402site)}`;
    const both = new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.012', allow: ['*'] }) });
    await both.fetch(`${B}/quote`);
    let x402Refusal = '';
    try { await both.fetch(`${XS}/x`); } catch (e) { x402Refusal = (e as PaymentRefused).reason; }
    check('LOW d: a gateway payment counts toward the budget the client checks at x402 sites', /would pass the mandate budget \(x402 spend so far 0\.01\)/.test(x402Refusal), x402Refusal);
    x402site.close();

    // M1: a ledger hold left reserved by a process that died mid-call is released at the next start
    const cs = new Store(join(scratch, 'crash.db'));
    cs.credit(owner.publicKey, usdToMicro('1.00'));
    cs.debit(owner.publicKey, 50_000);
    cs.createHold({ id: 'crashhold', challenge_id: 'c', amount: 50_000, payer: agent.publicKey, owner: owner.publicKey, recipient: seller.publicKey, resource: 'GET /q', realm: 'a.local', rail: 'ledger', mandate_id: 'm', window_key: '', state: 'reserved', ref: null, tx: null, tx_hash: null, created_at: new Date().toISOString() });
    const restarted = createGateway({ realm: 'a.local', recipient: seller.publicKey, services: [{ name: 'd', prefix: '', upstream: UP, routes: [{ method: 'GET', path: '/q', price: '0.01' }] }] }, { store: cs });
    check('M1: a hold a dead process left reserved is released when the gateway starts', cs.getHold('crashhold')!.state === 'voided' && cs.balance(owner.publicKey) === 1_000_000);
    restarted.close();

    // B6: tab mandate status checks authority itself instead of taking a gateway's word
    const liar = createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ revoked: true, revocations: [signRevocation(newKeyPair(), m3.id)] })); });
    const LIAR = `http://127.0.0.1:${await listen(liar)}`;
    const liarStatus = await cli('mandate', 'status', '--mandate', mFile, '--gateway', LIAR);
    check('B6: a gateway that calls a mandate revoked on a stranger\'s word does not fool tab mandate status', liarStatus.code === 0 && JSON.parse(liarStatus.out)[LIAR].revoked === false, liarStatus);
    liar.close();
  }

  gwA.close(); gwC.close(); lateGw.close(); jobLate.close(); upstream.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
