// The model adapter: an agent run as a tool-use loop against the Anthropic
// Messages API, with the five tab tools and one `finish` tool that carries the
// result contract. No SDK, no filesystem, no shell: the agent can read the
// packet, search the catalog, pay for calls under its mandate, and report. The
// company's own API key pays for the model, and the usage the API reports is
// priced into the run's model cost.

import { usdToMicro } from '../protocol.js';
import { createTabTools, type ToolSpec } from '../tools.js';
import type { KeyPair } from '../keys.js';
import type { Mandate } from '../mandate.js';
import { CONTRACT, parseResult, validateResult, type AgentResult, type Packet } from './packet.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ModelRunOptions {
  apiKey: string;
  baseUrl?: string; // default ANTHROPIC_URL; tests point it at a stub
  model?: string;
  maxTurns?: number; // model calls per run; default 20
  maxCostMicro?: number; // stop calling the model once this run's model cost reaches it
  maxTokens?: number; // per reply; default 4096
  system?: string; // appended to the system prompt
  packet: Packet;
  agentKey: KeyPair | null;
  mandate: Mandate | null;
  catalog: string | null;
  currency: string;
  maxPerCallUsd?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface ModelRunOutput {
  text: string;
  result: AgentResult | null;
  modelCostMicro: number;
  usage: { input: number; output: number; cache_read: number; cache_write: number; turns: number };
  model: string;
}

/** USD per million tokens: input, output, cache write (5 minute), cache read. Matched by model id, most specific first. */
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
  [/fable-5-1|mythos-5-1/, [10, 50, 12.5, 0.25]],
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-5-5/, [4, 20, 5, 0.2]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet-5-5/, [2, 10, 2.5, 0.1]],
  [/sonnet-5/, [2, 10, 2.5, 0.2]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-5/, [0.1, 0.5, 0.125, 0.01]],
  [/haiku/, [1, 5, 1.25, 0.1]],
];

/** Micro-USD for one reply's usage. Unknown models are priced like Opus so an estimate never flatters the run. */
export function priceUsage(model: string, u: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): number {
  const p = PRICES.find(([re]) => re.test(model))?.[1] ?? [5, 25, 6.25, 0.5];
  const usd = ((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + (u.cache_creation_input_tokens ?? 0) * p[2] + (u.cache_read_input_tokens ?? 0) * p[3]) / 1_000_000;
  return usdToMicro(usd.toFixed(6));
}

const FINISH_TOOL: ToolSpec = {
  name: 'finish',
  description: 'End the run with your report. Call this exactly once, when the work is done, blocked, or as far as it can go this run. Nothing closes without evidence: a receipt id from tab_fetch, a URL you verified, or the literal output you produced.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'in_progress', 'blocked'] },
      summary: { type: 'string', description: CONTRACT.summary },
      evidence: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['receipt', 'url', 'file', 'text'] }, value: { type: 'string' } }, required: ['kind', 'value'] } },
      comment: { type: 'string', description: CONTRACT.comment },
      new_tickets: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, assignee: { type: 'string' }, budget: { type: 'string' } }, required: ['title'] } },
      requests: { type: 'array', description: 'Ask the owner. A hire names the new agent, its role and instructions, with amount as its budget per run; once approved the agent joins the company and you are woken to assign it work.', items: { type: 'object', properties: { kind: { type: 'string', enum: ['budget', 'hire', 'other'] }, amount: { type: 'string' }, reason: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, instructions: { type: 'string' } }, required: ['kind'] } },
      mentions: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'summary'],
  },
};

interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  model?: string;
  error?: { type?: string; message?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One run: the packet as the user turn, tools until `finish` or the turn cap. */
export async function runModelAgent(o: ModelRunOptions): Promise<ModelRunOutput> {
  const doFetch = o.fetch ?? fetch;
  const model = o.model ?? DEFAULT_MODEL;
  const maxTurns = Math.max(1, Math.min(100, o.maxTurns ?? 20));
  const deadline = Date.now() + o.timeoutMs;
  const log = o.log ?? (() => {});

  const tab = o.agentKey && o.mandate
    ? createTabTools({ agent: o.agentKey, mandate: o.mandate, maxPerCallUsd: o.maxPerCallUsd, currency: o.currency, catalog: o.catalog ?? undefined, fetch: o.fetch })
    : null;
  const tools = [...(tab ? tab.list : []), FINISH_TOOL].map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  const system = [
    'You are an agent employed by a company that runs on tab, a payment layer for agents. You work one ticket per run.',
    tab
      ? 'You pay for information and services with the tab tools: tab_search finds priced routes in the catalog, tab_fetch pays for one call under your mandate and returns a receipt, tab_limits shows what this run may spend. You have no other tools: no files, no shell, no browser. Everything you learn comes from paid calls or the packet itself. When no route serves the topic directly (a store, a company, a market), search the catalog for "web search": a paid web search covers the open web, and its results are evidence like any other call.'
      : 'This run has no mandate, so you cannot pay for anything; work from the packet alone.',
    'Spend only what the ticket needs. A cheaper route that does the job is the right route. Never pay the same call twice.',
    `When you are finished, blocked, or out of useful moves, call finish exactly once. Its arguments are your report: ${JSON.stringify(CONTRACT)}. Do not write the report as prose instead of calling finish.`,
    o.system ?? '',
  ].filter(Boolean).join('\n\n');

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: o.packet.prompt }];
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 };
  let cost = 0;
  let transcript = '';
  let result: AgentResult | null = null;
  let reportedModel = model;

  for (let turn = 0; turn < maxTurns && !result; turn++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`model run timed out after ${o.timeoutMs} ms`);
    const res = await callMessages(doFetch, o.baseUrl ?? ANTHROPIC_URL, o.apiKey, { model, max_tokens: o.maxTokens ?? 4096, system, tools, messages }, Math.min(left, 300_000), log);
    usage.turns++;
    if (res.usage) {
      usage.input += res.usage.input_tokens ?? 0;
      usage.output += res.usage.output_tokens ?? 0;
      usage.cache_read += res.usage.cache_read_input_tokens ?? 0;
      usage.cache_write += res.usage.cache_creation_input_tokens ?? 0;
      cost += priceUsage(res.model ?? model, res.usage);
    }
    if (res.model) reportedModel = res.model;
    if (o.maxCostMicro !== undefined && cost >= o.maxCostMicro) {
      transcript += '[stopped: the company has no budget left for more model calls]\n';
      for (const b of res.content ?? []) if (b.type === 'text' && b.text) transcript += b.text + '\n';
      break;
    }
    const content = res.content ?? [];
    messages.push({ role: 'assistant', content });
    const toolUses = content.filter((b) => b.type === 'tool_use');
    for (const b of content) if (b.type === 'text' && b.text) transcript += b.text + '\n';
    if (!toolUses.length) {
      // the model stopped talking without calling finish: take a fenced result from the prose if there is one, else nudge once
      result = parseResult(transcript);
      if (result || res.stop_reason === 'max_tokens' || turn === maxTurns - 1) break;
      messages.push({ role: 'user', content: 'Call finish with your report now.' });
      continue;
    }
    const results: unknown[] = [];
    for (const tu of toolUses) {
      const name = String(tu.name);
      const input = (tu.input ?? {}) as Record<string, unknown>;
      if (name === 'finish') {
        const r = validateResult(input);
        if (r) { result = r; results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'recorded' }); }
        else results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'finish needs status (done | in_progress | blocked) and summary', is_error: true });
        continue;
      }
      if (!tab) { results.push({ type: 'tool_result', tool_use_id: tu.id, content: `no such tool: ${name}`, is_error: true }); continue; }
      const out = await tab.call(name, input);
      transcript += `[${name} ${JSON.stringify(input).slice(0, 300)}] -> ${out.isError ? 'error: ' : ''}${out.text.slice(0, 500)}\n`;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.text.slice(0, 60_000), is_error: out.isError || undefined });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: transcript.trim(), result, modelCostMicro: cost, usage, model: reportedModel };
}

/** POST /v1/messages with a few retries on 429, 5xx and network failures. Throws on any other error. */
async function callMessages(doFetch: typeof fetch, baseUrl: string, apiKey: string, body: unknown, timeoutMs: number, log: (m: string) => void): Promise<MessagesResponse> {
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
    let r: Response;
    try {
      r = await doFetch(baseUrl.replace(/\/$/, '') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = `network: ${(err as Error).message}`;
      log(`anthropic: ${lastErr} (attempt ${attempt + 1})`);
      continue;
    }
    const text = await r.text();
    let json: MessagesResponse = {};
    try { json = JSON.parse(text) as MessagesResponse; } catch { /* not JSON */ }
    if (r.ok) return json;
    lastErr = `HTTP ${r.status}: ${json.error?.message ?? text.slice(0, 200)}`;
    if (r.status === 429 || r.status >= 500) { log(`anthropic: ${lastErr} (attempt ${attempt + 1})`); continue; }
    if (r.status === 401 || r.status === 403) throw new Error(`the model API key was refused (${lastErr}); replace the company's model key`);
    throw new Error(`model API error: ${lastErr}`);
  }
  throw new Error(`model API unavailable: ${lastErr}`);
}
