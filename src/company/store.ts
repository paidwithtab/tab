// The company database: users, sessions, companies, agents, tickets, an
// append-only event log, runs, approvals, wakes, receipts and the signed board
// log. One SQLite file per server, WAL mode, on node:sqlite. Owner and agent
// keys for hosted accounts are custodial here; the file should be mode 600.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { randomId, type Receipt } from '../protocol.js';
import type { Mandate } from '../mandate.js';

export interface UserRow { id: string; email: string; created_at: string }
export interface SessionRow { id: string; user_id: string; created_at: string; expires_at: string }

export interface CompanyRow {
  id: string;
  user_id: string;
  name: string;
  mission: string;
  owner_pub: string;
  owner_priv: string; // custodial; exportable by the owner
  budget: number; // micro units of currency; the whole company's spending cap
  currency: string;
  gateways: string[]; // origins agents may spend at
  realms: string[]; // realms of those gateways; the mandate allow list
  catalog: string | null;
  sell_gateway: string | null; // where the company earns, set by the publish action
  model_key: string | null; // the company's Anthropic API key, sealed by Secrets; never leaves the server
  model_key_hint: string | null; // its last four characters, for the dashboard
  state: 'active' | 'paused';
  warned: boolean; // the 80 percent warning was written
  concurrency: number; // runs at once
  max_tickets: number; // agents cannot open tickets past this
  created_at: string;
}

export interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  role: string;
  instructions: string;
  adapter: 'claude' | 'claude-code' | 'http';
  config: Record<string, unknown>;
  agent_pub: string;
  agent_priv: string | null; // custodial for the claude adapters; null for http agents that hold their own key
  budget_per_run: number; // micro; the mandate ceiling for one run
  heartbeat_s: number; // 0 = only wake on assignment or mention
  state: 'active' | 'retired';
  last_run_at: string | null;
  created_at: string;
}

export type TicketState = 'open' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

export interface TicketRow {
  id: string;
  company_id: string;
  title: string;
  body: string;
  state: TicketState;
  assignee_id: string | null;
  created_by: string; // 'owner' or an agent id
  parent_id: string | null;
  budget: number | null; // micro cap for this ticket, or null
  spent: number; // micro attributed to this ticket
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
}

export interface Evidence { kind: string; value: string; run_id?: string; at?: string }

export interface EventRow {
  seq: number;
  company_id: string;
  ticket_id: string | null;
  agent_id: string | null; // null = the owner or the system
  kind: string; // comment, state, run, budget-warning, paused, resumed, approval, hire, ...
  body: unknown;
  at: string;
}

export interface RunRow {
  id: string;
  company_id: string;
  agent_id: string;
  ticket_id: string | null;
  reason: string; // assigned, mention, heartbeat, approval
  mandate: Mandate | null;
  state: 'running' | 'done' | 'failed';
  started_at: string;
  ended_at: string | null;
  spent: number; // micro paid through tab, attributed from gateways
  model_cost: number; // micro the model itself cost (claude adapter reports it)
  result: unknown | null;
  output: string | null; // raw adapter output, truncated
  error: string | null;
}

export interface ApprovalRow {
  id: string;
  company_id: string;
  ticket_id: string | null;
  agent_id: string | null;
  kind: string; // budget, hire, other
  payload: Record<string, unknown>;
  state: 'pending' | 'approved' | 'rejected';
  created_at: string;
  decided_at: string | null;
}

export interface WakeRow { agent_id: string; ticket_id: string | null; reason: string; at: string }

export interface BoardRow {
  seq: number;
  company_id: string;
  id: string;
  action: string;
  payload: unknown;
  at: string;
  sig: string;
}

export interface CompanyReceipt {
  id: string;
  company_id: string;
  run_id: string | null;
  agent_id: string | null;
  origin: string;
  realm: string;
  resource: string;
  amount: number;
  currency: string;
  at: string;
  verified: boolean; // signed by the key the gateway publishes, for this run's mandate
  doc: Receipt | null; // the receipt as the gateway signed it
}

const parse = <T>(s: unknown, fallback: T): T => {
  if (s == null) return fallback;
  try { return JSON.parse(String(s)) as T; } catch { return fallback; }
};

export class CompanyStore {
  private db: DatabaseSync;

  constructor(public readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, mission TEXT NOT NULL,
        owner_pub TEXT NOT NULL, owner_priv TEXT NOT NULL, budget INTEGER NOT NULL, currency TEXT NOT NULL,
        gateways TEXT NOT NULL, realms TEXT NOT NULL, catalog TEXT, sell_gateway TEXT,
        state TEXT NOT NULL, warned INTEGER NOT NULL DEFAULT 0, concurrency INTEGER NOT NULL DEFAULT 2,
        max_tickets INTEGER NOT NULL DEFAULT 200, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL,
        adapter TEXT NOT NULL, config TEXT NOT NULL, agent_pub TEXT NOT NULL, agent_priv TEXT,
        budget_per_run INTEGER NOT NULL, heartbeat_s INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
        last_run_at TEXT, created_at TEXT NOT NULL, UNIQUE (company_id, name)
      );
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
        assignee_id TEXT, created_by TEXT NOT NULL, parent_id TEXT, budget INTEGER, spent INTEGER NOT NULL DEFAULT 0,
        evidence TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, ticket_id TEXT, agent_id TEXT,
        kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_company ON events (company_id, seq);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, agent_id TEXT NOT NULL, ticket_id TEXT, reason TEXT NOT NULL,
        mandate TEXT, state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        spent INTEGER NOT NULL DEFAULT 0, model_cost INTEGER NOT NULL DEFAULT 0, result TEXT, output TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_company ON runs (company_id, started_at);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, ticket_id TEXT, agent_id TEXT, kind TEXT NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS wakes (
        agent_id TEXT NOT NULL, ticket_id TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (agent_id, ticket_id)
      );
      CREATE TABLE IF NOT EXISTS board (
        company_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL,
        payload TEXT NOT NULL, at TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY (company_id, seq)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, run_id TEXT, agent_id TEXT, origin TEXT NOT NULL,
        realm TEXT NOT NULL, resource TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS limits (key TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS limits_key ON limits (key, at);
    `);
    // 2.2: a sealed model key per company
    const cols = new Set((this.db.prepare('PRAGMA table_info(companies)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('model_key')) this.db.exec('ALTER TABLE companies ADD COLUMN model_key TEXT');
    if (!cols.has('model_key_hint')) this.db.exec('ALTER TABLE companies ADD COLUMN model_key_hint TEXT');
    // 2.3: signed receipts, kept whole with the engine's verdict
    const rcols = new Set((this.db.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!rcols.has('verified')) this.db.exec('ALTER TABLE receipts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
    if (!rcols.has('doc')) this.db.exec('ALTER TABLE receipts ADD COLUMN doc TEXT');
    // receipt ids are unique per gateway, not across tenants: a gateway one company names must not
    // be able to claim, and so drop, another company's receipt ids
    const pk = (this.db.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).map((c) => c.name);
    if (pk.length === 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE receipts_v2 (
          id TEXT NOT NULL, company_id TEXT NOT NULL, run_id TEXT, agent_id TEXT, origin TEXT NOT NULL,
          realm TEXT NOT NULL, resource TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, at TEXT NOT NULL,
          verified INTEGER NOT NULL DEFAULT 0, doc TEXT, PRIMARY KEY (company_id, id)
        );
        INSERT INTO receipts_v2 (id, company_id, run_id, agent_id, origin, realm, resource, amount, currency, at, verified, doc)
          SELECT id, company_id, run_id, agent_id, origin, realm, resource, amount, currency, at, verified, doc FROM receipts;
        DROP TABLE receipts;
        ALTER TABLE receipts_v2 RENAME TO receipts;
        COMMIT;
      `);
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -- users and sessions --------------------------------------------------

  createUser(email: string, password: string, now = new Date()): UserRow {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    const row: UserRow = { id: randomId(), email, created_at: now.toISOString() };
    this.db.prepare('INSERT INTO users (id, email, pass_hash, salt, created_at) VALUES (?,?,?,?,?)')
      .run(row.id, email, hash, salt, row.created_at);
    return row;
  }

  userByEmail(email: string): UserRow | undefined {
    const r = this.db.prepare('SELECT id, email, created_at FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return r;
  }

  /** Constant-time password check. Returns the user on success. */
  authenticate(email: string, password: string): UserRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | { id: string; email: string; pass_hash: string; salt: string; created_at: string } | undefined;
    // hash even when the user is unknown so timing does not reveal which emails exist
    const salt = r?.salt ?? 'no-such-user';
    const got = scryptSync(password, salt, 64);
    const want = r ? Buffer.from(r.pass_hash, 'hex') : Buffer.alloc(64);
    if (!r || got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    return { id: r.id, email: r.email, created_at: r.created_at };
  }

  createSession(userId: string, days = 30, now = new Date()): SessionRow {
    const row: SessionRow = {
      id: randomId(24), user_id: userId, created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
    };
    this.db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(row.id, row.user_id, row.created_at, row.expires_at);
    return row;
  }

  userBySession(sessionId: string, now = new Date()): UserRow | undefined {
    const r = this.db.prepare(
      'SELECT u.id, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
    ).get(sessionId, now.toISOString()) as UserRow | undefined;
    return r;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  // -- rate limits (per key, sliding window) --------------------------------

  /** Record one hit and return how many hits the key had in the window, this one included. */
  hit(key: string, windowMs: number, now = new Date()): number {
    const since = new Date(now.getTime() - windowMs).toISOString();
    this.db.prepare('DELETE FROM limits WHERE key = ? AND at < ?').run(key, since);
    this.db.prepare('INSERT INTO limits (key, at) VALUES (?, ?)').run(key, now.toISOString());
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM limits WHERE key = ? AND at >= ?').get(key, since) as { n: number };
    return Number(r.n);
  }

  // -- companies -----------------------------------------------------------

  private rowToCompany(r: Record<string, unknown>): CompanyRow {
    return {
      id: String(r.id), user_id: String(r.user_id), name: String(r.name), mission: String(r.mission),
      owner_pub: String(r.owner_pub), owner_priv: String(r.owner_priv), budget: Number(r.budget),
      currency: String(r.currency), gateways: parse<string[]>(r.gateways, []), realms: parse<string[]>(r.realms, []),
      catalog: r.catalog == null ? null : String(r.catalog), sell_gateway: r.sell_gateway == null ? null : String(r.sell_gateway),
      model_key: r.model_key == null ? null : String(r.model_key), model_key_hint: r.model_key_hint == null ? null : String(r.model_key_hint),
      state: r.state as CompanyRow['state'], warned: Number(r.warned) === 1, concurrency: Number(r.concurrency),
      max_tickets: Number(r.max_tickets), created_at: String(r.created_at),
    };
  }

  createCompany(c: Omit<CompanyRow, 'id' | 'created_at' | 'warned' | 'model_key' | 'model_key_hint'> & { id?: string }, now = new Date()): CompanyRow {
    const row: CompanyRow = { ...c, id: c.id ?? randomId(), warned: false, model_key: null, model_key_hint: null, created_at: now.toISOString() };
    this.db.prepare(`INSERT INTO companies (id, user_id, name, mission, owner_pub, owner_priv, budget, currency, gateways, realms,
      catalog, sell_gateway, state, warned, concurrency, max_tickets, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.user_id, row.name, row.mission, row.owner_pub, row.owner_priv, row.budget, row.currency,
        JSON.stringify(row.gateways), JSON.stringify(row.realms), row.catalog, row.sell_gateway, row.state, 0,
        row.concurrency, row.max_tickets, row.created_at);
    return row;
  }

  company(id: string): CompanyRow | undefined {
    const r = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToCompany(r) : undefined;
  }

  companiesOf(userId: string): CompanyRow[] {
    return (this.db.prepare('SELECT * FROM companies WHERE user_id = ? ORDER BY created_at').all(userId) as Record<string, unknown>[])
      .map((r) => this.rowToCompany(r));
  }

  allCompanies(): CompanyRow[] {
    return (this.db.prepare('SELECT * FROM companies ORDER BY created_at').all() as Record<string, unknown>[])
      .map((r) => this.rowToCompany(r));
  }

  updateCompany(id: string, patch: Partial<Pick<CompanyRow, 'budget' | 'state' | 'warned' | 'sell_gateway' | 'mission' | 'name' | 'gateways' | 'realms' | 'concurrency' | 'model_key' | 'model_key_hint'>>): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      if (k === 'warned') args.push(v ? 1 : 0);
      else if (Array.isArray(v)) args.push(JSON.stringify(v));
      else args.push(v as string | number | null);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** Micro spent by a company: what its runs paid through tab plus what the model cost. */
  companySpent(id: string): { tab: number; model: number } {
    const r = this.db.prepare('SELECT COALESCE(SUM(spent),0) AS tab, COALESCE(SUM(model_cost),0) AS model FROM runs WHERE company_id = ?')
      .get(id) as { tab: number; model: number };
    return { tab: Number(r.tab), model: Number(r.model) };
  }

  // -- agents --------------------------------------------------------------

  private rowToAgent(r: Record<string, unknown>): AgentRow {
    return {
      id: String(r.id), company_id: String(r.company_id), name: String(r.name), role: String(r.role),
      instructions: String(r.instructions), adapter: r.adapter as AgentRow['adapter'], config: parse(r.config, {}),
      agent_pub: String(r.agent_pub), agent_priv: r.agent_priv == null ? null : String(r.agent_priv),
      budget_per_run: Number(r.budget_per_run), heartbeat_s: Number(r.heartbeat_s), state: r.state as AgentRow['state'],
      last_run_at: r.last_run_at == null ? null : String(r.last_run_at), created_at: String(r.created_at),
    };
  }

  createAgent(a: Omit<AgentRow, 'id' | 'created_at' | 'last_run_at'>, now = new Date()): AgentRow {
    const row: AgentRow = { ...a, id: randomId(), last_run_at: null, created_at: now.toISOString() };
    this.db.prepare(`INSERT INTO agents (id, company_id, name, role, instructions, adapter, config, agent_pub, agent_priv,
      budget_per_run, heartbeat_s, state, last_run_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.company_id, row.name, row.role, row.instructions, row.adapter, JSON.stringify(row.config),
        row.agent_pub, row.agent_priv, row.budget_per_run, row.heartbeat_s, row.state, null, row.created_at);
    return row;
  }

  agent(id: string): AgentRow | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToAgent(r) : undefined;
  }

  agentByName(companyId: string, name: string): AgentRow | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE company_id = ? AND name = ?').get(companyId, name) as Record<string, unknown> | undefined;
    return r ? this.rowToAgent(r) : undefined;
  }

  agentsOf(companyId: string): AgentRow[] {
    return (this.db.prepare('SELECT * FROM agents WHERE company_id = ? ORDER BY created_at').all(companyId) as Record<string, unknown>[])
      .map((r) => this.rowToAgent(r));
  }

  updateAgent(id: string, patch: Partial<Pick<AgentRow, 'state' | 'last_run_at' | 'budget_per_run' | 'heartbeat_s' | 'instructions' | 'config'>>): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(k === 'config' ? JSON.stringify(v) : (v as string | number | null));
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  // -- tickets -------------------------------------------------------------

  private rowToTicket(r: Record<string, unknown>): TicketRow {
    return {
      id: String(r.id), company_id: String(r.company_id), title: String(r.title), body: String(r.body),
      state: r.state as TicketState, assignee_id: r.assignee_id == null ? null : String(r.assignee_id),
      created_by: String(r.created_by), parent_id: r.parent_id == null ? null : String(r.parent_id),
      budget: r.budget == null ? null : Number(r.budget), spent: Number(r.spent), evidence: parse<Evidence[]>(r.evidence, []),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }

  createTicket(t: Omit<TicketRow, 'id' | 'created_at' | 'updated_at' | 'spent' | 'evidence'>, now = new Date()): TicketRow {
    const at = now.toISOString();
    const row: TicketRow = { ...t, id: randomId(6), spent: 0, evidence: [], created_at: at, updated_at: at };
    this.db.prepare(`INSERT INTO tickets (id, company_id, title, body, state, assignee_id, created_by, parent_id, budget, spent,
      evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.company_id, row.title, row.body, row.state, row.assignee_id, row.created_by, row.parent_id,
        row.budget, 0, '[]', at, at);
    return row;
  }

  ticket(id: string): TicketRow | undefined {
    const r = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToTicket(r) : undefined;
  }

  ticketsOf(companyId: string): TicketRow[] {
    return (this.db.prepare('SELECT * FROM tickets WHERE company_id = ? ORDER BY created_at').all(companyId) as Record<string, unknown>[])
      .map((r) => this.rowToTicket(r));
  }

  ticketCount(companyId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE company_id = ?').get(companyId) as { n: number };
    return Number(r.n);
  }

  updateTicket(id: string, patch: Partial<Pick<TicketRow, 'state' | 'assignee_id' | 'title' | 'body' | 'budget' | 'evidence'>> & { addSpent?: number }, now = new Date()): void {
    const sets: string[] = ['updated_at = ?'];
    const args: Array<string | number | null> = [now.toISOString()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === 'addSpent') continue;
      sets.push(`${k} = ?`);
      args.push(k === 'evidence' ? JSON.stringify(v) : (v as string | number | null));
    }
    if (patch.addSpent) {
      sets.push('spent = spent + ?');
      args.push(patch.addSpent);
    }
    args.push(id);
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  // -- events (append only) ------------------------------------------------

  addEvent(e: Omit<EventRow, 'seq' | 'at'> & { at?: string }, now = new Date()): EventRow {
    const at = e.at ?? now.toISOString();
    const res = this.db.prepare('INSERT INTO events (company_id, ticket_id, agent_id, kind, body, at) VALUES (?,?,?,?,?,?)')
      .run(e.company_id, e.ticket_id, e.agent_id, e.kind, JSON.stringify(e.body ?? null), at);
    return { ...e, seq: Number(res.lastInsertRowid), at };
  }

  events(companyId: string, opts: { ticketId?: string; after?: number; limit?: number } = {}): EventRow[] {
    const where = ['company_id = ?'];
    const args: Array<string | number> = [companyId];
    if (opts.ticketId) { where.push('ticket_id = ?'); args.push(opts.ticketId); }
    if (opts.after !== undefined) { where.push('seq > ?'); args.push(opts.after); }
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    // newest first when paging a company feed; oldest first for a ticket thread
    const order = opts.ticketId ? 'ASC' : 'DESC';
    args.push(limit);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT ?`).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq), company_id: String(r.company_id), ticket_id: r.ticket_id == null ? null : String(r.ticket_id),
      agent_id: r.agent_id == null ? null : String(r.agent_id), kind: String(r.kind), body: parse(r.body, null), at: String(r.at),
    }));
  }

  // -- runs ----------------------------------------------------------------

  private rowToRun(r: Record<string, unknown>): RunRow {
    return {
      id: String(r.id), company_id: String(r.company_id), agent_id: String(r.agent_id),
      ticket_id: r.ticket_id == null ? null : String(r.ticket_id), reason: String(r.reason),
      mandate: parse<Mandate | null>(r.mandate, null), state: r.state as RunRow['state'],
      started_at: String(r.started_at), ended_at: r.ended_at == null ? null : String(r.ended_at),
      spent: Number(r.spent), model_cost: Number(r.model_cost), result: parse(r.result, null),
      output: r.output == null ? null : String(r.output), error: r.error == null ? null : String(r.error),
    };
  }

  createRun(run: Omit<RunRow, 'ended_at' | 'spent' | 'model_cost' | 'result' | 'output' | 'error' | 'state'>): RunRow {
    const row: RunRow = { ...run, state: 'running', ended_at: null, spent: 0, model_cost: 0, result: null, output: null, error: null };
    this.db.prepare(`INSERT INTO runs (id, company_id, agent_id, ticket_id, reason, mandate, state, started_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(row.id, row.company_id, row.agent_id, row.ticket_id, row.reason, row.mandate ? JSON.stringify(row.mandate) : null,
        row.state, row.started_at);
    return row;
  }

  finishRun(id: string, patch: Pick<RunRow, 'state' | 'spent' | 'model_cost' | 'result' | 'output' | 'error'>, now = new Date()): void {
    this.db.prepare('UPDATE runs SET state = ?, ended_at = ?, spent = ?, model_cost = ?, result = ?, output = ?, error = ? WHERE id = ?')
      .run(patch.state, now.toISOString(), patch.spent, patch.model_cost, patch.result == null ? null : JSON.stringify(patch.result),
        patch.output == null ? null : patch.output.slice(0, 200_000), patch.error, id);
  }

  run(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToRun(r) : undefined;
  }

  runsOf(companyId: string, limit = 50): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs WHERE company_id = ? ORDER BY started_at DESC LIMIT ?').all(companyId, limit) as Record<string, unknown>[])
      .map((r) => this.rowToRun(r));
  }

  runsOnTicketSince(ticketId: string, since: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE ticket_id = ? AND started_at >= ?').get(ticketId, since) as { n: number }).n);
  }

  /** Spend a gateway booked against a run's mandate after the run was booked. */
  addRunSpend(id: string, micro: number): void {
    this.db.prepare('UPDATE runs SET spent = spent + ? WHERE id = ?').run(micro, id);
  }

  runningRuns(companyId?: string): RunRow[] {
    const rows = companyId
      ? this.db.prepare("SELECT * FROM runs WHERE state = 'running' AND company_id = ?").all(companyId)
      : this.db.prepare("SELECT * FROM runs WHERE state = 'running'").all();
    return (rows as Record<string, unknown>[]).map((r) => this.rowToRun(r));
  }

  // -- approvals -----------------------------------------------------------

  private rowToApproval(r: Record<string, unknown>): ApprovalRow {
    return {
      id: String(r.id), company_id: String(r.company_id), ticket_id: r.ticket_id == null ? null : String(r.ticket_id),
      agent_id: r.agent_id == null ? null : String(r.agent_id), kind: String(r.kind), payload: parse(r.payload, {}),
      state: r.state as ApprovalRow['state'], created_at: String(r.created_at), decided_at: r.decided_at == null ? null : String(r.decided_at),
    };
  }

  createApproval(a: Omit<ApprovalRow, 'id' | 'created_at' | 'decided_at' | 'state'>, now = new Date()): ApprovalRow {
    const row: ApprovalRow = { ...a, id: randomId(6), state: 'pending', created_at: now.toISOString(), decided_at: null };
    this.db.prepare('INSERT INTO approvals (id, company_id, ticket_id, agent_id, kind, payload, state, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.company_id, row.ticket_id, row.agent_id, row.kind, JSON.stringify(row.payload), row.state, row.created_at);
    return row;
  }

  approval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToApproval(r) : undefined;
  }

  approvalsOf(companyId: string): ApprovalRow[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE company_id = ? ORDER BY created_at DESC').all(companyId) as Record<string, unknown>[])
      .map((r) => this.rowToApproval(r));
  }

  decideApproval(id: string, state: 'approved' | 'rejected', now = new Date()): boolean {
    const res = this.db.prepare("UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, now.toISOString(), id);
    return Number(res.changes) > 0;
  }

  // -- wakes ---------------------------------------------------------------

  wake(agentId: string, ticketId: string | null, reason: string, now = new Date()): void {
    this.db.prepare('INSERT OR IGNORE INTO wakes (agent_id, ticket_id, reason, at) VALUES (?,?,?,?)')
      .run(agentId, ticketId ?? '', reason, now.toISOString());
  }

  wakes(): WakeRow[] {
    return (this.db.prepare('SELECT * FROM wakes ORDER BY at').all() as Record<string, unknown>[]).map((r) => ({
      agent_id: String(r.agent_id), ticket_id: r.ticket_id === '' ? null : String(r.ticket_id), reason: String(r.reason), at: String(r.at),
    }));
  }

  clearWake(agentId: string, ticketId: string | null): void {
    this.db.prepare('DELETE FROM wakes WHERE agent_id = ? AND ticket_id = ?').run(agentId, ticketId ?? '');
  }

  // -- board log -----------------------------------------------------------

  boardSeq(companyId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM board WHERE company_id = ?').get(companyId) as { n: number };
    return Number(r.n);
  }

  addBoard(b: BoardRow): void {
    this.db.prepare('INSERT INTO board (company_id, seq, id, action, payload, at, sig) VALUES (?,?,?,?,?,?,?)')
      .run(b.company_id, b.seq, b.id, b.action, JSON.stringify(b.payload ?? null), b.at, b.sig);
  }

  board(companyId: string): BoardRow[] {
    return (this.db.prepare('SELECT * FROM board WHERE company_id = ? ORDER BY seq').all(companyId) as Record<string, unknown>[]).map((r) => ({
      company_id: String(r.company_id), seq: Number(r.seq), id: String(r.id), action: String(r.action),
      payload: parse(r.payload, null), at: String(r.at), sig: String(r.sig),
    }));
  }

  // -- receipts ------------------------------------------------------------

  addReceipt(r: CompanyReceipt): void {
    this.db.prepare(`INSERT OR IGNORE INTO receipts (id, company_id, run_id, agent_id, origin, realm, resource, amount, currency, at, verified, doc)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.company_id, r.run_id, r.agent_id, r.origin, r.realm, r.resource, r.amount, r.currency, r.at, r.verified ? 1 : 0, r.doc ? JSON.stringify(r.doc) : null);
  }

  receipt(companyId: string, id: string): CompanyReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE company_id = ? AND id = ?').get(companyId, id) as Record<string, unknown> | undefined;
    return row ? this.receiptRow(row) : undefined;
  }

  receiptsOf(companyId: string, limit = 100): CompanyReceipt[] {
    return (this.db.prepare('SELECT * FROM receipts WHERE company_id = ? ORDER BY at DESC LIMIT ?').all(companyId, limit) as Record<string, unknown>[]).map((r) => this.receiptRow(r));
  }

  private receiptRow(r: Record<string, unknown>): CompanyReceipt {
    return ({
      id: String(r.id), company_id: String(r.company_id), run_id: r.run_id == null ? null : String(r.run_id),
      agent_id: r.agent_id == null ? null : String(r.agent_id), origin: String(r.origin), realm: String(r.realm),
      resource: String(r.resource), amount: Number(r.amount), currency: String(r.currency), at: String(r.at),
      verified: Number(r.verified) === 1, doc: r.doc ? (JSON.parse(String(r.doc)) as Receipt) : null,
    });
  }

  close(): void {
    this.db.close();
  }
}
