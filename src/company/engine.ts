// The engine: wakes agents on assignment, mention or heartbeat, issues one
// mandate per run from the company owner key, runs the adapter, then asks the
// gateways what the mandate actually spent and books it against the run, the
// ticket and the company. Warns at 80 percent of the company budget, pauses at
// 100. A ticket is done only when the agent attached evidence.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { microToUsd, randomId, usdToMicro, type Receipt } from '../protocol.js';
import { issueMandate, type Mandate } from '../mandate.js';
import { addressFromSeed } from '../evm/secp256k1.js';
import type { KeyPair } from '../keys.js';
import { buildPacket, type AgentResult } from './packet.js';
import { runAdapter } from './adapters.js';
import type { Secrets } from './secrets.js';
import type { AgentRow, CompanyStore, CompanyRow, Evidence, RunRow, TicketRow } from './store.js';

export interface EngineOptions {
  store: CompanyStore;
  workDir: string; // per-company workspaces live under here
  /** Opens the sealed model keys. Without it no company key can be read. */
  secrets?: Secrets;
  /** The server's own Anthropic key for companies that set none (self-hosted convenience). */
  hostModelKey?: string | null;
  /** Where the claude adapter sends Messages API calls; tests point it at a stub. */
  anthropicUrl?: string;
  log?: (msg: string) => void;
  tickMs?: number; // default 3000
  runTimeoutMs?: number; // default 600 s
  fetch?: typeof fetch;
}

const ACTIVE: ReadonlySet<string> = new Set(['open', 'in_progress']);
// a ticket in review can still be worked by the colleague it was handed to
const WAKEABLE: ReadonlySet<string> = new Set(['open', 'in_progress', 'review']);

export class Engine {
  private store: CompanyStore;
  private log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private running = new Map<string, Promise<void>>(); // agent id -> the run in flight
  private keyNoted = new Set<string>(); // companies told once that their claude agents wait on a model key
  readonly workDir: string;
  readonly runTimeoutMs: number;
  private doFetch: typeof fetch;

  constructor(private opts: EngineOptions) {
    this.store = opts.store;
    this.log = opts.log ?? (() => {});
    this.workDir = opts.workDir;
    this.runTimeoutMs = opts.runTimeoutMs ?? 600_000;
    this.doFetch = opts.fetch ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 3_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for every run in flight (tests). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  // -- scheduling ----------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const started = new Set<string>();
      const runningPerCompany = new Map<string, number>();
      const countRunning = (companyId: string) => {
        if (!runningPerCompany.has(companyId)) {
          let n = 0;
          for (const a of this.store.agentsOf(companyId)) if (this.running.has(a.id)) n++;
          runningPerCompany.set(companyId, n);
        }
        return runningPerCompany.get(companyId)!;
      };
      const tryStart = (company: CompanyRow, agent: AgentRow, ticket: TicketRow | null, reason: string): boolean => {
        if (company.state !== 'active' || agent.state !== 'active') return false;
        if (this.running.has(agent.id) || started.has(agent.id)) return false;
        if (countRunning(company.id) >= company.concurrency) return false;
        if (agent.adapter === 'claude' && !this.modelKeyFor(company)) {
          // the wake stays; the run starts on the first tick after the owner adds a key
          if (!this.keyNoted.has(company.id)) {
            this.keyNoted.add(company.id);
            this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'needs-model-key', body: { agent: agent.name, reason: 'add an Anthropic API key to the company so its claude agents can run' } }, now);
            this.log(`company ${company.name}: ${agent.name} waits for a model key`);
          }
          return false;
        }
        if (agent.adapter === 'claude') this.keyNoted.delete(company.id);
        started.add(agent.id);
        runningPerCompany.set(company.id, countRunning(company.id) + 1);
        this.launch(company, agent, ticket, reason);
        return true;
      };

      // 1. explicit wakes: assignment, mention, approval, owner comment
      for (const w of this.store.wakes()) {
        const agent = this.store.agent(w.agent_id);
        if (!agent || agent.state !== 'active') { this.store.clearWake(w.agent_id, w.ticket_id); continue; }
        const company = this.store.company(agent.company_id);
        if (!company) { this.store.clearWake(w.agent_id, w.ticket_id); continue; }
        const ticket = w.ticket_id ? this.store.ticket(w.ticket_id) ?? null : null;
        if (w.ticket_id && (!ticket || !WAKEABLE.has(ticket.state))) { this.store.clearWake(w.agent_id, w.ticket_id); continue; }
        if (tryStart(company, agent, ticket, w.reason)) this.store.clearWake(w.agent_id, w.ticket_id);
      }

      // 2. heartbeats: an agent with open tickets and no run within its interval
      for (const company of this.store.allCompanies()) {
        if (company.state !== 'active') continue;
        for (const agent of this.store.agentsOf(company.id)) {
          if (agent.heartbeat_s <= 0 || agent.state !== 'active') continue;
          const last = agent.last_run_at ? Date.parse(agent.last_run_at) : 0;
          if (now.getTime() - last < agent.heartbeat_s * 1000) continue;
          const mine = this.store.ticketsOf(company.id).filter((t) => t.assignee_id === agent.id && ACTIVE.has(t.state));
          if (!mine.length) continue;
          tryStart(company, agent, mine[0], 'heartbeat');
        }
      }
    } catch (err) {
      this.log(`tick error: ${(err as Error).stack ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  private launch(company: CompanyRow, agent: AgentRow, ticket: TicketRow | null, reason: string): void {
    const p = this.runOnce(company, agent, ticket, reason)
      .then(() => undefined, (err) => this.log(`run error (${agent.name}): ${(err as Error).stack ?? err}`))
      .finally(() => this.running.delete(agent.id));
    this.running.set(agent.id, p);
  }

  // -- one run -------------------------------------------------------------

  /** Budget left for the company in micro, and whether it just got paused for being out. */
  private remaining(company: CompanyRow): number {
    const spent = this.store.companySpent(company.id);
    return company.budget - spent.tab - spent.model;
  }

  private ownerKey(company: CompanyRow): KeyPair {
    return { publicKey: company.owner_pub, privateKey: company.owner_priv };
  }

  /** The API key a company's claude agents run on: its own sealed key, else the host's, else none. */
  modelKeyFor(company: CompanyRow): string | null {
    if (company.model_key && this.opts.secrets) {
      const k = this.opts.secrets.open(company.model_key, company.id);
      if (k) return k;
      this.log(`company ${company.id}: the sealed model key does not open; was the master key replaced?`);
    }
    return this.opts.hostModelKey ?? null;
  }

  async runOnce(company: CompanyRow, agent: AgentRow, ticket: TicketRow | null, reason: string): Promise<RunRow | null> {
    const now = new Date();
    const remaining = this.remaining(company);
    if (remaining <= 0) {
      this.pauseForBudget(company);
      return null;
    }
    // the mandate ceiling for this run: company remaining, the agent's per-run cap, the ticket's cap
    let ceiling = Math.min(remaining, agent.budget_per_run);
    if (ticket && ticket.budget !== null) {
      const left = ticket.budget - ticket.spent;
      if (left <= 0) {
        this.store.updateTicket(ticket.id, { state: 'blocked' });
        this.store.addEvent({ company_id: company.id, ticket_id: ticket.id, agent_id: null, kind: 'state', body: { from: ticket.state, to: 'blocked', reason: 'ticket budget exhausted' } });
        return null;
      }
      ceiling = Math.min(ceiling, left);
    }
    let mandate: Mandate | null = null;
    if (company.realms.length && ceiling > 0) {
      const owner = this.ownerKey(company);
      mandate = issueMandate(owner, {
        agent: agent.agent_pub,
        budgetUsd: microToUsd(ceiling),
        window: 'total',
        maxPerCallUsd: typeof agent.config.max_per_call === 'string' ? agent.config.max_per_call : undefined,
        allow: company.realms,
        days: 1,
        evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))),
        now,
      });
    }
    const run = this.store.createRun({
      id: randomId(), company_id: company.id, agent_id: agent.id, ticket_id: ticket?.id ?? null, reason, mandate, started_at: now.toISOString(),
    });
    this.store.updateAgent(agent.id, { last_run_at: now.toISOString() });
    if (ticket && ticket.state === 'open') {
      this.store.updateTicket(ticket.id, { state: 'in_progress' });
      this.store.addEvent({ company_id: company.id, ticket_id: ticket.id, agent_id: agent.id, kind: 'state', body: { from: 'open', to: 'in_progress' } });
    }
    this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'run-started', body: { run_id: run.id, reason, ceiling: microToUsd(ceiling), mandate_id: mandate?.id ?? null } });
    this.log(`run ${run.id}: ${agent.name} on ${ticket ? `#${ticket.id}` : 'no ticket'} (${reason}), ceiling ${microToUsd(ceiling)} ${company.currency}`);

    const colleagues = this.store.agentsOf(company.id).filter((a) => a.id !== agent.id && a.state === 'active');
    const thread = ticket ? this.store.events(company.id, { ticketId: ticket.id, limit: 200 }) : [];
    const approvals = ticket ? this.store.approvalsOf(company.id).filter((a) => a.ticket_id === ticket.id && a.state !== 'pending') : [];
    const queue = this.store.ticketsOf(company.id).filter((t) => t.assignee_id === agent.id && ACTIVE.has(t.state) && t.id !== ticket?.id);
    const packet = buildPacket({
      run_id: run.id, reason, company, agent, colleagues, ticket, thread, approvals, mandate,
      remaining: Math.max(0, remaining - ceiling), queue,
    });
    const workDir = join(this.workDir, company.id);
    try { mkdirSync(workDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }

    let text = '';
    let result: AgentResult | null = null;
    let modelCost = 0;
    let error: string | null = null;
    try {
      const out = await runAdapter({
        agent, packet, mandate, currency: company.currency, catalog: company.catalog, workDir,
        agentKey: agent.agent_priv ? { publicKey: agent.agent_pub, privateKey: agent.agent_priv } : null,
        modelKey: agent.adapter === 'claude' ? this.modelKeyFor(company) : null, anthropicUrl: this.opts.anthropicUrl,
        timeoutMs: this.runTimeoutMs, fetch: this.doFetch, log: this.log,
      });
      text = out.text;
      result = out.result;
      modelCost = out.modelCostMicro;
    } catch (err) {
      error = (err as Error).message;
    }

    // what the mandate spent, as the gateways booked it
    let spent = 0;
    const receipts: Array<Receipt & { origin: string }> = [];
    if (mandate) {
      for (const origin of company.gateways) {
        try {
          const r = await this.doFetch(`${origin}/.well-known/tab/mandate/${mandate.id}/spent`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) spent += Number(((await r.json()) as { micro?: number }).micro ?? 0);
        } catch (err) {
          this.log(`spend lookup at ${origin} failed: ${(err as Error).message}`);
        }
        try {
          const r = await this.doFetch(`${origin}/.well-known/tab/receipts?payer=${encodeURIComponent(agent.agent_pub)}&since=${encodeURIComponent(run.started_at)}&limit=200`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) for (const rec of ((await r.json()) as { receipts?: Receipt[] }).receipts ?? []) receipts.push({ ...rec, origin });
        } catch { /* receipts are optional on a gateway */ }
      }
    }

    this.store.tx(() => this.book(company, agent, ticket, run, { text, result, modelCost, spent, error, receipts }));
    this.log(`run ${run.id}: ${error ? `failed (${error})` : result ? result.status : 'no result'}, spent ${microToUsd(spent)}, model ${microToUsd(modelCost)}`);
    return this.store.run(run.id) ?? null;
  }

  /** Apply a finished run to the books: run row, events, ticket state, sub-tickets, requests, mentions, budget flags. */
  private book(
    company: CompanyRow, agent: AgentRow, ticketBefore: TicketRow | null, run: RunRow,
    o: { text: string; result: AgentResult | null; modelCost: number; spent: number; error: string | null; receipts: Array<Receipt & { origin: string }> },
  ): void {
    const now = new Date();
    const ticket = ticketBefore ? this.store.ticket(ticketBefore.id) ?? null : null;
    const ev = (kind: string, body: unknown, ticketId: string | null = ticket?.id ?? null, agentId: string | null = agent.id) =>
      this.store.addEvent({ company_id: company.id, ticket_id: ticketId, agent_id: agentId, kind, body }, now);
    const setState = (t: TicketRow, to: TicketRow['state'], reason?: string) => {
      if (t.state === to) return;
      this.store.updateTicket(t.id, { state: to }, now);
      ev('state', { from: t.state, to, reason }, t.id);
      t.state = to;
    };

    this.store.finishRun(run.id, {
      state: o.error ? 'failed' : 'done', spent: o.spent, model_cost: o.modelCost,
      result: o.result, output: o.text, error: o.error ?? (o.result ? null : 'no structured result in the output'),
    }, now);
    for (const r of o.receipts) {
      this.store.addReceipt({
        id: r.id, company_id: company.id, run_id: run.id, agent_id: agent.id, origin: r.origin, realm: r.realm,
        resource: r.resource, amount: Number(r.amount), currency: r.currency ?? 'USD', at: r.at,
      });
    }
    if (ticket && o.spent) this.store.updateTicket(ticket.id, { addSpent: o.spent }, now);

    const spentLine = o.spent || o.modelCost ? `${microToUsd(o.spent)} ${company.currency} through tab, ${microToUsd(o.modelCost)} model` : '';
    if (o.error) {
      ev('run', { run_id: run.id, status: 'failed', summary: o.error, spent: spentLine });
      if (ticket && ticket.state === 'in_progress') setState(ticket, 'blocked', `run failed: ${o.error.slice(0, 200)}`);
    } else if (!o.result) {
      ev('run', { run_id: run.id, status: 'no result', summary: o.text.slice(0, 1000), spent: spentLine });
      if (ticket && ACTIVE.has(ticket.state)) setState(ticket, 'review', 'the agent returned no structured result');
    } else {
      const r = o.result;
      ev('run', { run_id: run.id, status: r.status, summary: r.summary, spent: spentLine });
      if (r.comment) ev('comment', { text: r.comment });
      if (ticket) {
        const evidence: Evidence[] = (r.evidence ?? []).map((e) => ({ ...e, run_id: run.id, at: now.toISOString() }));
        if (evidence.length) {
          this.store.updateTicket(ticket.id, { evidence: [...ticket.evidence, ...evidence] }, now);
          for (const e of evidence) ev('evidence', { kind: e.kind, value: e.value, run_id: run.id });
        }
        if (r.status === 'done') {
          const handoff = (r.mentions ?? []).map((n) => this.store.agentByName(company.id, n)).filter((a) => a && a.id !== agent.id && a.state === 'active') as AgentRow[];
          if ((evidence.length || ticket.evidence.length) && handoff.length) {
            // done, but handed to a colleague: the ticket waits in review until they report
            setState(ticket, 'review', `handed to ${handoff.map((a) => a.name).join(', ')}`);
          } else if (evidence.length || ticket.evidence.length) {
            setState(ticket, 'done');
            // a finished sub-ticket wakes whoever owns the parent
            if (ticket.parent_id) {
              const parent = this.store.ticket(ticket.parent_id);
              if (parent && parent.assignee_id && ACTIVE.has(parent.state)) this.store.wake(parent.assignee_id, parent.id, `sub-ticket #${ticket.id} done`, now);
            }
          } else {
            setState(ticket, 'review', 'done was claimed without evidence');
          }
        } else if (r.status === 'blocked') {
          setState(ticket, 'blocked', r.summary.slice(0, 200));
        } else {
          setState(ticket, 'in_progress');
        }
      }
      for (const nt of r.new_tickets ?? []) {
        if (this.store.ticketCount(company.id) >= company.max_tickets) {
          ev('ticket-refused', { title: nt.title, reason: `company is at its ${company.max_tickets} ticket limit` });
          break;
        }
        const assignee = nt.assignee ? this.store.agentByName(company.id, nt.assignee) : undefined;
        let budget: number | null = null;
        if (nt.budget) { try { budget = usdToMicro(nt.budget); } catch { /* unparseable: no cap */ } }
        const created = this.store.createTicket({
          company_id: company.id, title: nt.title, body: nt.body ?? '', state: 'open',
          assignee_id: assignee && assignee.state === 'active' ? assignee.id : null, created_by: agent.id,
          parent_id: ticket?.id ?? null, budget,
        }, now);
        ev('ticket', { ticket_id: created.id, title: created.title, assignee: assignee?.name ?? null, parent_id: ticket?.id ?? null }, created.id);
        if (created.assignee_id) this.store.wake(created.assignee_id, created.id, `assigned by ${agent.name}`, now);
      }
      for (const req of r.requests ?? []) {
        const a = this.store.createApproval({
          company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: req.kind,
          payload: { amount: req.amount ?? null, reason: req.reason ?? '' },
        }, now);
        ev('request', { approval_id: a.id, kind: req.kind, amount: req.amount ?? null, reason: req.reason ?? '' });
      }
      for (const name of r.mentions ?? []) {
        const other = this.store.agentByName(company.id, name);
        if (other && other.id !== agent.id && other.state === 'active') this.store.wake(other.id, ticket?.id ?? null, `${r.status === 'done' ? 'handed over' : 'mentioned'} by ${agent.name}`, now);
      }
    }

    // the company budget: warn at 80 percent, pause at 100
    const fresh = this.store.company(company.id)!;
    const total = (() => { const s = this.store.companySpent(company.id); return s.tab + s.model; })();
    if (total >= fresh.budget) {
      this.pauseForBudget(fresh, now);
    } else if (!fresh.warned && total >= fresh.budget * 0.8) {
      this.store.updateCompany(company.id, { warned: true });
      ev('budget-warning', { spent: microToUsd(total), budget: microToUsd(fresh.budget), percent: Math.floor((total / fresh.budget) * 100) }, null, null);
    }
  }

  private pauseForBudget(company: CompanyRow, now = new Date()): void {
    if (company.state === 'paused') return;
    this.store.updateCompany(company.id, { state: 'paused' });
    const s = this.store.companySpent(company.id);
    this.store.addEvent({
      company_id: company.id, ticket_id: null, agent_id: null, kind: 'paused',
      body: { reason: 'budget exhausted', spent: microToUsd(s.tab + s.model), budget: microToUsd(company.budget) },
    }, now);
    this.log(`company ${company.name} paused: budget exhausted`);
  }

  // -- hooks the server calls ----------------------------------------------

  /** An owner comment: wake every @mentioned agent, and the assignee if nobody was named. */
  commentWakes(company: CompanyRow, ticket: TicketRow, text: string, by: string | null): void {
    const named = new Set<string>();
    for (const m of text.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const a = this.store.agentByName(company.id, m[1]);
      if (a && a.state === 'active' && a.id !== by) { this.store.wake(a.id, ticket.id, by ? 'mentioned' : 'mentioned by owner'); named.add(a.id); }
    }
    if (!named.size && ticket.assignee_id && ticket.assignee_id !== by && ACTIVE.has(ticket.state)) {
      this.store.wake(ticket.assignee_id, ticket.id, by ? 'comment' : 'owner comment');
    }
  }
}
