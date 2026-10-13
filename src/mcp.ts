// A Model Context Protocol server on stdio, implemented without an SDK.
// Newline-delimited JSON-RPC 2.0. Five tools: tab_limits, tab_search,
// tab_discover, tab_fetch, tab_balance. Runs where Claude Code runs.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { microToUsd, formatAmount } from './protocol.js';
import type { Mandate } from './mandate.js';
import type { KeyPair } from './keys.js';
import { TabClient, PaymentRefused, receiptOf } from './client.js';

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

const TOOLS = [
  {
    name: 'tab_limits',
    description:
      'What this agent is allowed to spend: the mandate terms (budget, window, per-call cap, allowed realms, expiry) and the client-side per-call cap.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tab_search',
    description:
      'Search the tab catalog for paid API routes by keyword. Returns callable URLs with prices, cheapest first. Each result names its currency: USD, or the token a gateway charges in; this agent can only pay in the currency tab_limits reports.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords to search route names and descriptions' },
        max_price: { type: 'string', description: 'optional price ceiling in this agent\'s currency, e.g. "0.01"; routes priced in other currencies are left out' },
      },
      required: ['query'],
    },
  },
  {
    name: 'tab_discover',
    description:
      'Fetch a tab gateway discovery document (/.well-known/tab) listing its realm, rail and priced routes.',
    inputSchema: {
      type: 'object',
      properties: { origin: { type: 'string', description: 'gateway origin, e.g. https://pay.example.com' } },
      required: ['origin'],
    },
  },
  {
    name: 'tab_fetch',
    description:
      'Fetch a URL, paying per request over HTTP 402 within the mandate. Returns status, the payment receipt (if any) and the body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'HTTP method, default GET' },
        body: { type: 'string', description: 'request body for POST/PUT/PATCH' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tab_balance',
    description:
      "Check the mandate owner's available balance on the gateways the catalog knows about (or on one specific gateway origin).",
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'optional gateway origin to ask directly' },
        wallet: { type: 'string', description: 'optional wallet id; defaults to the mandate owner' },
      },
    },
  },
];

export function runMcpServer(opts: McpOptions): void {
  const client = new TabClient({
    agent: opts.agent,
    mandate: opts.mandate,
    maxPerCallUsd: opts.maxPerCallUsd,
    currency: opts.currency,
  });
  const currency = opts.currency ?? 'USD';

  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id: unknown, code: number, message: string) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });
  const text = (value: unknown, isError = false) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError,
  });

  async function callTool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case 'tab_limits':
        return text({
          agent: opts.agent.publicKey,
          owner: opts.mandate.owner,
          budget_usd: microToUsd(Number(opts.mandate.budget)),
          window: opts.mandate.window,
          mandate_max_per_call_usd:
            opts.mandate.max_per_call === null ? null : microToUsd(Number(opts.mandate.max_per_call)),
          client_max_per_call_usd: opts.maxPerCallUsd ?? null,
          currency,
          allow: opts.mandate.allow,
          expires_at: opts.mandate.expires_at,
          catalog: opts.catalog ?? null,
        });
      case 'tab_search': {
        if (!opts.catalog) return text('no catalog configured (set TAB_CATALOG)', true);
        const u = new URL(opts.catalog.replace(/\/$/, '') + '/v1/search');
        u.searchParams.set('q', String(args.query ?? ''));
        if (args.max_price) u.searchParams.set('max_price', String(args.max_price));
        u.searchParams.set('currency', currency);
        const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
        return text(await r.json());
      }
      case 'tab_discover': {
        const origin = String(args.origin ?? '').replace(/\/$/, '');
        const r = await fetch(origin + '/.well-known/tab', { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return text(`discovery failed: HTTP ${r.status}`, true);
        return text(await r.json());
      }
      case 'tab_fetch': {
        const method = String(args.method ?? 'GET').toUpperCase();
        try {
          const r = await client.fetch(String(args.url), {
            method,
            headers: args.body != null ? { 'content-type': 'application/json' } : undefined,
            body: args.body != null ? String(args.body) : undefined,
          });
          const bodyText = await r.text();
          const receipt = receiptOf(r);
          return text({
            status: r.status,
            paid: receipt ? formatAmount(Number(receipt.amount), receipt.currency) : null,
            paid_usd: receipt && (receipt.currency ?? 'USD') === 'USD' ? microToUsd(Number(receipt.amount)) : null,
            receipt,
            body: bodyText.slice(0, 50_000),
          });
        } catch (err) {
          if (err instanceof PaymentRefused) {
            return text(`payment refused before paying: ${err.reason}`, true);
          }
          throw err;
        }
      }
      case 'tab_balance': {
        const wallet = String(args.wallet ?? opts.mandate.owner);
        const origins: string[] = [];
        if (args.origin) origins.push(String(args.origin).replace(/\/$/, ''));
        else if (opts.catalog) {
          const r = await fetch(opts.catalog.replace(/\/$/, '') + '/v1/catalog.json', {
            signal: AbortSignal.timeout(10_000),
          });
          const doc = (await r.json()) as { gateways?: Array<{ origin: string; ok: boolean }> };
          for (const g of doc.gateways ?? []) if (g.ok) origins.push(g.origin);
        }
        if (origins.length === 0) return text('no gateway origin known (set TAB_CATALOG or pass origin)', true);
        const balances = await Promise.all(
          origins.map(async (origin) => {
            try {
              const r = await fetch(origin + '/.well-known/tab/wallet/' + encodeURIComponent(wallet), {
                signal: AbortSignal.timeout(10_000),
              });
              return { origin, ...((await r.json()) as Record<string, unknown>) };
            } catch (err) {
              return { origin, error: (err as Error).message };
            }
          }),
        );
        return text({ wallet, balances });
      }
      default:
        return text(`unknown tool: ${name}`, true);
    }
  }

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
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      callTool(String(params?.name), params?.arguments ?? {})
        .then((result) => reply(id, result))
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
