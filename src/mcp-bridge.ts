// 3.1: MCP on both sides of a sale.
// connectTools: the buyer's side. A hosted listing on a tab gateway becomes a local MCP tool set:
// each paid route is a tool, and calling it pays under the agent's mandate and keeps the proof.
//   claude mcp add weather -- npx -y https://github.com/paidwithtab/tab/releases/latest/download/paidwithtab.tgz mcp connect https://pay.paidwithtab.com/s/weather
// serveMcpHttp: the seller's side. A stdio MCP server is put on HTTP (JSON-RPC, one JSON answer
// per request), so a gateway can call its tools and a seller can list it with tab sell --mcp.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { TabClient, PaymentRefused, receiptOf } from './client.js';
import { formatAmount } from './protocol.js';
import { saveProof } from './proof.js';
import type { KeyPair } from './keys.js';
import type { Mandate } from './mandate.js';
import type { McpToolSet } from './mcp.js';

interface DiscoveredRoute { method: string; path: string; price: string; description?: string; mcp_tool?: string; input_schema?: Record<string, unknown> }
interface DiscoveredService { name: string; prefix: string; description?: string; routes: DiscoveredRoute[]; hosted?: unknown }

/** A tool name for a route: its MCP tool's name, else the method and path in snake case. */
export function toolNameOf(r: DiscoveredRoute): string {
  if (r.mcp_tool) return r.mcp_tool;
  const words = r.path.split('/').filter(Boolean).map((p) => p.replace(/^:/, 'by_').replace(/[^A-Za-z0-9]+/g, '_'));
  return [r.method.toLowerCase(), ...words].join('_').slice(0, 64) || r.method.toLowerCase();
}

export async function connectTools(o: { url: string; agent: KeyPair; mandate: Mandate; maxPerCallUsd?: string; proofDir?: string; x402Ledger?: string; fetch?: typeof fetch }): Promise<McpToolSet & { service: string }> {
  const doFetch = o.fetch ?? fetch;
  const u = new URL(o.url);
  const prefix = u.pathname.replace(/\/$/, '');
  const disc = await doFetch(u.origin + '/.well-known/tab', { signal: AbortSignal.timeout(15_000) });
  if (!disc.ok) throw new Error(`${u.origin} has no tab discovery document (HTTP ${disc.status})`);
  const doc = (await disc.json()) as { services?: DiscoveredService[] };
  const service = (doc.services ?? []).find((s) => s.prefix === prefix);
  if (!service) throw new Error(`${u.origin} lists no service at ${prefix || '/'}`);
  const client = new TabClient({ agent: o.agent, mandate: o.mandate, maxPerCallUsd: o.maxPerCallUsd, fetch: o.fetch, x402Ledger: o.x402Ledger });
  const byName = new Map<string, DiscoveredRoute>();
  const list = service.routes.map((r) => {
    const name = toolNameOf(r);
    byName.set(name, r);
    const params = [...r.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const schema = r.input_schema ?? {
      type: 'object',
      properties: {
        ...Object.fromEntries(params.map((p) => [p, { type: 'string', description: `the ${p} in the path` }])),
        ...(r.method === 'GET' || r.method === 'DELETE' ? { query: { type: 'object', description: 'query string parameters', additionalProperties: { type: 'string' } } } : { body: { type: 'object', description: 'the JSON body to send' } }),
      },
      required: params,
    };
    return { name, description: `${r.description ?? `${r.method} ${r.path} on ${service.name}`} (costs ${r.price} per call, paid through tab)`, inputSchema: schema };
  });

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const r = byName.get(name);
    if (!r) return { text: `no tool ${name}`, isError: true };
    let path = r.path;
    for (const m of r.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)) {
      const v = args[m[1]];
      if (v === undefined || v === '') return { text: `missing ${m[1]}`, isError: true };
      path = path.replace(m[0], encodeURIComponent(String(v)));
    }
    const target = new URL(u.origin + prefix + path);
    let body: string | undefined;
    if (r.mcp_tool) body = JSON.stringify(args);
    else if (r.method === 'GET' || r.method === 'DELETE') {
      for (const [k, v] of Object.entries((args.query ?? {}) as Record<string, unknown>)) target.searchParams.set(k, String(v));
    } else body = JSON.stringify(args.body ?? {});
    const init = { method: r.method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body };
    try {
      const res = await client.fetch(target.toString(), init);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const receipt = receiptOf(res);
      const check = receipt ? await client.verify(target.toString(), res, bytes, init) : null;
      const proof = receipt && o.proofDir ? saveProof(o.proofDir, { url: target.toString(), method: r.method, body }, { status: res.status, contentType: res.headers.get('content-type') }, bytes, receipt, o.mandate) : null;
      const text = new TextDecoder().decode(bytes);
      let shown = text;
      // an MCP tool's result comes back as the tool's own content: show its text parts
      if (r.mcp_tool) {
        try {
          const result = JSON.parse(text) as { content?: Array<{ type: string; text?: string }> };
          if (Array.isArray(result.content)) shown = result.content.map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
        } catch { /* show the raw body */ }
      }
      const paid = receipt ? `paid ${formatAmount(Number(receipt.amount), receipt.currency)}, receipt ${check?.ok ? 'verified' : `NOT verified: ${check?.reason}`}${proof ? `, proof in ${proof.dir}` : ''}` : 'not charged';
      return { text: `${shown.slice(0, 50_000)}\n\n(${res.status}; ${paid})`, isError: !res.ok };
    } catch (err) {
      if (err instanceof PaymentRefused) return { text: `payment refused before paying: ${err.reason}`, isError: true };
      return { text: `error: ${(err as Error).message}`, isError: true };
    }
  }
  return { list, call, service: service.name };
}

/**
 * Put a stdio MCP server on HTTP. Each POST is one JSON-RPC message (or a batch); the answer is
 * the server's reply as JSON, or 202 for a notification. One child process serves every caller,
 * with request ids renumbered so callers never collide.
 */
export function serveMcpHttp(o: { command: string; args: string[]; port: number; host: string; path?: string; log?: (m: string) => void }): Server {
  const log = o.log ?? (() => {});
  const path = o.path ?? '/mcp';
  const child = spawn(o.command, o.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('exit', (code) => { log(`MCP server exited (${code}); stopping`); process.exit(code ?? 1); });
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  let next = 1;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const resolve = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
      if (resolve) { waiting.delete(msg.id as number); resolve(msg); }
    } catch { /* not JSON: the server's own logging */ }
  });
  const forward = (msg: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    if (msg.id === undefined || msg.id === null) {
      child.stdin!.write(JSON.stringify(msg) + '\n');
      return Promise.resolve(null);
    }
    const mine = next++;
    const theirs = msg.id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(mine); resolve({ jsonrpc: '2.0', id: theirs, error: { code: -32000, message: 'MCP server did not answer in 120 s' } }); }, 120_000);
      waiting.set(mine, (reply) => { clearTimeout(timer); resolve({ ...reply, id: theirs }); });
      child.stdin!.write(JSON.stringify({ ...msg, id: mine }) + '\n');
    });
  };
  // the stdio server is initialized once, here; callers' own initialize calls are answered from it
  let initialized: Promise<Record<string, unknown> | null> | null = null;
  const ensureInit = () => {
    initialized ??= forward({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tab-mcp-http', version: '1' } } })
      .then((r) => { void forward({ jsonrpc: '2.0', method: 'notifications/initialized' }); return r; });
    return initialized;
  };
  const server = createServer(async (req, res) => {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (new URL(req.url ?? '/', 'http://x').pathname !== path) return reply(404, { error: `MCP is at ${path}` });
    if (req.method !== 'POST') return reply(405, { error: 'POST JSON-RPC here' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 4 * 1024 * 1024) return reply(413, { error: 'body too large' }); chunks.push(c as Buffer); }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const one = async (msg: Record<string, unknown>) => {
      const init = await ensureInit();
      if (msg.method === 'initialize') return init ? { ...init, id: msg.id } : null;
      if (msg.method === 'notifications/initialized') return null;
      return forward(msg);
    };
    const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => one(m as Record<string, unknown>)))).filter(Boolean);
    if (!answers.length) return reply(202);
    reply(200, Array.isArray(body) ? answers : answers[0]);
  });
  server.listen(o.port, o.host, () => log(`MCP over HTTP at http://${o.host}:${o.port}${path} (${o.command} ${o.args.join(' ')})`));
  return server;
}

/** List an MCP server's tools over HTTP: what tab sell --mcp prices. */
export async function listMcpTools(endpoint: string, doFetch: typeof fetch = fetch): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
  let session: string | null = null;
  let id = 1;
  const rpc = async (method: string, params: unknown, notify = false) => {
    const r = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: id++, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    session = r.headers.get('mcp-session-id') ?? session;
    const text = await r.text();
    if (notify) return null;
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const parts = /text\/event-stream/.test(r.headers.get('content-type') ?? '') ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()) : [text];
    for (const p of parts) { try { const m = JSON.parse(p); if (m.result || m.error) return m; } catch { /* keep looking */ } }
    throw new Error(`${method}: no JSON-RPC answer`);
  };
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tab-sell', version: '1' } });
  if (init?.error) throw new Error(`initialize: ${init.error.message}`);
  await rpc('notifications/initialized', {}, true).catch(() => null);
  const tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {});
    if (page?.error) throw new Error(`tools/list: ${page.error.message}`);
    tools.push(...(page?.result?.tools ?? []));
    cursor = page?.result?.nextCursor;
  } while (cursor && tools.length < 200);
  return tools;
}
