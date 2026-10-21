// The work packet: what an agent gets for one run (mission, role, colleagues,
// the ticket and its thread, the budget and the mandate that enforces it) and
// the output contract it must answer with. The same packet goes to every
// adapter; the claude adapter sends the prose, the http adapter the JSON.

import { microToUsd } from '../protocol.js';
import type { Mandate } from '../mandate.js';
import type { AgentRow, ApprovalRow, CompanyRow, EventRow, Evidence, TicketRow } from './store.js';

export const PACKET_VERSION = 'tab-company/0';

export interface AgentResult {
  status: 'done' | 'in_progress' | 'blocked';
  summary: string;
  evidence?: Evidence[];
  comment?: string;
  new_tickets?: Array<{ title: string; body?: string; assignee?: string; budget?: string }>;
  requests?: Array<{ kind: string; amount?: string; reason?: string }>;
  mentions?: string[];
}

export interface PacketInput {
  run_id: string;
  reason: string;
  company: CompanyRow;
  agent: AgentRow;
  colleagues: AgentRow[];
  ticket: TicketRow | null;
  thread: EventRow[];
  approvals: ApprovalRow[]; // decided approvals on this ticket, newest first
  mandate: Mandate | null;
  remaining: number; // micro the company may still spend after this run's ceiling
  queue: TicketRow[]; // other open tickets assigned to this agent
}

export interface Packet {
  prompt: string;
  json: Record<string, unknown>;
}

export const CONTRACT = {
  status: 'done | in_progress | blocked',
  summary: 'one paragraph: what you did and what you found',
  evidence: [{ kind: 'receipt | url | file | text', value: 'a receipt id, a URL, a file path you wrote, or the literal output' }],
  comment: 'optional longer note for the ticket thread',
  new_tickets: [{ title: '...', body: '...', assignee: 'colleague name', budget: '0.50' }],
  requests: [{ kind: 'budget | hire | other', amount: '5.00', reason: '...' }],
  mentions: ['colleague name to wake on this ticket'],
};

function nameOf(agents: AgentRow[], id: string | null): string {
  if (id === null) return 'owner';
  return agents.find((a) => a.id === id)?.name ?? id;
}

function renderThread(thread: EventRow[], agents: AgentRow[]): string {
  const lines: string[] = [];
  for (const e of thread) {
    const who = nameOf(agents, e.agent_id);
    const b = (e.body ?? {}) as Record<string, unknown>;
    if (e.kind === 'comment') lines.push(`[${e.at}] ${who}: ${String(b.text ?? '')}`);
    else if (e.kind === 'state') lines.push(`[${e.at}] ${who} set state ${String(b.from ?? '?')} -> ${String(b.to ?? '?')}${b.reason ? ` (${String(b.reason)})` : ''}`);
    else if (e.kind === 'run') lines.push(`[${e.at}] run by ${who}: ${String(b.status ?? '')}; ${String(b.summary ?? '')}${b.spent ? `; spent ${String(b.spent)}` : ''}`);
    else if (e.kind === 'approval') lines.push(`[${e.at}] owner ${String(b.decision ?? '')} the ${String(b.kind ?? '')} request${b.amount ? ` for ${String(b.amount)}` : ''}`);
    else if (e.kind === 'evidence') lines.push(`[${e.at}] ${who} attached ${String(b.kind ?? '')}: ${String(b.value ?? '')}`);
  }
  return lines.length ? lines.join('\n') : '(no activity yet)';
}

export function buildPacket(input: PacketInput): Packet {
  const { company, agent, colleagues, ticket, mandate } = input;
  const cur = company.currency;
  const everyone = [agent, ...colleagues];
  const budgetLine = mandate
    ? `${microToUsd(Number(mandate.budget))} ${cur} through tab for this run (mandate ${mandate.id}, valid at ${mandate.allow.join(', ')}, until ${mandate.expires_at})`
    : `nothing: the company has no gateway to spend at, so this run costs only what the model costs`;

  const spendHow = agent.adapter === 'claude' || agent.adapter === 'claude-code'
    ? 'Spend through the tab tools: tab_search finds priced routes in the catalog, tab_fetch pays for one call and returns a receipt. tab_limits shows what this run may spend.'
    : 'The mandate is in the packet JSON under budget.mandate; pay with any tab client under your own agent key (the mandate names it).';

  const prompt = `You are ${agent.name}, ${agent.role} at ${company.name}.

Mission: ${company.mission}
${agent.instructions ? `\nYour instructions: ${agent.instructions}\n` : ''}
Colleagues: ${colleagues.length ? colleagues.map((c) => `${c.name} (${c.role})`).join(', ') : 'none yet'}. The owner is a person reading the dashboard; address them as @owner.

Budget: ${budgetLine}. Company remaining after this run's ceiling: ${microToUsd(input.remaining)} ${cur}. Model cost counts against the company too. ${spendHow} Spend only what the ticket needs; a cheaper route that does the job is the right route.

${ticket ? `Ticket #${ticket.id}: ${ticket.title}
State: ${ticket.state}. Opened by ${nameOf(everyone, ticket.created_by === 'owner' ? null : ticket.created_by)}${ticket.budget !== null ? `. Ticket cap ${microToUsd(ticket.budget)} ${cur}, ${microToUsd(ticket.spent)} spent so far` : ''}.
${ticket.body}

Thread:
${renderThread(input.thread, everyone)}` : `No ticket this time (reason: ${input.reason}). Look at your queue and report.`}
${input.queue.length ? `\nYour other open tickets: ${input.queue.map((t) => `#${t.id} ${t.title} (${t.state})`).join('; ')}` : ''}
Why you were woken: ${input.reason}.

Rules:
1. Do the work in this run, or say exactly what blocks you.
2. Nothing closes without evidence. "done" needs at least one evidence item: a tab receipt id, a URL, a file you wrote, or the literal output. Without evidence the ticket goes to review, not done.
3. Keep to the ticket. Open a sub-ticket for a colleague when their role fits better; request an approval from the owner for anything over budget or outside the mission.
4. Never ask for the owner key, other agents' keys, or more budget than the task needs.

${agent.adapter === 'claude' ? 'When you are finished, call the finish tool with this shape (omit what you do not need):' : 'End your reply with exactly one JSON object in a \`\`\`json fence with this shape (omit what you do not need):'}
${JSON.stringify(CONTRACT, null, 2)}
`;

  const json: Record<string, unknown> = {
    ver: PACKET_VERSION,
    run_id: input.run_id,
    reason: input.reason,
    company: { id: company.id, name: company.name, mission: company.mission, currency: cur },
    agent: { id: agent.id, name: agent.name, role: agent.role, instructions: agent.instructions, agent: agent.agent_pub },
    colleagues: colleagues.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    ticket: ticket ? {
      id: ticket.id, title: ticket.title, body: ticket.body, state: ticket.state, created_by: ticket.created_by,
      budget: ticket.budget === null ? null : microToUsd(ticket.budget), spent: microToUsd(ticket.spent), evidence: ticket.evidence,
    } : null,
    thread: input.thread.map((e) => ({ at: e.at, by: nameOf(everyone, e.agent_id), kind: e.kind, body: e.body })),
    queue: input.queue.map((t) => ({ id: t.id, title: t.title, state: t.state })),
    approvals: input.approvals.map((a) => ({ id: a.id, kind: a.kind, state: a.state, payload: a.payload })),
    budget: {
      mandate, currency: cur, gateways: company.gateways, catalog: company.catalog,
      run: mandate ? microToUsd(Number(mandate.budget)) : '0.00', remaining: microToUsd(input.remaining),
    },
    contract: CONTRACT,
    prompt,
  };
  return { prompt, json };
}

const STATUSES = new Set(['done', 'in_progress', 'blocked']);

/** Shape-check a result object; returns null when it is not one. Strings are trimmed to sane sizes. */
export function validateResult(x: unknown): AgentResult | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.status !== 'string' || !STATUSES.has(o.status)) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out: AgentResult = { status: o.status as AgentResult['status'], summary: str(o.summary, 4000) };
  if (Array.isArray(o.evidence)) {
    out.evidence = o.evidence
      .filter((e) => e && typeof e === 'object' && typeof (e as Evidence).value === 'string' && (e as Evidence).value.trim() !== '')
      .slice(0, 50)
      .map((e) => ({ kind: str((e as Evidence).kind, 32) || 'text', value: str((e as Evidence).value, 4000) }));
  }
  if (typeof o.comment === 'string') out.comment = o.comment.slice(0, 20_000);
  if (Array.isArray(o.new_tickets)) {
    out.new_tickets = o.new_tickets
      .filter((t) => t && typeof t === 'object' && typeof (t as { title: unknown }).title === 'string')
      .slice(0, 10)
      .map((t) => {
        const tt = t as Record<string, unknown>;
        return { title: str(tt.title, 200), body: str(tt.body, 20_000), assignee: tt.assignee === undefined ? undefined : str(tt.assignee, 100), budget: tt.budget === undefined ? undefined : str(tt.budget, 20) };
      });
  }
  if (Array.isArray(o.requests)) {
    out.requests = o.requests
      .filter((r) => r && typeof r === 'object' && typeof (r as { kind: unknown }).kind === 'string')
      .slice(0, 10)
      .map((r) => {
        const rr = r as Record<string, unknown>;
        return { kind: str(rr.kind, 32), amount: rr.amount === undefined ? undefined : str(rr.amount, 20), reason: str(rr.reason, 2000) };
      });
  }
  if (Array.isArray(o.mentions)) out.mentions = o.mentions.filter((m) => typeof m === 'string').slice(0, 20).map((m) => (m as string).replace(/^@/, '').slice(0, 100));
  return out;
}

/** Find the result in free text: the last ```json fence, else the last balanced {...} that validates. */
export function parseResult(text: string): AgentResult | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const r = validateResult(JSON.parse(fences[i][1]));
      if (r) return r;
    } catch { /* try the next one */ }
  }
  // no fence: walk back from the end looking for an object that parses
  let end = text.lastIndexOf('}');
  while (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{') {
        depth--;
        if (depth === 0) {
          try {
            const r = validateResult(JSON.parse(text.slice(i, end + 1)));
            if (r) return r;
          } catch { /* keep looking */ }
          break;
        }
      }
    }
    end = text.lastIndexOf('}', end - 1);
  }
  return null;
}
