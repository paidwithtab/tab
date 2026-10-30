// The company server: accounts and sessions, the JSON API the dashboard and
// the CLI use, static files for the dashboard, and the trust boundary. It
// rejects any Host it was not started for (DNS rebinding), requires a same
// origin header on cookie-authenticated mutations, keeps sessions in HttpOnly
// cookies, rate limits sign up and log in per address, and signs every board
// action with the company owner key (or verifies one signed offline).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { microToUsd, usdToMicro, isCurrency, type Receipt } from '../protocol.js';
import { newKeyPair } from '../keys.js';
import { addressFromSeed } from '../evm/secp256k1.js';
import { originIsPublic } from '../catalog.js';
import { guardedFetch } from '../net.js';
import { signBoardAction, verifyBoardAction, BOARD_ACTIONS, type SignedBoardAction, type BoardActionKind } from './board.js';
import { ADAPTERS, type AdapterName } from './adapters.js';
import { ANTHROPIC_URL } from './model.js';
import type { Engine } from './engine.js';
import type { Secrets } from './secrets.js';
import type { AgentRow, CompanyRow, CompanyStore, TicketRow, TicketState, UserRow } from './store.js';

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
  log?: (msg: string) => void;
}

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

function findWeb(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../web', '../../../web']) {
    const p = join(here, rel);
    if (existsSync(join(p, 'app.html'))) return p;
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
    try { budget = usdToMicro(str(body.budget, 20) || '5.00'); } catch { throw new HttpError(400, 'budget must be an amount like 25.00'); }
    const gateways = (Array.isArray(body.gateways) ? body.gateways.map((g) => str(g, 300).replace(/\/$/, '')) : [opts.defaultGateway ?? '']).filter(Boolean).slice(0, 10);
    const { realms, currency: discovered } = await checkGateways(gateways);
    const currency = str(body.currency, 10) || discovered;
    if (!isCurrency(currency)) throw new HttpError(400, 'currency must be 2 to 10 upper-case letters or digits');
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
    const results = await Promise.all(c.gateways.map(async (origin) => {
      try {
        const r = await egress(`${origin}/.well-known/tab/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: c.owner_pub }), signal: AbortSignal.timeout(8_000) });
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

  function companyView(c: CompanyRow) {
    const agents = store.agentsOf(c.id);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const nameOf = (id: string | null) => (id === null ? 'owner' : names.get(id) ?? id);
    return {
      company: publicCompany(c),
      agents: agents.map(publicAgent),
      tickets: store.ticketsOf(c.id).map((t) => ({ ...publicTicket(t), assignee: nameOf(t.assignee_id), created_by_name: t.created_by === 'owner' ? 'owner' : nameOf(t.created_by) })),
      approvals: store.approvalsOf(c.id).map((a) => ({ ...a, agent: a.agent_id ? nameOf(a.agent_id) : null })),
      runs: store.runsOf(c.id, 50).map((r) => ({ ...r, agent: nameOf(r.agent_id), spent: microToUsd(r.spent), model_cost: microToUsd(r.model_cost), mandate: r.mandate ? { id: r.mandate.id, budget: microToUsd(Number(r.mandate.budget)), allow: r.mandate.allow } : null, output: undefined })),
      events: store.events(c.id, { limit: 100 }).map((e) => ({ ...e, by: nameOf(e.agent_id) })),
      board: store.board(c.id).map((b) => ({ ...b, verified: verifyBoardAction(c.owner_pub, { ver: 'tab-board/0', company: b.company_id, seq: b.seq, action: b.action as BoardActionKind, payload: b.payload, at: b.at, id: b.id, sig: b.sig }).ok })),
      receipts: store.receiptsOf(c.id, 50).map((r) => ({ ...r, agent: r.agent_id ? nameOf(r.agent_id) : null, amount: microToUsd(r.amount), signed: r.doc != null, doc: undefined })),
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
    switch (a.action) {
      case 'hire': {
        const name = str(p.name, 40);
        if (!NAME_RE.test(name)) throw new HttpError(400, 'agent name: letters, digits, dot, dash, underscore; up to 40');
        if (store.agentByName(c.id, name)) throw new HttpError(409, `an agent named ${name} exists`);
        const adapter = (ADAPTERS as readonly string[]).includes(String(p.adapter)) && adapters.has(p.adapter as AdapterName) ? (p.adapter as AdapterName) : null;
        if (!adapter) throw new HttpError(400, `adapter must be one of ${[...adapters].join(', ')}`);
        const config = (p.config && typeof p.config === 'object' && !Array.isArray(p.config) ? p.config : {}) as Record<string, unknown>;
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
        try { budget_per_run = usdToMicro(str(p.budget_per_run, 20) || '0.50'); } catch { throw new HttpError(400, 'budget_per_run must be an amount like 0.50'); }
        const heartbeat_s = Math.max(0, Math.min(86_400 * 7, Number(p.heartbeat_s ?? 0) || 0));
        const agent = store.createAgent({
          company_id: c.id, name, role: str(p.role, 200) || 'agent', instructions: str(p.instructions, 20_000), adapter, config,
          agent_pub, agent_priv, budget_per_run, heartbeat_s, state: 'active',
        }, now);
        ev('hire', { agent_id: agent.id, name, role: agent.role, adapter, agent_pub, budget_per_run: microToUsd(budget_per_run) });
        return publicAgent(agent);
      }
      case 'retire': {
        const agent = store.agent(str(p.agent_id, 64));
        if (!agent || agent.company_id !== c.id) throw new HttpError(404, 'no such agent');
        store.updateAgent(agent.id, { state: 'retired' });
        ev('retire', { agent_id: agent.id, name: agent.name });
        return { ok: true };
      }
      case 'budget': {
        let budget: number;
        try { budget = usdToMicro(str(p.budget, 20)); } catch { throw new HttpError(400, 'budget must be an amount like 25.00'); }
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
        if (ap.agent_id && ap.ticket_id) store.wake(ap.agent_id, ap.ticket_id, `request ${a.action === 'approve' ? 'approved' : 'rejected'}`, now);
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
        // tab OS at /os, the classic dashboard at /; same API, same session
        const page = path === '/' || path === '/app' || path === '/index.html' ? 'app.html' : path === '/os' || path === '/os/' ? 'os.html' : null;
        if (page) {
          // the page's one inline script runs under a per-response nonce; nothing else may execute
          const nonce = randomBytes(16).toString('base64url');
          const html = readFileSync(join(web, page), 'utf8').replace(/<script>/g, `<script nonce="${nonce}">`);
          res.writeHead(200, { 'content-type': TYPES.html, 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'` });
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
        if (sub === 'balances') {
          const balances = await Promise.all(c.gateways.map(async (origin) => {
            try {
              const r = await egress(`${origin}/.well-known/tab/wallet/${encodeURIComponent(c.owner_pub)}`, { signal: AbortSignal.timeout(8_000) });
              return { origin, ...((await r.json()) as Record<string, unknown>) };
            } catch (err) { return { origin, error: (err as Error).message }; }
          }));
          sendJson(res, 200, { wallet: c.owner_pub, balances });
          return;
        }
        if (sub === 'earnings') {
          if (!c.sell_gateway) { sendJson(res, 200, { gateway: null, earned: '0.00', receipts: [] }); return; }
          try {
            const w = await (await egress(`${c.sell_gateway}/.well-known/tab/wallet/${encodeURIComponent(c.owner_pub)}`, { signal: AbortSignal.timeout(8_000) })).json() as Record<string, unknown>;
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
      if (am) { sendJson(res, 200, boardAct(c, 'retire', { agent_id: am[1] }) as object); return; }
      if (sub === 'budget') { sendJson(res, 200, boardAct(c, 'budget', { budget: str(body.budget, 20) }) as object); return; }
      if (sub === 'pause' || sub === 'resume') { sendJson(res, 200, boardAct(c, sub, { reason: str(body.reason, 500) }) as object); return; }
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
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
        if (!decision) throw new HttpError(400, 'decision must be approve or reject');
        sendJson(res, 200, boardAct(c, decision, { approval_id: apm[1] }) as object);
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
        if (body.budget) { try { tb = usdToMicro(str(body.budget, 20)); } catch { throw new HttpError(400, 'budget must be an amount like 0.50'); } }
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
