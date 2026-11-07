// The engine: wakes agents on assignment, mention or heartbeat, issues one
// mandate per run from the company owner key, runs the adapter, then asks the
// gateways what the mandate actually spent and books it against the run, the
// ticket and the company. Warns at 80 percent of the company budget, pauses at
// 100. A ticket is done only when the agent attached evidence.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { microToUsd, normalizeUsd, randomId, usdToMicro, verifyReceipt, type Receipt } from '../protocol.js';
import { issueMandate, delegateMandate, mandateExpired, type Mandate, type MandateHours } from '../mandate.js';

/** 3.2: an agent's spending rules from its config, for the mandates it runs on. */
function rulesOf(config: Record<string, unknown>): { paths?: string[]; hours?: MandateHours } {
  return {
    ...(Array.isArray(config.paths) && config.paths.length ? { paths: config.paths.map(String) } : {}),
    ...(config.hours && typeof config.hours === 'object' ? { hours: config.hours as MandateHours } : {}),
  };
}
import type { ApprovalRequest } from '../approval.js';
import type { HeldChannel, EscrowTicket } from '../client.js';
import type { TabHooks } from '../tools.js';
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
  maxRunsPerCompanyHour?: number; // default 30; past it the company pauses for the owner
  fetch?: typeof fetch;
}

const ACTIVE: ReadonlySet<string> = new Set(['open', 'in_progress']);
// a ticket in review can still be worked by the colleague it was handed to
const WAKEABLE: ReadonlySet<string> = new Set(['open', 'in_progress', 'review']);
// runs on one ticket in an hour before it is blocked for the owner to look at
const MAX_RUNS_PER_TICKET_HOUR = 12;
// a team that keeps waking itself (new sub-tasks, hand-offs, mentions) would run on the owner's model key all day
const MAX_RUNS_PER_COMPANY_HOUR = 30;
const START_RETRY_MS = 60_000;

export class Engine {
  private store: CompanyStore;
  private log: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private running = new Map<string, Promise<void>>(); // agent id -> the run in flight
  private failed = new Map<string, { error: string; at: number }>(); // agent id -> why its last run could not start, and when
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
        // a run that could not start waits a minute before the next try, not one tick
        const f = this.failed.get(agent.id);
        if (f && now.getTime() - f.at < START_RETRY_MS) return false;
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
      .then(() => { this.failed.delete(agent.id); }, (err) => {
        const error = (err as Error).message ?? String(err);
        this.log(`run error (${agent.name}): ${(err as Error).stack ?? err}`);
        // tell the owner once per distinct reason, on the task it was for, instead of failing silently every tick
        if (this.failed.get(agent.id)?.error !== error) this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'run-failed', body: { agent: agent.name, error } });
        this.failed.set(agent.id, { error, at: Date.now() });
      })
      .finally(() => this.running.delete(agent.id));
    this.running.set(agent.id, p);
  }

  // -- one run -------------------------------------------------------------

  /** Budget left for the company in micro, and whether it just got paused for being out. */
  private remaining(company: CompanyRow): number {
    const spent = this.store.companySpent(company.id);
    // runs in flight have not booked yet: their mandates' ceilings are spoken for
    const reserved = this.store.runningRuns(company.id).reduce((n, r) => n + (r.mandate ? Number(r.mandate.budget) : 0), 0);
    return company.budget - spent.tab - spent.model - reserved;
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
    const cap = this.opts.maxRunsPerCompanyHour ?? MAX_RUNS_PER_COMPANY_HOUR;
    if (this.store.runsOfCompanySince(company.id, new Date(now.getTime() - 3_600_000).toISOString()) >= cap) {
      this.pause(company, `${cap} runs in the last hour; look at the work, then resume`, now);
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
    // two agents that keep handing a ticket back and forth would run forever on the owner's model key, budget or not
    if (ticket && this.store.runsOnTicketSince(ticket.id, new Date(now.getTime() - 3_600_000).toISOString()) >= MAX_RUNS_PER_TICKET_HOUR) {
      this.store.updateTicket(ticket.id, { state: 'blocked' });
      this.store.addEvent({ company_id: company.id, ticket_id: ticket.id, agent_id: null, kind: 'state', body: { from: ticket.state, to: 'blocked', reason: `${MAX_RUNS_PER_TICKET_HOUR} runs on this ticket in the last hour; the owner should look at it` } });
      return null;
    }
    let mandate: Mandate | null = null;
    let delegatedBy: AgentRow | null = null;
    if (company.realms.length && ceiling > 0) {
      const owner = this.ownerKey(company);
      // a sub-ticket runs on a slice of its manager's delegated budget, signed by the manager
      const d = ticket?.parent_id ? this.delegatedMandate(company, agent, ticket, ceiling, now) : null;
      if (d === 'revoked') {
        this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'run-failed', body: { agent: agent.name, error: 'the owner revoked the budget delegated for this ticket; this run gets no mandate' } }, now);
      } else if (d) {
        mandate = d.mandate;
        delegatedBy = d.manager;
      } else {
        mandate = issueMandate(owner, {
          agent: agent.agent_pub,
          budgetUsd: microToUsd(ceiling),
          window: 'total',
          maxPerCallUsd: cfgUsd(agent.config.max_per_call),
          approveAboveUsd: cfgUsd(agent.config.approve_above),
          ...rulesOf(agent.config),
          allow: company.realms,
          expiresInMs: this.runTimeoutMs + 60_000,
          evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))),
          now,
        });
      }
    }
    const run = this.store.createRun({
      id: randomId(), company_id: company.id, agent_id: agent.id, ticket_id: ticket?.id ?? null, reason, mandate, started_at: now.toISOString(),
    });
    this.store.updateAgent(agent.id, { last_run_at: now.toISOString() });
    if (ticket && ticket.state === 'open') {
      this.store.updateTicket(ticket.id, { state: 'in_progress' });
      this.store.addEvent({ company_id: company.id, ticket_id: ticket.id, agent_id: agent.id, kind: 'state', body: { from: 'open', to: 'in_progress' } });
    }
    this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'run-started', body: { run_id: run.id, reason, ceiling: microToUsd(ceiling), mandate_id: mandate?.id ?? null, ...(delegatedBy ? { delegated_by: delegatedBy.name, parent_mandate: mandate?.parent?.id } : {}) } });
    this.log(`run ${run.id}: ${agent.name} on ${ticket ? `#${ticket.id}` : 'no ticket'} (${reason}), ceiling ${microToUsd(ceiling)} ${company.currency}`);

    const colleagues = this.store.agentsOf(company.id).filter((a) => a.id !== agent.id && a.state === 'active');
    const thread = ticket ? this.store.events(company.id, { ticketId: ticket.id, limit: 200 }) : [];
    const approvals = ticket ? this.store.approvalsOf(company.id).filter((a) => a.ticket_id === ticket.id && a.state !== 'pending') : [];
    const all = this.store.ticketsOf(company.id);
    const queue = all.filter((t) => t.assignee_id === agent.id && ACTIVE.has(t.state) && t.id !== ticket?.id);
    // the parent sees what its sub-tasks reported; without it, it waits for work it cannot read
    const subtasks = ticket ? all.filter((t) => t.parent_id === ticket.id).map((t) => ({ ticket: t, assignee: t.assignee_id ? (this.store.agent(t.assignee_id)?.name ?? '?') : 'nobody', report: this.reportOf(company.id, t) })) : [];
    const parent = ticket?.parent_id ? this.store.ticket(ticket.parent_id) : null;
    const spentNow = this.store.companySpent(company.id);
    const sales = await this.earnings(company);
    const books = { spent_tab: spentNow.tab, spent_model: spentNow.model, budget: company.budget, earned: sales?.earned ?? null, orders: sales?.orders ?? null, gateway: company.sell_gateway };
    const packet = buildPacket({
      run_id: run.id, reason, company, agent, colleagues, ticket, thread, approvals, mandate,
      remaining: Math.max(0, remaining - ceiling), queue, parent, subtasks, books,
    });
    const workDir = join(this.workDir, company.id);
    try { mkdirSync(workDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }

    let text = '';
    let result: AgentResult | null = null;
    let modelCost = 0;
    let error: string | null = null;
    const channelsFile = this.writeChannels(company, agent, workDir);
    const tabHooks: TabHooks = {
      onApprovalRequired: (req, origin, url) => this.paymentApproval(company, agent, ticket, run.id, req, origin, url),
      onEscrow: (t, url) => this.recordOrder(company, agent, run.id, t, url),
      onDelegate: (child) => { this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'delegate', body: { mandate_id: child.id, parent: child.parent?.id ?? null, to: child.agent, budget: microToUsd(Number(child.budget)) } }); },
      channels: { file: channelsFile },
    };
    try {
      const out = await runAdapter({
        agent, packet, mandate, currency: company.currency, catalog: company.catalog, workDir,
        agentKey: agent.agent_priv ? { publicKey: agent.agent_pub, privateKey: agent.agent_priv } : null,
        modelKey: agent.adapter === 'claude' ? this.modelKeyFor(company) : null, anthropicUrl: this.opts.anthropicUrl,
        timeoutMs: this.runTimeoutMs, maxModelCostMicro: Math.max(0, remaining), fetch: this.doFetch, log: this.log, tabHooks,
      });
      text = out.text;
      result = out.result;
      modelCost = out.modelCostMicro;
    } catch (err) {
      error = (err as Error).message;
    }

    this.readChannels(company, channelsFile);
    // what the mandate spent, as the gateways booked it
    let spent = 0;
    const receipts: Array<Receipt & { origin: string; verified: boolean }> = [];
    if (mandate) {
      for (const origin of company.gateways) {
        // the key this gateway signs receipts with; a receipt only counts as verified against it
        let key: string | null = null;
        try {
          const d = await this.doFetch(`${origin}/.well-known/tab`, { signal: AbortSignal.timeout(10_000) });
          if (d.ok) { const k = ((await d.json()) as { receipt_key?: unknown }).receipt_key; if (typeof k === 'string') key = k; }
        } catch { /* unverified then */ }
        try {
          const r = await this.doFetch(`${origin}/.well-known/tab/mandate/${mandate.id}/spent`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) spent += bookable(((await r.json()) as { micro?: unknown }).micro, Number(mandate.budget));
        } catch (err) {
          this.log(`spend lookup at ${origin} failed: ${(err as Error).message}`);
        }
        try {
          const r = await this.doFetch(`${origin}/.well-known/tab/receipts?payer=${encodeURIComponent(agent.agent_pub)}&since=${encodeURIComponent(run.started_at)}&limit=200`, { signal: AbortSignal.timeout(10_000) });
          const channelMandates = new Set(this.store.channelsOf(company.id, { agentId: agent.id }).map((c) => c.mandate.id));
          if (r.ok) for (const rec of ((await r.json()) as { receipts?: Receipt[] }).receipts ?? []) {
            if (!wellFormedReceipt(rec)) continue;
            // a call paid from a channel is under the channel's mandate; its spend is booked on the channel
            const under = rec.channel && rec.mandate && channelMandates.has(rec.mandate) ? rec.mandate : mandate.id;
            receipts.push({ ...rec, origin, verified: verifyReceipt(rec, { key, mandate: under }).ok });
          }
        } catch { /* receipts are optional on a gateway */ }
      }
    }

    this.store.tx(() => this.book(company, agent, ticket, run, { text, result, modelCost, spent, error, receipts }));
    if (mandate) this.reconcileLater(company, run.id, ticket?.id ?? null, mandate, spent);
    this.log(`run ${run.id}: ${error ? `failed (${error})` : result ? result.status : 'no result'}, spent ${microToUsd(spent)}, model ${microToUsd(modelCost)}`);
    return this.store.run(run.id) ?? null;
  }

  // -- 3.0 ------------------------------------------------------------------

  /**
   * The mandate for a sub-ticket's run: the owner gives the parent ticket's assignee (the manager)
   * one mandate for all of that ticket's sub-tickets, and the manager's key delegates a slice of it
   * to each sub-ticket run. Spend under every slice counts against the manager's mandate at the
   * gateways, and revoking it stops them all. Null when no manager can delegate (then the run gets an
   * owner mandate as before), 'revoked' when the owner revoked the delegation.
   */
  private delegatedMandate(company: CompanyRow, agent: AgentRow, ticket: TicketRow, ceiling: number, now: Date): { mandate: Mandate; manager: AgentRow } | 'revoked' | null {
    const parent = this.store.ticket(ticket.parent_id!);
    const manager = parent?.assignee_id ? this.store.agent(parent.assignee_id) : undefined;
    if (!parent || !manager || manager.id === agent.id || manager.state !== 'active' || !manager.agent_priv) return null;
    const revoked = new Set(this.store.revocationsOf(company.id).map((r) => r.mandate_id));
    let d = this.store.delegation(parent.id);
    if (d && revoked.has(d.mandate.id)) return 'revoked';
    const owner = this.ownerKey(company);
    // a fresh one when there is none, it is about to lapse, or the ticket changed hands
    if (!d || d.agent_id !== manager.id || mandateExpired(d.mandate, new Date(now.getTime() + this.runTimeoutMs + 120_000))) {
      const budget = parent.budget !== null ? parent.budget : manager.budget_per_run;
      if (budget <= 0) return null;
      const m = issueMandate(owner, {
        agent: manager.agent_pub, budgetUsd: microToUsd(budget), window: 'total',
        maxPerCallUsd: cfgUsd(manager.config.max_per_call), approveAboveUsd: cfgUsd(manager.config.approve_above), ...rulesOf(manager.config),
        allow: company.realms, expiresInMs: 86_400_000, evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))), now,
      });
      d = { ticket_id: parent.id, company_id: company.id, agent_id: manager.id, mandate: m, created_at: now.toISOString() };
      this.store.putDelegation(d);
      this.store.addEvent({ company_id: company.id, ticket_id: parent.id, agent_id: manager.id, kind: 'delegation', body: { ticket_id: parent.id, manager: manager.name, budget: microToUsd(budget), mandate_id: m.id } }, now);
    }
    const parentCap = d.mandate.max_per_call === null ? null : Number(d.mandate.max_per_call);
    const ownCap = cfgUsd(agent.config.max_per_call) ? usdToMicro(cfgUsd(agent.config.max_per_call)!) : null;
    const cap = parentCap === null ? ownCap : ownCap === null ? parentCap : Math.min(parentCap, ownCap);
    const parentGate = d.mandate.approve_above === undefined ? null : Number(d.mandate.approve_above);
    const ownGate = cfgUsd(agent.config.approve_above) ? usdToMicro(cfgUsd(agent.config.approve_above)!) : null;
    const gate = parentGate === null ? ownGate : ownGate === null ? parentGate : Math.min(parentGate, ownGate);
    try {
      const child = delegateMandate({ publicKey: manager.agent_pub, privateKey: manager.agent_priv }, d.mandate, {
        agent: agent.agent_pub, budgetUsd: microToUsd(Math.min(ceiling, Number(d.mandate.budget))),
        maxPerCallUsd: cap === null ? undefined : microToUsd(cap), approveAboveUsd: gate === null ? undefined : microToUsd(gate),
        ...rulesOf(agent.config),
        expiresInMs: this.runTimeoutMs + 60_000, now,
      });
      return { mandate: child, manager };
    } catch (err) {
      this.log(`delegation for #${ticket.id} failed, using an owner mandate: ${(err as Error).message}`);
      return null;
    }
  }

  /** A payment above the approval threshold: put it in front of the owner, once per request. */
  private paymentApproval(company: CompanyRow, agent: AgentRow, ticket: TicketRow | null, runId: string, req: ApprovalRequest, origin: string, url: string): void {
    const pending = this.store.approvalsOf(company.id).some((a) => a.kind === 'payment' && a.state === 'pending' && (a.payload.request as ApprovalRequest | undefined)?.id === req.id);
    if (pending) return;
    const amount = microToUsd(Number(req.amount));
    const [method] = req.resource.split(' ');
    const reason = `pay ${amount} ${req.currency} for ${req.resource} at ${req.realm}`;
    const a = this.store.createApproval({
      company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'payment',
      payload: { request: req, origin, url, method, resource: req.resource, realm: req.realm, amount, currency: req.currency, run_id: runId, reason },
    });
    this.store.addEvent({ company_id: company.id, ticket_id: ticket?.id ?? null, agent_id: agent.id, kind: 'request', body: { approval_id: a.id, kind: 'payment', amount, reason } });
    this.log(`company ${company.name}: ${agent.name} waits for approval to ${reason}`);
  }

  /** A pay-on-delivery order an agent placed. */
  private recordOrder(company: CompanyRow, agent: AgentRow, runId: string, t: EscrowTicket, url: string): void {
    const at = new Date().toISOString();
    let origin = '';
    try { origin = new URL(t.status).origin; } catch { return; }
    // an order is real only at one of the company's gateways and for a call made there; anything else is a page's say-so
    if (!company.gateways.includes(origin)) return;
    try { if (new URL(url).origin !== origin) return; } catch { return; }
    const amount = 0; // filled in from the gateway's status at the first refresh
    this.store.addOrder({ id: t.id, company_id: company.id, run_id: runId, agent_id: agent.id, origin, url, status_url: t.status, token: t.token, amount, currency: company.currency, state: t.state, deadline: t.deadline, receipt: null, refund_ref: null, reason: null, created_at: at, updated_at: at });
    this.store.addEvent({ company_id: company.id, ticket_id: null, agent_id: agent.id, kind: 'order', body: { order: t.id, url, state: t.state, deadline: t.deadline } });
  }

  /** The agent's open channels, as a channel book its tab client pays from. */
  private writeChannels(company: CompanyRow, agent: AgentRow, workDir: string): string {
    const file = join(workDir, `channels-${agent.id}.json`);
    const book: Record<string, HeldChannel> = {};
    for (const c of this.store.channelsOf(company.id, { agentId: agent.id, open: true })) {
      if (Date.parse(c.expires_at) <= Date.now()) continue;
      book[c.origin] = {
        id: c.id, origin: c.origin, realm: '', agent: agent.agent_pub, owner: company.owner_pub, mandate: c.mandate.id, currency: c.currency,
        deposit: String(c.deposit), authorized: String(c.spent), spent: String(c.spent), held: '0', calls: c.calls, state: 'open', opened_at: c.opened_at, expires_at: c.expires_at,
      };
    }
    try { writeFileSync(file, JSON.stringify(book), { mode: 0o600 }); } catch { /* the run pays per call */ }
    return file;
  }

  /** What the run spent from its channels, back into the books. */
  private readChannels(company: CompanyRow, file: string): void {
    if (!existsSync(file)) return;
    try {
      const book = JSON.parse(readFileSync(file, 'utf8')) as Record<string, HeldChannel>;
      for (const h of Object.values(book)) {
        const c = this.store.channel(company.id, h.id);
        if (c && c.state === 'open' && Number(h.spent) >= c.spent) this.store.updateChannel(company.id, c.id, { spent: Number(h.spent), calls: Number(h.calls) });
      }
    } catch { /* keep the last known */ }
  }

  /**
   * The mandate outlives the run by a minute, and an http agent holds its own key: anything it
   * spends after the run was booked is read once the mandate has expired and booked as late spend.
   */
  private reconcileLater(company: CompanyRow, runId: string, ticketId: string | null, mandate: Mandate, booked: number): void {
    const wait = Math.max(0, Date.parse(mandate.expires_at) - Date.now()) + 5_000;
    const t = setTimeout(async () => {
      let total = 0;
      for (const origin of company.gateways) {
        try {
          const r = await this.doFetch(`${origin}/.well-known/tab/mandate/${mandate.id}/spent`, { signal: AbortSignal.timeout(10_000) });
          if (r.ok) total += bookable(((await r.json()) as { micro?: unknown }).micro, Number(mandate.budget));
        } catch { /* the next look is the owner's */ }
      }
      const late = Math.min(total, Number(mandate.budget)) - booked;
      if (late <= 0) return;
      this.store.tx(() => {
        this.store.addRunSpend(runId, late);
        if (ticketId) this.store.updateTicket(ticketId, { addSpent: late });
        this.store.addEvent({ company_id: company.id, ticket_id: ticketId, agent_id: null, kind: 'late-spend', body: { run_id: runId, spent: microToUsd(late), mandate_id: mandate.id } });
      });
      this.log(`run ${runId}: ${microToUsd(late)} spent after the run, booked late`);
      const c = this.store.company(company.id);
      if (c && this.remaining(c) <= 0) this.pauseForBudget(c);
    }, wait);
    t.unref();
  }

  /** Apply a finished run to the books: run row, events, ticket state, sub-tickets, requests, mentions, budget flags. */
  private book(
    company: CompanyRow, agent: AgentRow, ticketBefore: TicketRow | null, run: RunRow,
    o: { text: string; result: AgentResult | null; modelCost: number; spent: number; error: string | null; receipts: Array<Receipt & { origin: string; verified: boolean }> },
  ): void {
    const now = new Date();
    const ticket = ticketBefore ? this.store.ticket(ticketBefore.id) ?? null : null;
    const ev = (kind: string, body: unknown, ticketId: string | null = ticket?.id ?? null, agentId: string | null = agent.id) =>
      this.store.addEvent({ company_id: company.id, ticket_id: ticketId, agent_id: agentId, kind, body }, now);
    const setState = (t: TicketRow, to: TicketRow['state'], reason?: string) => {
      // a ticket closed or cancelled while the run was going stays that way: a late result does not reopen it
      if (t.state === to || t.state === 'done' || t.state === 'cancelled') return;
      this.store.updateTicket(t.id, { state: to }, now);
      ev('state', { from: t.state, to, reason }, t.id);
      t.state = to;
    };
    // a sub-task that comes back (done, handed over, blocked) wakes whoever owns the parent
    const wakeParent = (how: string) => {
      if (!ticket?.parent_id) return;
      const parent = this.store.ticket(ticket.parent_id);
      if (parent && parent.assignee_id && ACTIVE.has(parent.state)) this.store.wake(parent.assignee_id, parent.id, `sub-ticket #${ticket.id} ${how}`, now);
    };

    this.store.finishRun(run.id, {
      state: o.error ? 'failed' : 'done', spent: o.spent, model_cost: o.modelCost,
      result: o.result, output: o.text, error: o.error ?? (o.result ? null : 'no structured result in the output'),
    }, now);
    for (const r of o.receipts) {
      this.store.addReceipt({
        id: r.id, company_id: company.id, run_id: run.id, agent_id: agent.id, origin: r.origin, realm: r.realm,
        resource: r.resource, amount: Number(r.amount), currency: r.currency ?? 'USD', at: r.at,
        verified: r.verified, doc: r.sig ? { ...r, origin: undefined, verified: undefined } as Receipt : null,
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
      // a ticket is handed over once: the colleague who finishes a handed-over ticket closes it
      const handedOver = ticket?.state === 'review';
      // only the assignee moves its ticket (or a colleague closing a handover); a colleague woken by a mention adds evidence and comments only
      const owns = !!ticket && (ticket.assignee_id === null || ticket.assignee_id === agent.id || (handedOver && r.status === 'done'));
      // a payment the owner approved while this run was still going: the ticket stays open so the approval's wake runs
      const approvedMeanwhile = !!ticket && this.store.approvalsOf(company.id).some((a) => a.kind === 'payment' && a.state === 'approved' && a.agent_id === agent.id
        && a.ticket_id === ticket.id && a.decided_at !== null && a.decided_at >= run.started_at);
      if (ticket && !owns && ticket.state !== 'done' && ticket.state !== 'cancelled') {
        const evidence: Evidence[] = (r.evidence ?? []).map((e) => ({ ...e, run_id: run.id, at: now.toISOString() }));
        if (evidence.length) {
          this.store.updateTicket(ticket.id, { evidence: [...ticket.evidence, ...evidence] }, now);
          for (const e of evidence) ev('evidence', { kind: e.kind, value: e.value, run_id: run.id });
        }
      }
      if (ticket && owns) {
        const evidence: Evidence[] = (r.evidence ?? []).map((e) => ({ ...e, run_id: run.id, at: now.toISOString() }));
        if (evidence.length) {
          this.store.updateTicket(ticket.id, { evidence: [...ticket.evidence, ...evidence] }, now);
          for (const e of evidence) ev('evidence', { kind: e.kind, value: e.value, run_id: run.id });
        }
        if (r.status === 'done') {
          const handoff = (r.mentions ?? []).map((n) => this.store.agentByName(company.id, n)).filter((a) => a && a.id !== agent.id && a.state === 'active') as AgentRow[];
          if ((evidence.length || ticket.evidence.length) && handoff.length && !handedOver) {
            // done, but handed to a colleague: the ticket waits in review until they report
            setState(ticket, 'review', `handed to ${handoff.map((a) => a.name).join(', ')}`);
            wakeParent('done');
          } else if (evidence.length || ticket.evidence.length) {
            setState(ticket, 'done');
            wakeParent('done');
          } else {
            setState(ticket, 'review', 'done was claimed without evidence');
          }
        } else if (r.status === 'blocked' && approvedMeanwhile) {
          setState(ticket, 'in_progress', 'payment approved during the run');
          this.store.wake(agent.id, ticket.id, 'payment approved: make the same call again', now);
        } else if (r.status === 'blocked') {
          setState(ticket, 'blocked', r.summary.slice(0, 200));
          wakeParent('blocked');
        } else {
          setState(ticket, 'in_progress');
        }
      }
      for (const nt of r.new_tickets ?? []) {
        if (ticket?.parent_id) {
          ev('ticket-refused', { title: nt.title, reason: 'a sub-task reports back instead of opening sub-tasks' }, ticket.id);
          continue;
        }
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
          payload: { amount: req.amount ?? null, reason: req.reason ?? '', ...(req.kind === 'hire' ? { name: req.name ?? null, role: req.role ?? null, instructions: req.instructions ?? null, ...hireTerms(req, agent) } : {}) },
        }, now);
        ev('request', { approval_id: a.id, kind: req.kind, amount: req.amount ?? null, reason: req.reason ?? '', ...(req.kind === 'hire' && req.name ? { name: req.name, role: req.role ?? null, ...hireTerms(req, agent) } : {}) });
      }
      for (const name of r.mentions ?? []) {
        if (r.status === 'done' && ticket?.state === 'done') break; // closed: a mention is a note, not a wake
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

  /** What the company has earned at the gateway it sells through: the receipts paid to its owner key. Cached for a minute. */
  private sales = new Map<string, { at: number; v: { earned: number; orders: number } | null }>();
  private async earnings(company: CompanyRow): Promise<{ earned: number; orders: number } | null> {
    if (!company.sell_gateway) return null;
    const hit = this.sales.get(company.id);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    let v: { earned: number; orders: number } | null = null;
    try {
      const r = await (this.opts.fetch ?? fetch)(`${company.sell_gateway}/.well-known/tab/receipts?limit=200`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) {
        const mine = (((await r.json()) as { receipts?: Array<{ recipient: string; amount: string }> }).receipts ?? []).filter((x) => x.recipient === company.owner_pub);
        v = { earned: mine.reduce((n, x) => n + Number(x.amount), 0), orders: mine.length };
      }
    } catch { /* unreachable: the books say so */ }
    this.sales.set(company.id, { at: Date.now(), v });
    return v;
  }

  /** What a ticket's assignee last reported on it: the run summary, the comment, and the evidence. */
  private reportOf(companyId: string, t: TicketRow): string {
    const evs = this.store.events(companyId, { ticketId: t.id, limit: 200 });
    const run = [...evs].reverse().find((e) => e.kind === 'run' && e.agent_id === t.assignee_id);
    const comment = [...evs].reverse().find((e) => e.kind === 'comment' && e.agent_id === t.assignee_id);
    const b = (run?.body ?? {}) as Record<string, unknown>;
    const parts = [String(b.summary ?? ''), comment ? String(((comment.body ?? {}) as Record<string, unknown>).text ?? '') : '', t.evidence.length ? `Evidence: ${t.evidence.map((e) => `${e.kind} ${e.value}`).join('; ')}` : ''];
    return parts.filter(Boolean).join('\n').slice(0, 6000);
  }

  private pause(company: CompanyRow, reason: string, now = new Date()): void {
    if (company.state === 'paused') return;
    this.store.updateCompany(company.id, { state: 'paused' });
    this.store.addEvent({ company_id: company.id, ticket_id: null, agent_id: null, kind: 'paused', body: { reason } }, now);
    this.log(`company ${company.name} paused: ${reason}`);
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

/**
 * The model and per call cap a hire request names, checked like the configure action: a Claude model
 * id, and a cap in canonical form no higher than the requester's own (the owner may raise it when
 * approving). What does not check out is left out and the hire falls back to the defaults.
 */
export function hireTerms(req: { model?: string; max_per_call?: string }, requester: AgentRow): { model?: string; max_per_call?: string; note?: string } {
  const out: { model?: string; max_per_call?: string; note?: string } = {};
  if (req.model && /^claude-[a-z0-9.-]+$/.test(req.model)) out.model = req.model;
  if (req.max_per_call) {
    let micro: number | null = null;
    try { micro = usdToMicro(normalizeUsd(req.max_per_call)); } catch { /* left out */ }
    const own = cfgUsd(requester.config.max_per_call);
    if (micro !== null) {
      if (own && micro > usdToMicro(own)) { out.max_per_call = microToUsd(usdToMicro(own)); out.note = `per call cap lowered to ${out.max_per_call}, the requester's own`; }
      else out.max_per_call = microToUsd(micro);
    }
  }
  return out;
}

/** An amount from an agent's config ("0.05"), normalized; undefined when unset. */
function cfgUsd(v: unknown): string | undefined {
  return typeof v === 'string' && v ? normalizeUsd(v) : undefined;
}

/** A spend figure from a gateway, as something safe to book: a whole number between 0 and the mandate budget. */
function bookable(micro: unknown, ceiling: number): number {
  const n = Number(micro);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, ceiling) : 0;
}

/** Receipts come from gateways the owner named; one malformed one must not abort booking the run. */
function wellFormedReceipt(r: Receipt): boolean {
  return !!r && typeof r.id === 'string' && r.id.length <= 64 && typeof r.realm === 'string' && typeof r.resource === 'string'
    && Number.isSafeInteger(Number(r.amount)) && Number(r.amount) >= 0 && typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at))
    && (r.currency === undefined || typeof r.currency === 'string');
}
