// Adapters: how a run reaches an agent. `claude` runs the agent in process as
// a tool-use loop against the Anthropic Messages API under the company's own
// API key, with the tab tools and nothing else (src/company/model.ts).
// `claude-code` spawns Claude Code in print mode with the tab MCP server
// attached (the agent key and the run's mandate go to a 0700 temp directory
// that is deleted when the run ends); it is for self-hosted servers whose user
// is signed in to Claude Code. `http` POSTs the packet to an endpoint the agent
// definition names and reads the result back. Agent definitions are data:
// nothing in them is executed here, and every adapter calls out, never in.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usdToMicro } from '../protocol.js';
import { saveKey, type KeyPair } from '../keys.js';
import { saveMandate, type Mandate } from '../mandate.js';
import { parseResult, validateResult, type AgentResult, type Packet } from './packet.js';
import { runModelAgent } from './model.js';
import type { AgentRow } from './store.js';

export const ADAPTERS = ['claude', 'claude-code', 'http'] as const;
export type AdapterName = (typeof ADAPTERS)[number];

export interface AdapterContext {
  agent: AgentRow;
  packet: Packet;
  agentKey: KeyPair | null; // custodial key for the claude adapters
  mandate: Mandate | null;
  catalog: string | null;
  currency: string;
  workDir: string; // the company workspace; the claude-code adapter runs there
  modelKey: string | null; // the company's Anthropic API key (or the host's), for the claude adapter
  anthropicUrl?: string; // tests point the claude adapter at a stub
  timeoutMs: number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

export interface AdapterOutput {
  text: string; // what the agent said, for the run log
  result: AgentResult | null;
  modelCostMicro: number;
}

export const DEFAULT_CLAUDE_TOOLS = [
  'mcp__tab__tab_limits', 'mcp__tab__tab_search', 'mcp__tab__tab_discover', 'mcp__tab__tab_fetch', 'mcp__tab__tab_balance',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
];

/** The tab CLI entry for the MCP server: dist/src/cli.js, or src/cli.ts under tsx in a source checkout. */
function tabMcpCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const ts = here.endsWith('.ts');
  const entry = join(dirname(here), '..', ts ? 'cli.ts' : 'cli.js');
  const args = ['--no-warnings=ExperimentalWarning'];
  if (ts) args.push('--import', 'tsx');
  args.push(entry, 'mcp');
  return { command: process.execPath, args };
}

export async function runAdapter(ctx: AdapterContext): Promise<AdapterOutput> {
  switch (ctx.agent.adapter) {
    case 'http':
      return runHttp(ctx);
    case 'claude':
      return runModel(ctx);
    case 'claude-code':
      return runClaudeCode(ctx);
    default:
      throw new Error(`unknown adapter ${String(ctx.agent.adapter)}`);
  }
}

// ---------------------------------------------------------------------------
// http: POST the packet, read the result

async function runHttp(ctx: AdapterContext): Promise<AdapterOutput> {
  const cfg = ctx.agent.config;
  const url = String(cfg.url ?? '');
  if (!/^https?:\/\//.test(url)) throw new Error('http adapter needs config.url');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [k, v] of Object.entries((cfg.headers as Record<string, unknown>) ?? {})) headers[k.toLowerCase()] = String(v);
  const doFetch = ctx.fetch ?? fetch;
  const res = await doFetch(url, {
    method: 'POST', headers, body: JSON.stringify(ctx.packet.json),
    signal: AbortSignal.timeout(ctx.timeoutMs), redirect: 'error',
  });
  const text = (await res.text()).slice(0, 500_000);
  if (!res.ok) throw new Error(`agent endpoint answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* prose: look for the fence */ }
  let result: AgentResult | null = null;
  let modelCostMicro = 0;
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    result = validateResult(o.result ?? o) ?? (typeof o.text === 'string' ? parseResult(o.text) : null);
    if (typeof o.cost_usd === 'string' || typeof o.cost_usd === 'number') {
      try { modelCostMicro = usdToMicro(Number(o.cost_usd).toFixed(6)); } catch { /* ignore */ }
    }
  } else {
    result = parseResult(text);
  }
  return { text, result, modelCostMicro };
}

// ---------------------------------------------------------------------------
// claude: the Messages API, in process, with the tab tools

async function runModel(ctx: AdapterContext): Promise<AdapterOutput> {
  if (!ctx.modelKey) throw new Error('no model key: add an Anthropic API key to the company before its claude agents can run');
  const cfg = ctx.agent.config;
  const out = await runModelAgent({
    apiKey: ctx.modelKey, baseUrl: ctx.anthropicUrl,
    model: cfg.model ? String(cfg.model) : undefined,
    maxTurns: Number(cfg.max_turns) || undefined,
    system: cfg.system ? String(cfg.system) : undefined,
    packet: ctx.packet, agentKey: ctx.agentKey, mandate: ctx.mandate, catalog: ctx.catalog, currency: ctx.currency,
    maxPerCallUsd: typeof cfg.max_per_call === 'string' ? cfg.max_per_call : undefined,
    timeoutMs: ctx.timeoutMs, fetch: ctx.fetch, log: ctx.log,
  });
  const head = `[${out.model}: ${out.usage.turns} turns, ${out.usage.input} tokens in, ${out.usage.output} out${out.usage.cache_read ? `, ${out.usage.cache_read} cached` : ''}]`;
  ctx.log?.(`${ctx.agent.name} ${head}`);
  return { text: `${head}\n${out.text}`, result: out.result, modelCostMicro: out.modelCostMicro };
}

// ---------------------------------------------------------------------------
// claude-code: Claude Code in print mode with the tab MCP server

async function runClaudeCode(ctx: AdapterContext): Promise<AdapterOutput> {
  const cfg = ctx.agent.config;
  const bin = String(cfg.command ?? process.env.CLAUDE_BIN ?? 'claude');
  const tools = Array.isArray(cfg.tools) ? cfg.tools.map(String) : DEFAULT_CLAUDE_TOOLS;
  const maxTurns = Number(cfg.max_turns ?? 25) || 25;
  const dir = mkdtempSync(join(tmpdir(), 'tab-run-'));
  try {
    const mcpServers: Record<string, unknown> = {};
    if (ctx.agentKey && ctx.mandate) {
      const agentPath = join(dir, 'agent.json');
      const mandatePath = join(dir, 'mandate.json');
      saveKey(agentPath, ctx.agentKey);
      saveMandate(mandatePath, ctx.mandate);
      const env: Record<string, string> = { TAB_AGENT: agentPath, TAB_MANDATE: mandatePath, TAB_CURRENCY: ctx.currency };
      if (ctx.catalog) env.TAB_CATALOG = ctx.catalog;
      if (cfg.max_per_call !== undefined) env.TAB_MAX_PER_CALL = String(cfg.max_per_call);
      const mcp = tabMcpCommand();
      mcpServers.tab = { command: mcp.command, args: mcp.args, env };
    }
    const mcpPath = join(dir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers }), { mode: 0o600 });

    const args = [
      '-p', 'Read the work packet below and act on it. End with the JSON result the packet asks for.',
      '--output-format', 'json', '--max-turns', String(maxTurns),
      '--mcp-config', mcpPath, '--strict-mcp-config',
      '--allowedTools', tools.join(','),
    ];
    if (cfg.model) args.push('--model', String(cfg.model));
    if (cfg.system) args.push('--append-system-prompt', String(cfg.system));

    const cwd = existsSync(ctx.workDir) ? ctx.workDir : process.cwd();
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: { ...process.env, CLAUDECODE: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude run timed out after ${ctx.timeoutMs} ms`)); }, ctx.timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: c }); });
      child.stdin.on('error', () => { /* the child exited before reading the packet; close reports it */ });
      child.stdin.end(ctx.packet.prompt);
    });
    ctx.log?.(`claude exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
    let text = stdout;
    let modelCostMicro = 0;
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      // --output-format json: {type:"result", subtype, result, total_cost_usd, ...}
      if (typeof parsed.result === 'string') text = parsed.result;
      else if (parsed.subtype && parsed.subtype !== 'success') text = `claude: ${String(parsed.subtype)}`;
      if (typeof parsed.total_cost_usd === 'number') modelCostMicro = usdToMicro(parsed.total_cost_usd.toFixed(6));
    } catch {
      /* not JSON: the raw text is what we have */
    }
    if (code !== 0 && !text.trim()) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500) || 'no output'}`);
    return { text, result: parseResult(text), modelCostMicro };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
