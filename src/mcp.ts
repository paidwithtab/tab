// A Model Context Protocol server on stdio, implemented without an SDK.
// Newline-delimited JSON-RPC 2.0. Five tools: tab_limits, tab_search,
// tab_discover, tab_fetch, tab_balance (src/tools.ts). Runs where Claude Code runs.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Mandate } from './mandate.js';
import type { KeyPair } from './keys.js';
import { createTabTools } from './tools.js';

// the package version, read from package.json two levels up from dist/src so the server reports what was installed
const PKG_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version; } catch { return '0'; }
})();

export interface McpOptions {
  agent: KeyPair;
  mandate: Mandate;
  maxPerCallUsd?: string;
  currency?: string; // what this agent pays in; default USD
  catalog?: string; // catalog origin
}

const PROTOCOL_VERSION = '2024-11-05';

export function runMcpServer(opts: McpOptions): void {
  const tools = createTabTools(opts);

  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id: unknown, code: number, message: string) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON-RPC; ignore
    }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tab', version: PKG_VERSION },
      });
    } else if (method === 'notifications/initialized' || String(method ?? '').startsWith('notifications/')) {
      // notifications need no reply
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: tools.list });
    } else if (method === 'tools/call') {
      tools.call(String(params?.name), (params?.arguments ?? {}) as Record<string, unknown>)
        .then((r) => reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError }))
        .catch((err) => reply(id, {
          content: [{ type: 'text', text: `error: ${(err as Error).message}` }],
          isError: true,
        }));
    } else if (id !== undefined) {
      replyError(id, -32601, `method not found: ${method}`);
    }
  });
  rl.on('close', () => process.exit(0));
}
