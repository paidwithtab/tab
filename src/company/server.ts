// The company server: accounts and sessions, the JSON API the dashboard and
// the CLI use, static files for the dashboard, and the trust boundary. It
// rejects any Host it was not started for (DNS rebinding), requires a same
// origin header on cookie-authenticated mutations, keeps sessions in HttpOnly
// cookies, rate limits sign up and log in per address, and signs every board
// action with the company owner key (or verifies one signed offline).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { microToUsd, usdToMicro, normalizeUsd, isCurrency, microToBaseUnits, baseUnitsToMicro, type Receipt } from '../protocol.js';
import { newKeyPair, type KeyPair } from '../keys.js';
import { issueMandate, mandateChain, approvalThreshold, parseHours, describeHours, type Mandate, type MandateHours } from '../mandate.js';
import { signRevocation, type Revocation } from '../revoke.js';
import { signApproval, approvalRequestValid, type ApprovalRequest } from '../approval.js';
import { TabClient } from '../client.js';
import { addressFromSeed } from '../evm/secp256k1.js';
import { EvmRpc } from '../evm/rpc.js';
import { evmSend } from '../evm/send.js';
import { erc20, hexToBig } from '../evm/tx.js';
import { originIsPublic } from '../catalog.js';
import { guardedFetch } from '../net.js';
import { signBoardAction, verifyBoardAction, BOARD_ACTIONS, type SignedBoardAction, type BoardActionKind } from './board.js';
import { ADAPTERS, type AdapterName } from './adapters.js';
import { ANTHROPIC_URL } from './model.js';
import type { Engine } from './engine.js';
import type { Secrets } from './secrets.js';
import type { AgentRow, CompanyRow, CompanyStore, TicketRow, TicketState, UserRow, OrderRow } from './store.js';

export interface CompanyServerOptions {
  store: CompanyStore;
  engine: Engine;
  /** Host header values this server answers to (hostname or host:port). Loopback names are always accepted. */
  hosts?: string[];
  /** Set the Secure flag on the session cookie. Default: on unless every allowed host is loopback. */
  secureCookies?: boolean;
  /** Where a new company spends when it names no gateway. */
  defaultGateway?: string;
  defaultCatalog?: string | null;
  /** Accept gateways on private addresses (local development, tests). */
  allowPrivateOrigins?: boolean;
  /** Sign ups and log ins per address per 15 minutes. Default 20. */
  authPerWindow?: number;
  /** Seals company model keys at rest. Without it, model keys cannot be set. */
  secrets?: Secrets;
  /** Adapters a company may hire. Default claude, http and starter; claude-code only where the host runs Claude Code. */
  adapters?: AdapterName[];
  /** Whether the engine has a host key for companies that set none (shown to the dashboard; the key itself stays in the engine). */
  hostModelKey?: boolean;
  /** Where model keys are verified; tests point it at a stub. */
  anthropicUrl?: string;
  /** Starter credit claims granted a day across all users (default 200). */
  starterCreditsPerDay?: number;
  /** RPC endpoints by chain id, for companies that spend at an evm-rail gateway. Default: Robinhood Chain mainnet and testnet. */
  evmRpc?: Record<number, string>;
  log?: (msg: string) => void;
}

const EVM_RPC: Record<number, string> = {
  4663: 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-mainnet.drpc.org,https://robinhood-rpc.publicnode.com,https://4663.rpc.thirdweb.com',
  46630: 'https://rpc.testnet.chain.robinhood.com,https://robinhood-testnet.drpc.org,https://46630.rpc.thirdweb.com',
};
// an agent on an evm-rail gateway sends its own payment transactions, so it needs a little ETH for gas: sized from the
// chain's gas price at the 250k gas limit and twice the price that payments are signed with, topped up below 10 payments to 25
const GAS_TX = 250_000n * 2n;
const GAS_FLOOR_TXS = 10n;
const GAS_TOP_UP_TXS = 25n;
const seedOf = (priv: string) => new Uint8Array(Buffer.from(priv, 'base64url'));
const eth = (wei: bigint) => (Number(wei / 1_000_000_000_000n) / 1e6).toFixed(6);

const MAX_BODY = 1_000_000;
const COOKIE = 'tab_session';
const TICKET_STATES: ReadonlySet<string> = new Set(['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const QUICKSTART_MISSION = 'A first look at tab: one agent, a one dollar budget, and receipts for everything it pays for. Hire a claude agent on your Anthropic key when you are ready for real work.';
const STARTER_INSTRUCTIONS = 'Looks the ticket subject up on Wikipedia through the company gateway: one paid search, one paid summary, both receipts attached as evidence. Needs no model key.';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(body, null, 1));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'send application/json');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body is not a JSON object');
  }
}

// forwarded headers are believed only from a proxy on this machine (cloudflared); anyone else
// could set them to dodge the per-address limits
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const viaLocalProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!viaLocalProxy) return peer;
  return String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? peer).split(',')[0].trim();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname.endsWith('.localhost');
}

// tab OS asks for its images as /os-ic-home.png?v=<this>: a hash over every os-* image's size and time, so a
// changed icon gets a new address and no browser, worker or edge cache can keep handing out the old one
let assetMemo = { key: '', v: '' };
function assetVersion(web: string): string {
  const files = readdirSync(web).filter((f) => f.startsWith('os-') && /\.(png|jpg)$/.test(f)).sort();
  const key = files.map((f) => { const st = statSync(join(web, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
  if (key !== assetMemo.key) assetMemo = { key, v: createHash('sha256').update(key).digest('hex').slice(0, 10) };
  return assetMemo.v;
}

function findWeb(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../web', '../../../web']) {
    const p = join(here, rel);
    if (existsSync(join(p, 'os.html'))) return p;
  }
  return null;
}

const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2', html: 'text/html; charset=utf-8' };

const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.slice(0, max) : '');

export function createCompanyServer(opts: CompanyServerOptions): Server {
  const { store, engine } = opts;
  const log = opts.log ?? (() => {});
  const hosts = new Set((opts.hosts ?? []).map((h) => h.toLowerCase()));
  const secure = opts.secureCookies ?? [...hosts].some((h) => !isLoopbackHost(h.replace(/:\d+$/, '')));
  const authPerWindow = opts.authPerWindow ?? 20;
  const adapters = new Set<AdapterName>(opts.adapters ?? ['claude', 'http', 'starter']);
  const anthropicUrl = (opts.anthropicUrl ?? ANTHROPIC_URL).replace(/\/$/, '');
  const web = findWeb();

  function hostAllowed(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!host) return false;
    if (hosts.has(host)) return true;
    const bare = host.replace(/:\d+$/, '');
    return isLoopbackHost(bare) || hosts.has(bare);
  }

  function originAllowed(origin: string): boolean {
    try {
      const u = new URL(origin);
      return hosts.has(u.host.toLowerCase()) || hosts.has(u.hostname.toLowerCase()) || isLoopbackHost(u.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function setCookie(res: ServerResponse, value: string, maxAge: number): Record<string, string> {
    return { 'set-cookie': `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}` };
  }

  /** The signed-in user, and whether the session came from the cookie (then mutations need a same-origin header). */
  function authenticate(req: IncomingMessage): { user: UserRow; session: string; viaCookie: boolean } | null {
    const auth = String(req.headers.authorization ?? '');
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,})$/.exec(auth);
    if (m) {
      const user = store.userBySession(m[1]);
      return user ? { user, session: m[1], viaCookie: false } : null;
    }
    const c = cookies(req)[COOKIE];
    if (c && /^[A-Za-z0-9_-]{16,}$/.test(c)) {
      const user = store.userBySession(c);
      return user ? { user, session: c, viaCookie: true } : null;
    }
    return null;
  }

  // every fetch to an address a user named (gateways, the selling gateway) goes through the egress
  // guard: public addresses only, no redirects. Tests and local development opt out.
  const egress: typeof fetch = opts.allowPrivateOrigins ? fetch : guardedFetch({ timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 });

  /** The first gateway this company spends at that settles on chain, with an RPC for it; null when all are ledger gateways. */
  const chainMemo = new Map<string, { at: number; doc: Record<string, any> | null }>();
  /** A gateway's discovery document, cached for five minutes; null when it does not answer. */
  async function discoveryOf(origin: string): Promise<Record<string, any> | null> {
    let hit = chainMemo.get(origin);
    if (!hit || Date.now() - hit.at > 300_000) {
      let doc: Record<string, any> | null = null;
      try { const r = await egress(origin + '/.well-known/tab', { signal: AbortSignal.timeout(8_000), redirect: 'error' }); if (r.ok) doc = (await r.json()) as Record<string, any>; } catch { /* unreachable */ }
      hit = { at: Date.now(), doc };
      chainMemo.set(origin, hit);
    }
    return hit.doc;
  }
  async function chainOf(c: CompanyRow) {
    for (const origin of c.gateways) {
      const hit = { doc: await discoveryOf(origin) };
      const info = hit.doc?.rail === 'evm' ? hit.doc.rail_info : null;
      const rpc = info && (opts.evmRpc ?? EVM_RPC)[Number(info.chain_id)];
      if (!info || !rpc || typeof info.token !== 'string') continue;
      return { origin, chain_id: Number(info.chain_id), token: info.token.toLowerCase() as string, decimals: Number(info.decimals ?? 6), explorer: typeof info.explorer === 'string' ? info.explorer : null, rpc: new EvmRpc(rpc) };
    }
    return null;
  }

  /** A bare origin, or null: http(s), no credentials, no path, query or fragment. */
  function bareOrigin(raw: string): string | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    if (raw.replace(/\/$/, '') !== u.origin) return null;
    return u.origin;
  }

  async function checkGateways(origins: string[]): Promise<{ realms: string[]; currency: string }> {
    const realms: string[] = [];
    let currency: string | null = null;
    for (const origin of origins) {
      if (!bareOrigin(origin)) throw new HttpError(400, `gateway must be an origin like https://pay.example.com, got ${origin}`);
      if (!opts.allowPrivateOrigins) {
        const pub = await originIsPublic(origin);
        if (!pub.ok) throw new HttpError(400, `gateway ${origin} refused: ${pub.reason}`);
      }
      let doc: { realm?: unknown; currency?: unknown };
      try {
        const r = await egress(origin + '/.well-known/tab', { signal: AbortSignal.timeout(8_000), redirect: 'error' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        doc = (await r.json()) as typeof doc;
      } catch (err) {
        throw new HttpError(400, `gateway ${origin} is not reachable: ${(err as Error).message}`);
      }
      if (typeof doc.realm !== 'string') throw new HttpError(400, `${origin} is not a tab gateway`);
      const cur = typeof doc.currency === 'string' ? doc.currency : 'USD';
      if (currency && cur !== currency) throw new HttpError(400, `gateways charge in different currencies (${currency}, ${cur}); one company spends one currency`);
      currency = cur;
      realms.push(doc.realm);
    }
    return { realms, currency: currency ?? 'USD' };
  }

  /** Found a company for a user: wallet, budget, gateways, and from a template its first agents and tickets. */
  async function found(user: UserRow, body: Record<string, unknown>): Promise<{ company: CompanyRow; agents: unknown[] }> {
    const name = str(body.name, 80).trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (store.companiesOf(user.id).length >= 20) throw new HttpError(429, 'at most 20 companies per account');
    let budget: number;
    try { budget = usdToMicro(normalizeUsd(str(body.budget, 20) || '5.00')); } catch { throw new HttpError(400, 'budget must be an amount like 25.00'); }
    const gateways = (Array.isArray(body.gateways) ? body.gateways.map((g) => str(g, 300).replace(/\/$/, '')) : [opts.defaultGateway ?? '']).filter(Boolean).slice(0, 10);
    const { realms, currency: discovered } = await checkGateways(gateways);
    const currency = str(body.currency, 10) || discovered;
    if (!isCurrency(currency)) throw new HttpError(400, 'currency must be 2 to 10 upper-case letters or digits, after at most two lowercase ones (USD, USDG, tTAB)');
    const owner = newKeyPair();
    const catalog = body.catalog === null ? null : str(body.catalog, 300).replace(/\/$/, '') || opts.defaultCatalog || null;
    if (catalog && !bareOrigin(catalog)) throw new HttpError(400, 'catalog must be an origin like https://paidwithtab.com');
    const c = store.createCompany({
      user_id: user.id, name, mission: str(body.mission, 20_000), owner_pub: owner.publicKey, owner_priv: owner.privateKey,
      budget, currency, gateways, realms, catalog, sell_gateway: null, state: 'active',
      concurrency: Math.max(1, Math.min(8, Number(body.concurrency ?? 2) || 2)), max_tickets: 200,
    });
    store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'founded', body: { name, budget: microToUsd(budget), currency, gateways, realms } });
    // a template may hire the first agents and open the first tickets in the same breath
    const hired: unknown[] = [];
    for (const a of Array.isArray(body.agents) ? body.agents.slice(0, 20) : []) {
      if (a && typeof a === 'object') { await checkEgress('hire', a); hired.push(boardAct(c, 'hire', a)); }
    }
    for (const t of Array.isArray(body.tickets) ? body.tickets.slice(0, 50) : []) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Record<string, unknown>;
      const assignee = tt.assignee ? store.agentByName(c.id, str(tt.assignee, 40)) : undefined;
      let tb: number | null = null;
      if (tt.budget) { try { tb = usdToMicro(str(tt.budget, 20)); } catch { /* no cap */ } }
      const created = store.createTicket({ company_id: c.id, title: str(tt.title, 200) || 'untitled', body: str(tt.body, 20_000), state: 'open', assignee_id: assignee?.id ?? null, created_by: 'owner', parent_id: null, budget: tb });
      store.addEvent({ company_id: c.id, ticket_id: created.id, agent_id: null, kind: 'ticket', body: { ticket_id: created.id, title: created.title, assignee: assignee?.name ?? null } });
      if (assignee) store.wake(assignee.id, created.id, 'assigned by owner');
    }
    log(`company ${c.id} (${name}) founded by ${user.email}: ${gateways.join(', ')} ${currency}`);
    return { company: store.company(c.id)!, agents: hired };
  }

  /** Starter credits for the owner wallet at every gateway of the company that offers them. */
  async function claimCredits(c: CompanyRow): Promise<Array<Record<string, unknown>>> {
    // every hosted claim reaches the faucet from this server's one address, so its per-IP limit cannot tell users apart:
    // starter credits go to at most two companies per account and gateway, and to a capped number a day in all
    const granted = store.creditsGranted(c.user_id, new Date(Date.now() - 86_400_000).toISOString());
    const daily = opts.starterCreditsPerDay ?? 200;
    const results = await Promise.all(c.gateways.map(async (origin) => {
      if ((granted.mine.get(origin) ?? 0) >= 2) return { origin, status: 409, error: 'this account already has starter credits at this gateway' };
      if (granted.all >= daily) return { origin, status: 429, error: 'starter credits are used up for today; try again tomorrow' };
      try {
        // a faucet on a gateway that settles on chain wants the owner's 0x address
        const evm = (await discoveryOf(origin))?.rail === 'evm';
        // an on-chain faucet sends real transactions, so it gets longer than a ledger credit
        const r = await egress(`${origin}/.well-known/tab/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: evm ? addressFromSeed(seedOf(c.owner_priv)) : c.owner_pub }), signal: AbortSignal.timeout(evm ? 60_000 : 8_000) });
        return { origin, status: r.status, ...((await r.json()) as Record<string, unknown>) };
      } catch (err) { return { origin, error: (err as Error).message }; }
    }));
    store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'fund', body: { results } });
    return results;
  }

  // -- views -----------------------------------------------------------------

  const publicCompany = (c: CompanyRow) => {
    const s = store.companySpent(c.id);
    const total = s.tab + s.model;
    const { owner_priv: _p, model_key: _k, ...rest } = c;
    return {
      ...rest,
      // where the claude agents' model key comes from: the company's own, the host's, or nowhere yet
      model_key: c.model_key ? 'company' : opts.hostModelKey ? 'host' : null,
      // the same owner key's address on Robinhood Chain, where evm-rail gateways take payment from
      owner_evm: addressFromSeed(new Uint8Array(Buffer.from(c.owner_priv, 'base64url'))),
      budget: microToUsd(c.budget),
      spent: { tab: microToUsd(s.tab), model: microToUsd(s.model), total: microToUsd(total), remaining: microToUsd(Math.max(0, c.budget - total)), percent: c.budget ? Math.min(100, Math.floor((total / c.budget) * 100)) : 100 },
    };
  };
  const publicAgent = (a: AgentRow) => {
    const { agent_priv: _p, ...rest } = a;
    return { ...rest, budget_per_run: microToUsd(a.budget_per_run), custodial: a.agent_priv !== null };
  };
  const publicTicket = (t: TicketRow) => ({ ...t, budget: t.budget === null ? null : microToUsd(t.budget), spent: microToUsd(t.spent) });

  /** A mandate as the dashboard shows it: limits, the chain above it by agent name, and whether the owner revoked it or anything above it. */
  function mandateView(m: Mandate, byPub: Map<string, string>, revoked: Set<string>) {
    const chain = mandateChain(m);
    return {
      id: m.id, budget: microToUsd(Number(m.budget)), allow: m.allow, expires_at: m.expires_at,
      max_per_call: m.max_per_call === null ? null : microToUsd(Number(m.max_per_call)),
      approve_above: approvalThreshold(m) === null ? null : microToUsd(approvalThreshold(m)!),
      delegated_by: m.parent ? (byPub.get(m.parent.agent) ?? m.parent.agent) : null,
      chain: chain.slice(1).map((x) => ({ id: x.id, agent: byPub.get(x.agent) ?? x.agent, budget: microToUsd(Number(x.budget)) })),
      revoked: chain.some((x) => revoked.has(x.id)),
      // 3.2: the routes and hours it pays for, when the agent has rules
      ...(m.paths ? { paths: m.paths } : {}),
      ...(m.hours ? { hours: describeHours(m.hours) } : {}),
    };
  }

  function companyView(c: CompanyRow) {
    const agents = store.agentsOf(c.id);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const byPub = new Map(agents.map((a) => [a.agent_pub, a.name]));
    const revoked = new Set(store.revocationsOf(c.id).map((r) => r.mandate_id));
    const nameOf = (id: string | null) => (id === null ? 'owner' : names.get(id) ?? id);
    return {
      company: publicCompany(c),
      agents: agents.map(publicAgent),
      tickets: store.ticketsOf(c.id).map((t) => ({ ...publicTicket(t), assignee: nameOf(t.assignee_id), created_by_name: t.created_by === 'owner' ? 'owner' : nameOf(t.created_by) })),
      approvals: store.approvalsOf(c.id).map((a) => ({ ...a, agent: a.agent_id ? nameOf(a.agent_id) : null })),
      runs: store.runsOf(c.id, 50).map((r) => ({ ...r, agent: nameOf(r.agent_id), spent: microToUsd(r.spent), model_cost: microToUsd(r.model_cost), mandate: r.mandate ? mandateView(r.mandate, byPub, revoked) : null, output: undefined })),
      // 3.0: delegated budgets, pay-on-delivery orders, payment channels, revocations
      delegations: store.delegationsOf(c.id).map((d) => {
        const subRuns = store.runsOf(c.id, 500).filter((r) => r.mandate?.parent?.id === d.mandate.id);
        return { ticket_id: d.ticket_id, manager: nameOf(d.agent_id), agent_id: d.agent_id, mandate: mandateView(d.mandate, byPub, revoked), created_at: d.created_at,
          runs: subRuns.length, spent: microToUsd(subRuns.reduce((n, r) => n + r.spent, 0)), to: [...new Set(subRuns.map((r) => nameOf(r.agent_id)))] };
      }),
      orders: store.ordersOf(c.id, 50).map((o) => ({ ...o, token: undefined, agent: o.agent_id ? nameOf(o.agent_id) : null, amount: microToUsd(o.amount) })),
      channels: store.channelsOf(c.id).map((ch) => ({ ...ch, mandate: mandateView(ch.mandate, byPub, revoked), agent: nameOf(ch.agent_id), deposit: microToUsd(ch.deposit), spent: microToUsd(ch.spent), left: microToUsd(Math.max(0, ch.deposit - ch.spent)) })),
      revocations: store.revocationsOf(c.id).map((r) => ({ ...r, doc: undefined, agent: r.agent_id ? nameOf(r.agent_id) : null })),
      events: store.events(c.id, { limit: 100 }).map((e) => ({ ...e, by: nameOf(e.agent_id) })),
      board: store.board(c.id).map((b) => ({ ...b, verified: verifyBoardAction(c.owner_pub, { ver: 'tab-board/0', company: b.company_id, seq: b.seq, action: b.action as BoardActionKind, payload: b.payload, at: b.at, id: b.id, sig: b.sig }).ok })),
      receipts: store.receiptsOf(c.id, 50).map((r) => {
        // how the payment settled: an on-chain transaction links to the gateway's explorer
        const ref = r.doc?.ref ?? null;
        const explorer = chainMemo.get(r.origin)?.doc?.rail_info?.explorer;
        const tx = ref && ref.startsWith('evm:') ? ref.slice(4) : null;
        return { ...r, agent: r.agent_id ? nameOf(r.agent_id) : null, amount: microToUsd(r.amount), signed: r.doc != null, doc: undefined, ref, tx_url: tx && typeof explorer === 'string' ? `${explorer}/tx/${tx}` : null, escrow: !!r.doc?.escrow, channel: r.doc?.channel?.kind ?? null };
      }),
    };
  }

  // -- board actions ---------------------------------------------------------

  /** Apply a verified board action. Runs inside the caller's transaction. */
  function applyBoard(c: CompanyRow, a: SignedBoardAction): unknown {
    const p = (a.payload ?? {}) as Record<string, unknown>;
    const now = new Date(a.at);
    const ev = (kind: string, body: unknown, ticketId: string | null = null) =>
      store.addEvent({ company_id: c.id, ticket_id: ticketId, agent_id: null, kind, body }, now);
    store.addBoard({ company_id: c.id, seq: a.seq, id: a.id, action: a.action, payload: a.payload, at: a.at, sig: a.sig });
    // a hire: by the owner directly, or by approving an agent's hire request
    const hire = (p: Record<string, unknown>) => {
      const name = str(p.name, 40);
      if (!NAME_RE.test(name)) throw new HttpError(400, 'agent name: letters, digits, dot, dash, underscore; up to 40');
      if (store.agentByName(c.id, name)) throw new HttpError(409, `an agent named ${name} exists`);
      const adapter = (ADAPTERS as readonly string[]).includes(String(p.adapter)) && adapters.has(p.adapter as AdapterName) ? (p.adapter as AdapterName) : null;
      if (!adapter) throw new HttpError(400, `adapter must be one of ${[...adapters].join(', ')}`);
      const config = (p.config && typeof p.config === 'object' && !Array.isArray(p.config) ? p.config : {}) as Record<string, unknown>;
      // the per call cap goes into every mandate the agent gets, so it is checked here and kept in canonical form
      if (config.max_per_call === undefined || config.max_per_call === null || config.max_per_call === '') delete config.max_per_call;
      else {
        try { config.max_per_call = microToUsd(usdToMicro(normalizeUsd(str(config.max_per_call, 20)))); } catch { throw new HttpError(400, 'per call must be an amount like 0.05'); }
      }
      let agent_pub: string;
      let agent_priv: string | null = null;
      if (adapter === 'http') {
        let target: URL;
        try { target = new URL(String(config.url ?? '')); } catch { throw new HttpError(400, 'http adapter needs config.url'); }
        if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) throw new HttpError(400, 'http adapter needs an http(s) config.url');

        agent_pub = str(p.agent_pub, 64);
        if (!PUB_RE.test(agent_pub)) throw new HttpError(400, 'http adapter needs agent_pub: the public key the endpoint pays with');
      } else {
        const pair = newKeyPair();
        agent_pub = pair.publicKey;
        agent_priv = pair.privateKey;
      }
      let budget_per_run: number;
      try { budget_per_run = usdToMicro(normalizeUsd(str(p.budget_per_run, 20) || '0.50')); } catch { throw new HttpError(400, 'budget_per_run must be an amount like 0.50'); }
      const heartbeat_s = Math.max(0, Math.min(86_400 * 7, Number(p.heartbeat_s ?? 0) || 0));
      const agent = store.createAgent({
        company_id: c.id, name, role: str(p.role, 200) || 'agent', instructions: str(p.instructions, 20_000), adapter, config,
        agent_pub, agent_priv, budget_per_run, heartbeat_s, state: 'active',
      }, now);
      ev('hire', { agent_id: agent.id, name, role: agent.role, adapter, agent_pub, budget_per_run: microToUsd(budget_per_run) });
      return agent;
    };
    switch (a.action) {
      case 'hire':
        return publicAgent(hire(p));
      case 'retire': {
        const agent = store.agent(str(p.agent_id, 64));
        if (!agent || agent.company_id !== c.id) throw new HttpError(404, 'no such agent');
        store.updateAgent(agent.id, { state: 'retired' });
        ev('retire', { agent_id: agent.id, name: agent.name });
        return { ok: true };
      }
      case 'configure': {
        // an agent's settings after hiring: its model, what it may spend per run and per call, its instructions
        const agent = store.agent(str(p.agent_id, 64));
        if (!agent || agent.company_id !== c.id) throw new HttpError(404, 'no such agent');
        const patch: Partial<Pick<AgentRow, 'budget_per_run' | 'heartbeat_s' | 'instructions' | 'config'>> = {};
        const config = { ...agent.config };
        if (p.budget_per_run !== undefined) { try { patch.budget_per_run = usdToMicro(normalizeUsd(str(p.budget_per_run, 20))); } catch { throw new HttpError(400, 'budget_per_run must be an amount like 0.50'); } }
        if (p.heartbeat_s !== undefined) patch.heartbeat_s = Math.max(0, Math.min(86_400 * 7, Number(p.heartbeat_s) || 0));
        if (p.instructions !== undefined) patch.instructions = str(p.instructions, 20_000);
        if (p.model !== undefined) { const m = str(p.model, 80).trim(); if (m && !/^claude-[a-z0-9.-]+$/.test(m)) throw new HttpError(400, 'model must be a Claude model id like claude-haiku-5-5'); if (m) config.model = m; else delete config.model; }
        if (p.max_per_call !== undefined) {
          const v = str(p.max_per_call, 20).trim();
          if (!v) delete config.max_per_call;
          else { try { config.max_per_call = microToUsd(usdToMicro(normalizeUsd(v))); } catch { throw new HttpError(400, 'per call must be an amount like 0.05'); } }
        }
        // 3.0: payments above this wait for the owner's approval in the Inbox
        if (p.approve_above !== undefined) {
          const v = str(p.approve_above, 20).trim();
          if (!v) delete config.approve_above;
          else { try { config.approve_above = microToUsd(usdToMicro(normalizeUsd(v))); } catch { throw new HttpError(400, 'approve above must be an amount like 0.25'); } }
        }
        // 3.2: spending rules carried into every mandate this agent runs on: routes it may pay for, and when (UTC)
        if (p.paths !== undefined) {
          const list = str(p.paths, 2000).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
          if (list.length > 20 || list.some((x) => x.length > 120)) throw new HttpError(400, 'at most 20 route patterns like /search* or GET /weather/*');
          if (list.length) config.paths = list; else delete config.paths;
        }
        if (p.hours !== undefined) {
          const v = str(p.hours, 80).trim();
          if (!v) delete config.hours;
          else { try { config.hours = parseHours(v); } catch (err) { throw new HttpError(400, (err as Error).message.replace(/^hours: /, 'hours: ') + ' (write it like mon-fri 9-17)'); } }
        }
        if (p.model !== undefined || p.max_per_call !== undefined || p.approve_above !== undefined || p.paths !== undefined || p.hours !== undefined) patch.config = config;
        if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to change');
        store.updateAgent(agent.id, patch);
        ev('configure', { agent_id: agent.id, name: agent.name, ...(p.paths !== undefined ? { paths: config.paths ?? null } : {}), ...(p.hours !== undefined ? { hours: config.hours ? describeHours(config.hours as MandateHours) : null } : {}), ...(p.model !== undefined ? { model: config.model ?? 'default' } : {}), ...(patch.budget_per_run !== undefined ? { budget_per_run: microToUsd(patch.budget_per_run) } : {}), ...(p.max_per_call !== undefined ? { max_per_call: config.max_per_call ?? null } : {}), ...(p.approve_above !== undefined ? { approve_above: config.approve_above ?? null } : {}), ...(patch.instructions !== undefined ? { instructions: true } : {}) });
        return publicAgent(store.agent(agent.id)!);
      }
      case 'budget': {
        let budget: number;
        try { budget = usdToMicro(normalizeUsd(str(p.budget, 20))); } catch { throw new HttpError(400, 'budget must be an amount like 25.00'); }
        store.updateCompany(c.id, { budget, warned: false });
        ev('budget', { from: microToUsd(c.budget), to: microToUsd(budget) });
        return { ok: true };
      }
      case 'approve':
      case 'reject': {
        const ap = store.approval(str(p.approval_id, 64));
        if (!ap || ap.company_id !== c.id) throw new HttpError(404, 'no such approval');
        if (!store.decideApproval(ap.id, a.action === 'approve' ? 'approved' : 'rejected', now)) throw new HttpError(409, 'already decided');
        ev('approval', { approval_id: ap.id, decision: a.action === 'approve' ? 'approved' : 'rejected', kind: ap.kind, amount: ap.payload.amount ?? null }, ap.ticket_id);
        if (a.action === 'approve' && ap.kind === 'budget' && typeof ap.payload.amount === 'string') {
          let add = 0;
          try { add = usdToMicro(ap.payload.amount); } catch { /* an unparseable amount approves nothing */ }
          if (add > 0) {
            store.updateCompany(c.id, { budget: c.budget + add, warned: false });
            ev('budget', { from: microToUsd(c.budget), to: microToUsd(c.budget + add), approval_id: ap.id });
            const spent = store.companySpent(c.id);
            if (c.state === 'paused' && spent.tab + spent.model < c.budget + add) {
              store.updateCompany(c.id, { state: 'active' });
              ev('resumed', { reason: 'budget raised' });
            }
          }
        }
        let hired: AgentRow | null = null;
        if (a.action === 'approve' && ap.kind === 'hire' && typeof ap.payload.name === 'string' && ap.payload.name) {
          // the agent the requester described joins on the requester's adapter, with the model and per call cap it
          // asked for (checked when it asked: a cap no higher than its own); the owner may change either when approving
          const by = ap.agent_id ? store.agent(ap.agent_id) : null;
          const adapter = by && by.adapter !== 'http' ? by.adapter : adapters.has('claude') ? 'claude' : 'starter';
          const config: Record<string, unknown> = {};
          const model = p.model !== undefined ? str(p.model, 80).trim() : typeof ap.payload.model === 'string' ? ap.payload.model : '';
          if (model) { if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new HttpError(400, 'model must be a Claude model id like claude-haiku-5-5'); config.model = model; }
          const cap = p.max_per_call !== undefined ? str(p.max_per_call, 20).trim() : typeof ap.payload.max_per_call === 'string' ? ap.payload.max_per_call : typeof by?.config.max_per_call === 'string' ? by.config.max_per_call : '';
          if (cap) config.max_per_call = cap;
          hired = hire({
            name: ap.payload.name, role: ap.payload.role ?? '', instructions: ap.payload.instructions ?? '', adapter, config,
            budget_per_run: typeof ap.payload.amount === 'string' && ap.payload.amount ? ap.payload.amount : '0.25',
          });
        }
        if (ap.kind === 'payment' && a.action === 'approve') {
          // the owner key signs the approval for exactly the request the gateway named; the handler posts it to that gateway
          const req = ap.payload.request as ApprovalRequest | undefined;
          if (!req || !approvalRequestValid(req) || req.owner !== c.owner_pub) throw new HttpError(409, 'this payment request is not for this company\'s owner key');
          store.patchApproval(ap.id, { approval: signApproval({ publicKey: c.owner_pub, privateKey: c.owner_priv }, req, 3_600_000, now) });
          // the run that asked may have stopped on it: the ticket goes back to work so the agent's wake runs
          const t = ap.ticket_id ? store.ticket(ap.ticket_id) : undefined;
          if (t && t.state === 'blocked') {
            store.updateTicket(t.id, { state: 'in_progress' }, now);
            ev('state', { from: 'blocked', to: 'in_progress', reason: 'payment approved' }, t.id);
          }
        }
        const what = ap.kind === 'payment' ? `payment of ${String(ap.payload.amount ?? '')} ${String(ap.payload.currency ?? '')} ${a.action === 'approve' ? 'approved: make the same call again' : 'declined'}` : `request ${a.action === 'approve' ? 'approved' : 'rejected'}${hired ? `: ${hired.name} is hired` : ''}`;
        if (ap.agent_id && (ap.ticket_id || ap.kind === 'payment')) store.wake(ap.agent_id, ap.ticket_id, what, now);
        if (hired) return { ok: true, agent: publicAgent(hired) };
        return { ok: true };
      }
      case 'pause':
        store.updateCompany(c.id, { state: 'paused' });
        ev('paused', { reason: str(p.reason, 500) || 'by the owner' });
        return { ok: true };
      case 'resume': {
        const spent = store.companySpent(c.id);
        if (spent.tab + spent.model >= c.budget) throw new HttpError(409, 'budget is exhausted; raise it first');
        store.updateCompany(c.id, { state: 'active' });
        ev('resumed', { reason: str(p.reason, 500) || 'by the owner' });
        return { ok: true };
      }
      case 'publish': {
        const gateway = bareOrigin(str(p.gateway, 300));
        if (!gateway) throw new HttpError(400, 'gateway must be an origin');

        store.updateCompany(c.id, { sell_gateway: gateway });
        ev('publish', { gateway });
        return { ok: true };
      }
      case 'charter': {
        // the company's name and mission: what every agent reads first
        const patch: { name?: string; mission?: string } = {};
        if (p.name !== undefined) { const name = str(p.name, 80).trim(); if (!name) throw new HttpError(400, 'name is required'); patch.name = name; }
        if (p.mission !== undefined) patch.mission = str(p.mission, 20_000);
        if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to change');
        store.updateCompany(c.id, patch);
        ev('charter', { from: { name: c.name, mission: c.mission }, to: { name: patch.name ?? c.name, mission: patch.mission ?? c.mission } });
        return { ok: true };
      }
      case 'revoke': {
        // the owner kills mandates at every gateway: a run's, a delegated budget (and every sub-ticket run under it), a channel's
        const ids = Array.isArray(p.mandate_ids) ? (p.mandate_ids as unknown[]).map((x) => str(x, 64)).filter((x) => /^[A-Za-z0-9_-]{43}$/.test(x)) : [];
        if (!ids.length) throw new HttpError(400, 'nothing to revoke');
        const reason = str(p.reason, 500) || 'revoked by the owner';
        const scope = (['run', 'delegation', 'channel'] as const).includes(p.scope as 'run') ? (p.scope as 'run' | 'delegation' | 'channel') : 'run';
        const owner = { publicKey: c.owner_pub, privateKey: c.owner_priv };
        const docs: Revocation[] = [];
        for (const id of ids) {
          const doc = signRevocation(owner, id, reason, now);
          if (store.addRevocation({ mandate_id: id, company_id: c.id, run_id: p.run_id ? str(p.run_id, 64) : null, agent_id: p.agent_id ? str(p.agent_id, 64) : null, scope, reason, doc, results: [], at: now.toISOString() })) docs.push(doc);
        }
        ev('revoke', { mandate_ids: ids, scope, reason, run_id: p.run_id ?? null, agent_id: p.agent_id ?? null });
        return { revoked: ids, docs };
      }
      case 'channel':
        // opening or closing a payment channel: logged and signed here, the gateway call follows
        ev('channel', { op: str(p.op, 10), origin: str(p.origin, 300), agent_id: p.agent_id ?? null, deposit: p.deposit ?? null, channel: p.channel ?? null });
        return { ok: true };
      case 'cancel': {
        const t = store.ticket(str(p.ticket_id, 64));
        if (!t || t.company_id !== c.id) throw new HttpError(404, 'no such ticket');
        store.updateTicket(t.id, { state: 'cancelled' }, now);
        ev('state', { from: t.state, to: 'cancelled', reason: str(p.reason, 500) || 'cancelled by the owner' }, t.id);
        return { ok: true };
      }
      default:
        throw new HttpError(400, `unknown action ${String(a.action)}`);
    }
  }

  /** Before a board action that names an address (an http agent's URL, a selling gateway): is it public? Async, so outside the transaction. */
  async function checkEgress(action: string, payload: unknown): Promise<void> {
    if (opts.allowPrivateOrigins || !payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    let target: string | null = null;
    if (action === 'hire' && p.adapter === 'http') {
      try { target = new URL(String((p.config as Record<string, unknown> | undefined)?.url ?? '')).origin; } catch { return; } // applyBoard reports the bad URL
    } else if (action === 'publish') {
      target = bareOrigin(String(p.gateway ?? ''));
    }
    if (!target || target === 'null') return;
    const pub = await originIsPublic(target);
    if (!pub.ok) throw new HttpError(400, `${target} refused: ${pub.reason}`);
  }

  // -- 3.0: revocations and orders -------------------------------------------

  /** Mandates of an agent's runs in flight (or every agent's): what a pause or retire revokes. */
  function runMandates(c: CompanyRow, agentId?: string): Mandate[] {
    return store.runningRuns(c.id).filter((r) => r.mandate && (!agentId || r.agent_id === agentId)).map((r) => r.mandate!);
  }

  /**
   * Sign revocations with the owner key (a signed board action) and tell every gateway the company
   * spends at, each with its mandate so a gateway that has not seen it yet can check the owner's
   * authority. On a company that pays on chain the mandate is only half the limit: the agents named
   * in `zero` also lose their ERC-20 allowance, which is what the chain itself enforces.
   */
  async function revokeMandates(c: CompanyRow, mandates: Mandate[], scope: 'run' | 'delegation' | 'channel', reason: string, who: { run_id?: string; agent_id?: string } = {}, zero: string[] = []): Promise<{ revoked: string[]; results: Array<{ origin: string; ok: boolean; error?: string }>; chain?: Array<{ agent: string; ok: boolean; tx?: string; error?: string }> }> {
    const held = new Set(store.revocationsOf(c.id).map((r) => r.mandate_id));
    const fresh = mandates.filter((m) => !held.has(m.id));
    let results: Array<{ origin: string; ok: boolean; error?: string }> = [];
    if (fresh.length) {
      const out = boardAct(c, 'revoke', { mandate_ids: fresh.map((m) => m.id), scope, reason, ...who }) as { docs: Revocation[] };
      const body = out.docs.map((r) => ({ revocation: r, mandate: fresh.find((m) => m.id === r.mandate) }));
      results = await Promise.all(c.gateways.map(async (origin) => {
        try {
          const r = await egress(`${origin}/.well-known/tab/revocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) });
          const doc = (await r.json().catch(() => ({}))) as { results?: Array<{ error?: string }> };
          const bad = (doc.results ?? []).find((x) => x.error);
          return { origin, ok: r.ok && !bad, ...(r.ok && !bad ? {} : { error: bad?.error ?? `HTTP ${r.status}` }) };
        } catch (err) {
          return { origin, ok: false, error: (err as Error).message };
        }
      }));
      for (const m of fresh) store.setRevocationResults(m.id, results);
      log(`company ${c.id}: revoked ${fresh.length} mandate${fresh.length === 1 ? '' : 's'} (${reason}) at ${results.filter((x) => x.ok).length} of ${results.length} gateways`);
    }
    const chain = zero.length ? await zeroAllowances(c, zero) : undefined;
    return { revoked: fresh.map((m) => m.id), results, ...(chain ? { chain } : {}) };
  }

  /** On a company that pays on chain: drop agents' ERC-20 allowances from the owner account to zero. */
  async function zeroAllowances(c: CompanyRow, agentIds: string[]): Promise<Array<{ agent: string; ok: boolean; tx?: string; error?: string }> | undefined> {
    const ch = await chainOf(c);
    if (!ch) return undefined;
    const owner = { privateKey: c.owner_priv };
    const out: Array<{ agent: string; ok: boolean; tx?: string; error?: string }> = [];
    for (const id of [...new Set(agentIds)]) {
      const a = store.agent(id);
      if (!a?.agent_priv) continue;
      const address = addressFromSeed(seedOf(a.agent_priv));
      try {
        if ((await ch.rpc.erc20Allowance(ch.token, addressFromSeed(seedOf(c.owner_priv)), address)) === 0n) { out.push({ agent: a.name, ok: true }); continue; }
        out.push({ agent: a.name, ok: true, tx: await evmSend(ch.rpc, owner, ch.token, 0n, erc20.approve(address, 0n)) });
      } catch (err) {
        out.push({ agent: a.name, ok: false, error: (err as Error).message });
      }
    }
    if (out.length) store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'chain-revoke', body: { agents: out, chain_id: ch.chain_id, explorer: ch.explorer } });
    return out;
  }

  /** Ask the gateway about every held order; a refund gives the money back to the run's books. */
  async function refreshOrders(c: CompanyRow): Promise<void> {
    const held = store.ordersOf(c.id, 100).filter((o) => o.state === 'held' || o.amount === 0);
    await Promise.all(held.map(async (o: OrderRow) => {
      try {
        // only a gateway the company spends at speaks for an order: a status URL anywhere else could claim a refund and erase spend
        let at = '';
        try { at = new URL(o.status_url).origin; } catch { return; }
        if (at !== o.origin || !c.gateways.includes(at)) return;
        const r = await egress(o.status_url, { headers: { 'tab-escrow-token': o.token }, signal: AbortSignal.timeout(8_000) });
        if (!r.ok) return;
        const st = (await r.json()) as { state?: string; micro?: number; receipt?: Receipt | null; refund_ref?: string | null; reason?: string | null; deadline?: string };
        if (st.state !== 'held' && st.state !== 'delivered' && st.state !== 'refunded') return;
        const amount = Number.isSafeInteger(st.micro) && st.micro! > 0 ? st.micro! : o.amount;
        if (amount !== o.amount) store.setOrderAmount(c.id, o.id, amount);
        if (st.state === o.state) return;
        store.updateOrder(c.id, o.id, { state: st.state, receipt: st.receipt ?? null, refund_ref: st.refund_ref ?? null, reason: st.reason ?? null });
        store.addEvent({ company_id: c.id, ticket_id: null, agent_id: o.agent_id, kind: 'order', body: { order: o.id, url: o.url, state: st.state, amount: microToUsd(amount), ...(st.reason ? { reason: st.reason } : {}) } });
        // the run booked the held amount when the gateway counted it; a refund takes it back off
        if (st.state === 'refunded' && o.run_id) store.addRunSpend(o.run_id, -Math.min(amount, store.run(o.run_id)?.spent ?? 0));
      } catch { /* try again on the next look */ }
    }));
  }

  /** Sign an action with the custodial owner key and apply it, in one transaction. */
  function boardAct(c: CompanyRow, action: BoardActionKind, payload: unknown): unknown {
    return store.tx(() => {
      const seq = store.boardSeq(c.id) + 1;
      const signed = signBoardAction({ publicKey: c.owner_pub, privateKey: c.owner_priv }, { company: c.id, seq, action, payload, at: new Date().toISOString() });
      return applyBoard(c, signed);
    });
  }

  // -- the request handler ---------------------------------------------------

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const u = new URL(req.url ?? '/', 'http://localhost');
    const path = u.pathname;
    try {
      if (!hostAllowed(req)) {
        sendJson(res, 421, { error: 'this server does not answer to that host' });
        return;
      }
      // static: the dashboard and the site assets it shares with the catalog page
      if (method === 'GET' && !path.startsWith('/api/')) {
        if (!web) { sendJson(res, 500, { error: 'ui not found: keep web/ next to dist/' }); return; }
        // tab OS is the app; the addresses it and the old dashboard used to live at lead to it, the hash kept by the browser
        if (path === '/os' || path === '/os/' || path === '/app' || path === '/app.html') { res.writeHead(301, { location: '/' }); res.end(); return; }
        const page = path === '/' || path === '/index.html' ? 'os.html' : null;
        if (page) {
          // the page's one inline script runs under a per-response nonce; nothing else may execute
          const nonce = randomBytes(16).toString('base64url');
          const html = readFileSync(join(web, page), 'utf8').replace(/<script>/g, `<script nonce="${nonce}">`).replaceAll('__ASSET_V__', assetVersion(web));
          res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'` });
          res.end(html);
          return;
        }
        // what makes tab OS installable: its manifest and a service worker that never touches /api
        if (path === '/os.webmanifest' || path === '/os-sw.js') {
          const file = join(web, path.slice(1));
          if (!existsSync(file)) { sendJson(res, 404, { error: 'not found' }); return; }
          res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/manifest+json', 'cache-control': 'no-cache' });
          res.end(readFileSync(file));
          return;
        }
        const m = /^\/([a-z0-9-]+)\.(css|png|jpg|woff2)$/.exec(path);
        const file = m ? join(web, `${m[1]}.${m[2]}`) : null;
        if (file && existsSync(file)) {
          res.writeHead(200, { 'content-type': TYPES[m![2]], 'cache-control': 'public, max-age=300' });
          res.end(readFileSync(file));
          return;
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      if (!path.startsWith('/api/')) { sendJson(res, 404, { error: 'not found' }); return; }
      if (method !== 'GET' && method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }

      if (method === 'GET' && path === '/api/health') {
        sendJson(res, 200, { ok: true, companies: store.allCompanies().length, adapters: [...adapters], host_model_key: !!opts.hostModelKey, default_gateway: opts.defaultGateway ?? null });
        return;
      }
      if (method === 'GET' && path === '/api/templates') {
        // the example companies shipped with the package, for the new company form
        const dir = web ? join(web, '..', 'examples', 'companies') : null;
        const templates: unknown[] = [];
        if (dir && existsSync(dir)) {
          for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
            try { templates.push({ file: f, ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as object) }); } catch { /* skip a broken file */ }
          }
        }
        sendJson(res, 200, { templates });
        return;
      }

      const ip = clientIp(req);
      const auth = authenticate(req);

      // cookie sessions only act from their own origin: a cross-site page cannot drive this API
      if (method === 'POST' && auth?.viaCookie) {
        const site = String(req.headers['sec-fetch-site'] ?? '');
        const origin = String(req.headers.origin ?? '');
        const ok = site === 'same-origin' || site === 'none' || (origin && originAllowed(origin));
        if (!ok) { sendJson(res, 403, { error: 'cross-origin request refused' }); return; }
      }

      // -- accounts ----------------------------------------------------------
      if (method === 'POST' && (path === '/api/signup' || path === '/api/login')) {
        if (store.hit(`${path}:${ip}`, 15 * 60_000) > authPerWindow) { sendJson(res, 429, { error: 'too many attempts from this address; try again later' }); return; }
        const body = await readJson(req);
        const email = str(body.email, 254).trim().toLowerCase();
        const password = str(body.password, 1024);
        if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw new HttpError(400, 'email does not look like an address');
        let user: UserRow | undefined;
        if (path === '/api/signup') {
          if (password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
          if (store.userByEmail(email)) throw new HttpError(409, 'an account with that email exists; log in');
          user = store.createUser(email, password);
          log(`signup ${email} (${ip})`);
        } else {
          user = store.authenticate(email, password);
          if (!user) throw new HttpError(401, 'wrong email or password');
        }
        const session = store.createSession(user.id);
        sendJson(res, 200, { user, token: session.id }, setCookie(res, session.id, 30 * 86_400));
        return;
      }
      if (method === 'POST' && path === '/api/logout') {
        if (auth) store.deleteSession(auth.session);
        sendJson(res, 200, { ok: true }, setCookie(res, '', 0));
        return;
      }
      if (!auth) { sendJson(res, 401, { error: 'sign in first' }); return; }
      if (method === 'GET' && path === '/api/me') { sendJson(res, 200, { user: auth.user }); return; }

      // -- companies ---------------------------------------------------------
      if (path === '/api/companies' && method === 'GET') {
        sendJson(res, 200, { companies: store.companiesOf(auth.user.id).map(publicCompany) });
        return;
      }
      if (path === '/api/companies' && method === 'POST') {
        const out = await found(auth.user, await readJson(req));
        sendJson(res, 200, { company: publicCompany(out.company), agents: out.agents });
        return;
      }
      if (path === '/api/quickstart' && method === 'POST') {
        // the first run in one call: a $1 company, the starter agent, the gateway's starter
        // credits, then a ticket it works at once. No model key needed; the receipts are real.
        if (!adapters.has('starter')) throw new HttpError(503, 'this server does not offer the starter agent');
        const body = await readJson(req);
        const topic = str(body.topic, 120).replace(/\s+/g, ' ').trim() || 'Robinhood Markets';
        const out = await found(auth.user, {
          name: 'My first company', budget: '1.00', mission: QUICKSTART_MISSION,
          agents: [{ name: 'starter', role: 'researcher', adapter: 'starter', budget_per_run: '0.01', config: { max_per_call: '0.005' }, instructions: STARTER_INSTRUCTIONS }],
        });
        const c = out.company;
        const funding = await claimCredits(c);
        const agent = store.agentByName(c.id, 'starter')!;
        const t = store.createTicket({ company_id: c.id, title: `Look up: ${topic}`, body: `Read about ${topic} on Wikipedia and report back with the receipts.`, state: 'open', assignee_id: agent.id, created_by: 'owner', parent_id: null, budget: usdToMicro('0.01') });
        store.addEvent({ company_id: c.id, ticket_id: t.id, agent_id: null, kind: 'ticket', body: { ticket_id: t.id, title: t.title, assignee: agent.name } });
        store.wake(agent.id, t.id, 'assigned by owner');
        sendJson(res, 200, { company: publicCompany(store.company(c.id)!), ticket: publicTicket(t), funding });
        return;
      }

      const cm = /^\/api\/companies\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(path);
      if (!cm) { sendJson(res, 404, { error: 'no such endpoint' }); return; }
      const c = store.company(cm[1]);
      // another user's company is indistinguishable from a missing one
      if (!c || c.user_id !== auth.user.id) { sendJson(res, 404, { error: 'no such company' }); return; }
      const sub = cm[2] ?? '';

      if (method === 'GET') {
        if (sub === '') { sendJson(res, 200, companyView(c)); return; }
        if (sub === 'events') {
          const after = Number(u.searchParams.get('after') ?? 0) || 0;
          sendJson(res, 200, { events: store.events(c.id, { after, limit: 200 }) });
          return;
        }
        if (sub === 'board') { sendJson(res, 200, { owner: c.owner_pub, next_seq: store.boardSeq(c.id) + 1, actions: companyView(c).board }); return; }
        if (sub === 'key') {
          store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'key-exported', body: { by: auth.user.email, ip } });
          log(`owner key of ${c.id} exported by ${auth.user.email}`);
          sendJson(res, 200, { publicKey: c.owner_pub, privateKey: c.owner_priv, note: 'this key signs board actions and moves company funds; keep it off shared machines' });
          return;
        }
        const rm = /^runs\/([A-Za-z0-9_-]+)$/.exec(sub);
        if (rm) {
          const run = store.run(rm[1]);
          if (!run || run.company_id !== c.id) { sendJson(res, 404, { error: 'no such run' }); return; }
          sendJson(res, 200, { run: { ...run, spent: microToUsd(run.spent), model_cost: microToUsd(run.model_cost) } });
          return;
        }
        // one receipt exactly as the gateway signed it, for anyone to check offline
        const rcm = /^receipts\/([A-Za-z0-9_-]+)$/.exec(sub);
        if (rcm) {
          const r = store.receipt(c.id, rcm[1]);
          if (!r) { sendJson(res, 404, { error: 'no such receipt' }); return; }
          sendJson(res, 200, { origin: r.origin, verified: r.verified, receipt: r.doc ?? { ...r, verified: undefined, doc: undefined } });
          return;
        }
        const tm = /^tickets\/([A-Za-z0-9_-]+)$/.exec(sub);
        if (tm) {
          const t = store.ticket(tm[1]);
          if (!t || t.company_id !== c.id) { sendJson(res, 404, { error: 'no such ticket' }); return; }
          sendJson(res, 200, { ticket: publicTicket(t), thread: store.events(c.id, { ticketId: t.id, limit: 500 }) });
          return;
        }
        if (sub === 'chain') {
          // the owner's account and each agent's spending allowance on the chain this company pays on
          const ch = await chainOf(c);
          if (!ch) { sendJson(res, 200, { chain: null }); return; }
          const owner = addressFromSeed(seedOf(c.owner_priv));
          const tokenOf = async (data: Uint8Array) => microToUsd(Number(baseUnitsToMicro(hexToBig(await ch.rpc.ethCall(ch.token, data)), ch.decimals)));
          try {
            const agents = await Promise.all(store.agentsOf(c.id).filter((a) => a.state === 'active' && a.agent_priv).map(async (a) => {
              const address = addressFromSeed(seedOf(a.agent_priv!));
              return { id: a.id, name: a.name, address, eth: eth(await ch.rpc.balance(address)), allowance: await tokenOf(erc20.allowance(owner, address)) };
            }));
            sendJson(res, 200, { chain: { origin: ch.origin, chain_id: ch.chain_id, token: ch.token, explorer: ch.explorer }, owner: { address: owner, eth: eth(await ch.rpc.balance(owner)), balance: await tokenOf(erc20.balanceOf(owner)) }, agents });
          } catch (err) {
            sendJson(res, 502, { error: `chain unreachable: ${(err as Error).message}` });
          }
          return;
        }
        if (sub === 'orders') {
          // pay-on-delivery orders: ask the gateway about every one still held, then list them
          await refreshOrders(c);
          sendJson(res, 200, { orders: store.ordersOf(c.id, 100).map((o) => ({ ...o, token: undefined, amount: microToUsd(o.amount) })) });
          return;
        }
        const om = /^orders\/([A-Za-z0-9_-]+)$/.exec(sub);
        if (om) {
          const o = store.order(c.id, om[1]);
          if (!o) { sendJson(res, 404, { error: 'no such order' }); return; }
          sendJson(res, 200, { order: { ...o, token: undefined, amount: microToUsd(o.amount) }, receipt: o.receipt });
          return;
        }
        if (sub === 'balances') {
          const balances = await Promise.all(c.gateways.map(async (origin) => {
            try {
              const evm = (await discoveryOf(origin))?.rail === 'evm';
              const r = await egress(`${origin}/.well-known/tab/wallet/${encodeURIComponent(evm ? addressFromSeed(seedOf(c.owner_priv)) : c.owner_pub)}`, { signal: AbortSignal.timeout(8_000) });
              return { origin, ...((await r.json()) as Record<string, unknown>) };
            } catch (err) { return { origin, error: (err as Error).message }; }
          }));
          sendJson(res, 200, { wallet: c.owner_pub, balances });
          return;
        }
        if (sub === 'earnings') {
          if (!c.sell_gateway) { sendJson(res, 200, { gateway: null, earned: '0.00', receipts: [] }); return; }
          try {
            // an evm-rail gateway knows the owner by its 0x address
            const evm = (await discoveryOf(c.sell_gateway))?.rail === 'evm';
            const w = await (await egress(`${c.sell_gateway}/.well-known/tab/wallet/${encodeURIComponent(evm ? addressFromSeed(seedOf(c.owner_priv)) : c.owner_pub)}`, { signal: AbortSignal.timeout(8_000) })).json() as Record<string, unknown>;
            let receipts: Receipt[] = [];
            try {
              const r = await egress(`${c.sell_gateway}/.well-known/tab/receipts?limit=200`, { signal: AbortSignal.timeout(8_000) });
              if (r.ok) receipts = (((await r.json()) as { receipts?: Receipt[] }).receipts ?? []).filter((x) => x.recipient === c.owner_pub);
            } catch { /* receipts may be private */ }
            const earned = receipts.reduce((n, x) => n + Number(x.amount), 0);
            sendJson(res, 200, { gateway: c.sell_gateway, wallet: w, earned: microToUsd(earned), receipts: receipts.slice(0, 50) });
          } catch (err) {
            sendJson(res, 502, { error: `gateway unreachable: ${(err as Error).message}` });
          }
          return;
        }
        sendJson(res, 404, { error: 'no such endpoint' });
        return;
      }

      // -- mutations ---------------------------------------------------------
      const body = await readJson(req);
      if (sub === 'board') {
        // an action signed offline with the exported owner key; the server only verifies and applies
        const action = body.action as SignedBoardAction;
        await checkEgress(String(action?.action ?? ''), action?.payload);
        const out = store.tx(() => {
          const v = verifyBoardAction(c.owner_pub, action, { company: c.id, seq: store.boardSeq(c.id) + 1 });
          if (!v.ok) throw new HttpError(400, `board action rejected: ${v.error}`);
          return applyBoard(c, action);
        });
        sendJson(res, 200, { result: out });
        return;
      }
      if (sub === 'agents') { await checkEgress('hire', body); sendJson(res, 200, { agent: boardAct(c, 'hire', body) }); return; }
      const am = /^agents\/([A-Za-z0-9_-]+)\/retire$/.exec(sub);
      if (am) {
        const out = boardAct(c, 'retire', { agent_id: am[1] }) as object;
        // a retired agent's runs in flight lose their money at once
        await revokeMandates(c, runMandates(c, am[1]), 'run', 'the agent was retired', { agent_id: am[1] }, [am[1]]);
        sendJson(res, 200, out);
        return;
      }
      // 3.0: revoke a run's mandate, every mandate an agent holds now, or a delegated budget
      const rvm = /^runs\/([A-Za-z0-9_-]+)\/revoke$/.exec(sub);
      if (rvm) {
        const run = store.run(rvm[1]);
        if (!run || run.company_id !== c.id || !run.mandate) throw new HttpError(404, 'no such run with a mandate');
        sendJson(res, 200, await revokeMandates(c, [run.mandate], 'run', str(body.reason, 500) || 'revoked by the owner', { run_id: run.id, agent_id: run.agent_id }, [run.agent_id]));
        return;
      }
      const ravm = /^agents\/([A-Za-z0-9_-]+)\/revoke$/.exec(sub);
      if (ravm) {
        const agent = store.agent(ravm[1]);
        if (!agent || agent.company_id !== c.id) throw new HttpError(404, 'no such agent');
        const live = [...runMandates(c, agent.id), ...store.delegationsOf(c.id).filter((d) => d.agent_id === agent.id && Date.parse(d.mandate.expires_at) > Date.now()).map((d) => d.mandate)];
        if (!live.length) throw new HttpError(409, `${agent.name} holds no live mandate right now`);
        sendJson(res, 200, await revokeMandates(c, live, 'run', str(body.reason, 500) || `every mandate ${agent.name} holds, revoked by the owner`, { agent_id: agent.id }, [agent.id]));
        return;
      }
      const rdm = /^delegations\/([A-Za-z0-9_-]+)\/revoke$/.exec(sub);
      if (rdm) {
        const d = store.delegation(rdm[1]);
        if (!d || d.company_id !== c.id) throw new HttpError(404, 'no such delegation');
        sendJson(res, 200, await revokeMandates(c, [d.mandate], 'delegation', str(body.reason, 500) || 'delegated budget revoked by the owner', { agent_id: d.agent_id }));
        return;
      }
      // 3.0: payment channels, opened and closed by the server for an agent with a custodial key
      if (sub === 'channels') {
        const origin = bareOrigin(str(body.origin, 300));
        if (!origin || !c.gateways.includes(origin)) throw new HttpError(400, 'open a channel at one of the company\'s gateways');
        const agent = store.agent(str(body.agent_id, 64));
        if (!agent || agent.company_id !== c.id || agent.state !== 'active' || !agent.agent_priv) throw new HttpError(404, 'no such agent with its own key');
        let deposit: number;
        try { deposit = usdToMicro(normalizeUsd(str(body.deposit, 20))); } catch { throw new HttpError(400, 'deposit must be an amount like 1.00'); }
        const spent = store.companySpent(c.id);
        if (deposit <= 0 || deposit > c.budget - spent.tab - spent.model) throw new HttpError(400, `the deposit must fit in what the company has left (${microToUsd(Math.max(0, c.budget - spent.tab - spent.model))})`);
        const disc = await discoveryOf(origin);
        if (!disc?.channels) throw new HttpError(409, `${origin} takes no payment channels`);
        const days = Math.max(1, Math.min(30, Number(body.days ?? 7) || 7));
        const owner = { publicKey: c.owner_pub, privateKey: c.owner_priv };
        const mandate = issueMandate(owner, { agent: agent.agent_pub, budgetUsd: microToUsd(deposit), window: 'total', allow: [String(disc.realm)], days, evmOwner: addressFromSeed(seedOf(c.owner_priv)) });
        boardAct(c, 'channel', { op: 'open', origin, agent_id: agent.id, deposit: microToUsd(deposit), mandate_id: mandate.id });
        const client = new TabClient({ agent: { publicKey: agent.agent_pub, privateKey: agent.agent_priv }, mandate, currency: c.currency, fetch: egress });
        let held;
        try { held = await client.openChannel(origin, microToUsd(deposit), days * 86_400); } catch (err) { throw new HttpError(502, (err as Error).message); }
        const now = new Date().toISOString();
        store.addChannel({ id: held.id, company_id: c.id, agent_id: agent.id, origin, mandate, currency: c.currency, deposit, spent: 0, calls: 0, state: 'open', opened_at: held.opened_at, expires_at: held.expires_at, settle_ref: null, refund_ref: null, updated_at: now });
        store.addEvent({ company_id: c.id, ticket_id: null, agent_id: agent.id, kind: 'channel-open', body: { channel: held.id, origin, agent: agent.name, deposit: microToUsd(deposit), expires_at: held.expires_at } });
        sendJson(res, 200, { channel: held });
        return;
      }
      const chc = /^channels\/([A-Za-z0-9_-]+)\/close$/.exec(sub);
      if (chc) {
        const ch = store.channel(c.id, chc[1]);
        if (!ch) throw new HttpError(404, 'no such channel');
        if (ch.state !== 'open') throw new HttpError(409, 'channel is already closed');
        const agent = store.agent(ch.agent_id);
        if (!agent?.agent_priv) throw new HttpError(409, 'the channel agent has no key here');
        boardAct(c, 'channel', { op: 'close', origin: ch.origin, agent_id: agent.id, channel: ch.id });
        const client = new TabClient({ agent: { publicKey: agent.agent_pub, privateKey: agent.agent_priv }, mandate: ch.mandate, currency: c.currency, fetch: egress });
        // the client closes the channel it holds; seed its book with this one
        client.holdChannel({ id: ch.id, origin: ch.origin, realm: '', agent: agent.agent_pub, owner: c.owner_pub, mandate: ch.mandate.id, currency: ch.currency, deposit: String(ch.deposit), authorized: String(ch.spent), spent: String(ch.spent), held: '0', calls: ch.calls, state: 'open', opened_at: ch.opened_at, expires_at: ch.expires_at });
        let out;
        try { out = await client.closeChannel(ch.origin); } catch (err) { throw new HttpError(502, (err as Error).message); }
        store.updateChannel(c.id, ch.id, { state: 'closed', spent: Number(out.channel.spent), calls: out.channel.calls, settle_ref: out.channel.settle_ref ?? null, refund_ref: out.channel.refund_ref ?? null });
        store.addEvent({ company_id: c.id, ticket_id: null, agent_id: agent.id, kind: 'channel-close', body: { channel: ch.id, origin: ch.origin, spent: microToUsd(Number(out.channel.spent)), calls: out.channel.calls, refunded: microToUsd(ch.deposit - Number(out.channel.spent)) } });
        sendJson(res, 200, { channel: out.channel, receipt: out.receipt });
        return;
      }
      const cfm = /^agents\/([A-Za-z0-9_-]+)\/configure$/.exec(sub);
      if (cfm) {
        const pick: Record<string, unknown> = { agent_id: cfm[1] };
        for (const k of ['model', 'budget_per_run', 'max_per_call', 'approve_above', 'instructions', 'heartbeat_s', 'paths', 'hours']) if (body[k] !== undefined) pick[k] = body[k];
        sendJson(res, 200, boardAct(c, 'configure', pick) as object);
        return;
      }
      if (sub === 'budget') { sendJson(res, 200, boardAct(c, 'budget', { budget: str(body.budget, 20) }) as object); return; }
      if (sub === 'chain/authorize') {
        // the on-chain half of an agent's spending: the owner account approves the agent's account for an amount
        // of the token and tops up its gas. Mandates still cap every run; the allowance caps everything together.
        const ch = await chainOf(c);
        if (!ch) throw new HttpError(409, 'this company spends at no Robinhood Chain gateway');
        const agent = store.agent(str(body.agent_id, 64));
        if (!agent || agent.company_id !== c.id || agent.state !== 'active' || !agent.agent_priv) throw new HttpError(404, 'no such agent with its own key');
        let micro: number;
        try { micro = usdToMicro(normalizeUsd(str(body.amount, 20))); } catch { throw new HttpError(400, 'amount must be like 5.00'); }
        if (micro > c.budget) throw new HttpError(400, `the allowance cannot be more than the company budget (${microToUsd(c.budget)})`);
        const owner = { privateKey: c.owner_priv };
        const address = addressFromSeed(seedOf(agent.agent_priv));
        const txs: Array<{ kind: string; hash: string }> = [];
        try {
          const perTx = (await ch.rpc.gasPrice()) * GAS_TX;
          const have = await ch.rpc.balance(address);
          if (have < perTx * GAS_FLOOR_TXS) txs.push({ kind: 'gas', hash: await evmSend(ch.rpc, owner, address, perTx * GAS_TOP_UP_TXS - have, new Uint8Array(0)) });
          txs.push({ kind: 'allowance', hash: await evmSend(ch.rpc, owner, ch.token, 0n, erc20.approve(address, microToBaseUnits(BigInt(micro), ch.decimals))) });
        } catch (err) {
          const msg = (err as Error).message;
          throw new HttpError(400, /insufficient funds|gas/i.test(msg) ? `the owner account ${addressFromSeed(seedOf(c.owner_priv))} needs a little ETH for gas on chain ${ch.chain_id}` : `chain refused: ${msg}`);
        }
        store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'chain-authorize', body: { agent: agent.name, address, amount: microToUsd(micro), chain_id: ch.chain_id, txs, explorer: ch.explorer } });
        sendJson(res, 200, { ok: true, address, amount: microToUsd(micro), txs, explorer: ch.explorer });
        return;
      }
      if (sub === 'charter') { sendJson(res, 200, boardAct(c, 'charter', { ...(body.name !== undefined ? { name: str(body.name, 80) } : {}), ...(body.mission !== undefined ? { mission: str(body.mission, 20_000) } : {}) }) as object); return; }
      if (sub === 'pause' || sub === 'resume') {
        const out = boardAct(c, sub, { reason: str(body.reason, 500) }) as object;
        // pausing stops the money too: every run in flight loses its mandate at the gateways
        if (sub === 'pause') { const live = runMandates(c); await revokeMandates(c, live, 'run', 'the company was paused', {}, store.runningRuns(c.id).filter((r) => r.mandate).map((r) => r.agent_id)); }
        sendJson(res, 200, out);
        return;
      }
      if (sub === 'publish') { await checkEgress('publish', { gateway: str(body.gateway, 300) }); sendJson(res, 200, boardAct(c, 'publish', { gateway: str(body.gateway, 300) }) as object); return; }
      if (sub === 'model-key') {
        // the company's own Anthropic API key: verified against the API, sealed at rest, never returned
        if (!opts.secrets) throw new HttpError(503, 'this server has no secrets store, so it cannot hold model keys');
        if (body.remove === true) {
          store.updateCompany(c.id, { model_key: null, model_key_hint: null });
          store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'model-key', body: { removed: true, by: auth.user.email } });
          sendJson(res, 200, { ok: true, model_key: opts.hostModelKey ? 'host' : null, model_key_hint: null });
          return;
        }
        const key = str(body.key, 400).trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new HttpError(400, 'that does not look like an Anthropic API key (they start with sk-ant-)');
        let r: Response;
        try {
          r = await fetch(`${anthropicUrl}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) });
        } catch (err) {
          throw new HttpError(502, `could not reach the model API to check the key: ${(err as Error).message}`);
        }
        if (r.status === 401 || r.status === 403) throw new HttpError(400, 'Anthropic refused that key; check it in the Claude Console');
        if (!r.ok) throw new HttpError(502, `the model API answered HTTP ${r.status} while checking the key`);
        const hint = key.slice(-4);
        store.updateCompany(c.id, { model_key: opts.secrets.seal(key, c.id), model_key_hint: hint });
        store.addEvent({ company_id: c.id, ticket_id: null, agent_id: null, kind: 'model-key', body: { hint, by: auth.user.email } });
        log(`company ${c.id}: model key set (...${hint}) by ${auth.user.email}`);
        sendJson(res, 200, { ok: true, model_key: 'company', model_key_hint: hint });
        return;
      }
      const apm = /^approvals\/([A-Za-z0-9_-]+)$/.exec(sub);
      if (apm) {
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' || body.decision === 'deny' ? 'reject' : null;
        if (!decision) throw new HttpError(400, 'decision must be approve or reject');
        // the owner may change a hire's model or per call cap while approving it
        const extra: Record<string, unknown> = {};
        for (const k of ['model', 'max_per_call']) if (body[k] !== undefined) extra[k] = str(body[k], 80);
        const out = boardAct(c, decision, { approval_id: apm[1], ...extra }) as Record<string, unknown>;
        const ap = store.approval(apm[1]);
        if (ap && ap.kind === 'payment' && decision === 'approve') {
          // the gateway keeps the approval, so the agent's next try of the same call finds it
          const origin = String(ap.payload.origin ?? '');
          try {
            const r = await egress(`${origin}/.well-known/tab/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: ap.payload.request, approval: ap.payload.approval }), signal: AbortSignal.timeout(8_000) });
            store.patchApproval(ap.id, { posted: r.ok ? 'ok' : `HTTP ${r.status}: ${String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? '')}` });
          } catch (err) {
            store.patchApproval(ap.id, { posted: `failed: ${(err as Error).message}` });
          }
          out.posted = store.approval(ap.id)?.payload.posted;
        }
        sendJson(res, 200, out);
        return;
      }
      if (sub === 'fund') {
        // starter credits where a gateway offers them, for the owner wallet
        sendJson(res, 200, { wallet: c.owner_pub, results: await claimCredits(c) });
        return;
      }
      if (sub === 'tickets') {
        if (store.ticketCount(c.id) >= c.max_tickets) throw new HttpError(429, `company is at its ${c.max_tickets} ticket limit`);
        const title = str(body.title, 200).trim();
        if (!title) throw new HttpError(400, 'title is required');
        const assigneeName = str(body.assignee, 64);
        const assignee = assigneeName ? store.agentByName(c.id, assigneeName) ?? store.agent(assigneeName) : undefined;
        if (assigneeName && (!assignee || assignee.company_id !== c.id)) throw new HttpError(404, `no agent named ${assigneeName}`);
        let tb: number | null = null;
        if (body.budget) { try { tb = usdToMicro(normalizeUsd(str(body.budget, 20))); } catch { throw new HttpError(400, 'budget must be an amount like 0.50'); } }
        const t = store.createTicket({ company_id: c.id, title, body: str(body.body, 20_000), state: 'open', assignee_id: assignee?.id ?? null, created_by: 'owner', parent_id: null, budget: tb });
        store.addEvent({ company_id: c.id, ticket_id: t.id, agent_id: null, kind: 'ticket', body: { ticket_id: t.id, title, assignee: assignee?.name ?? null } });
        if (assignee) store.wake(assignee.id, t.id, 'assigned by owner');
        sendJson(res, 200, { ticket: publicTicket(t) });
        return;
      }
      const tm = /^tickets\/([A-Za-z0-9_-]+)(?:\/(comment))?$/.exec(sub);
      if (tm) {
        const t = store.ticket(tm[1]);
        if (!t || t.company_id !== c.id) { sendJson(res, 404, { error: 'no such ticket' }); return; }
        if (tm[2] === 'comment') {
          const text = str(body.text, 20_000).trim();
          if (!text) throw new HttpError(400, 'text is required');
          store.addEvent({ company_id: c.id, ticket_id: t.id, agent_id: null, kind: 'comment', body: { text } });
          engine.commentWakes(c, t, text, null);
          sendJson(res, 200, { ok: true });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (body.assignee !== undefined) {
          const name = str(body.assignee, 64);
          const a = name ? store.agentByName(c.id, name) ?? store.agent(name) : undefined;
          if (name && (!a || a.company_id !== c.id)) throw new HttpError(404, `no agent named ${name}`);
          patch.assignee_id = a?.id ?? null;
        }
        if (body.state !== undefined) {
          const to = str(body.state, 20) as TicketState;
          if (!TICKET_STATES.has(to)) throw new HttpError(400, 'bad state');
          if (to === 'done' && !t.evidence.length && !str(body.reason, 2000).trim()) throw new HttpError(400, 'nothing closes without evidence: give a reason');
          patch.state = to;
          if (to === 'done' && str(body.reason, 2000).trim()) {
            patch.evidence = [...t.evidence, { kind: 'owner', value: str(body.reason, 2000).trim(), at: new Date().toISOString() }];
          }
        }
        if (body.title !== undefined) patch.title = str(body.title, 200).trim() || t.title;
        if (body.body !== undefined) patch.body = str(body.body, 20_000);
        store.updateTicket(t.id, patch);
        if (patch.state && patch.state !== t.state) store.addEvent({ company_id: c.id, ticket_id: t.id, agent_id: null, kind: 'state', body: { from: t.state, to: patch.state, reason: str(body.reason, 2000) || undefined } });
        const after = store.ticket(t.id)!;
        if (after.assignee_id && (after.assignee_id !== t.assignee_id || (patch.state === 'open' && t.state !== 'open')) && (after.state === 'open' || after.state === 'in_progress')) {
          store.wake(after.assignee_id, t.id, after.assignee_id !== t.assignee_id ? 'assigned by owner' : 'reopened by owner');
        }
        sendJson(res, 200, { ticket: publicTicket(after) });
        return;
      }
      sendJson(res, 404, { error: 'no such endpoint' });
    } catch (err) {
      if (err instanceof HttpError) { sendJson(res, err.status, { error: err.message }); return; }
      log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
  return server;
}
