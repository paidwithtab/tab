// The five tab tools an agent gets, as data plus an implementation: what the
// MCP server exposes to Claude Code and what the company's model adapter hands
// to the Messages API. One place, so both agents see the same tools.

import { microToUsd, formatAmount } from './protocol.js';
import type { Mandate } from './mandate.js';
import type { KeyPair } from './keys.js';
import { TabClient, PaymentRefused, receiptOf } from './client.js';

export interface TabToolOptions {
  agent: KeyPair;
  mandate: Mandate;
  maxPerCallUsd?: string;
  currency?: string; // what this agent pays in; default USD
  catalog?: string; // catalog origin
  fetch?: typeof fetch;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export const TAB_TOOLS: ToolSpec[] = [
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

/** The tools bound to one agent key and one mandate. `call` never throws for a tool-level failure; it returns isError. */
export function createTabTools(opts: TabToolOptions): { list: ToolSpec[]; call: (name: string, args: Record<string, unknown>) => Promise<ToolResult> } {
  const doFetch = opts.fetch ?? fetch;
  const client = new TabClient({
    agent: opts.agent,
    mandate: opts.mandate,
    maxPerCallUsd: opts.maxPerCallUsd,
    currency: opts.currency,
    fetch: opts.fetch,
  });
  const currency = opts.currency ?? 'USD';
  const text = (value: unknown, isError = false): ToolResult => ({
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    isError,
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
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
          const r = await doFetch(u, { signal: AbortSignal.timeout(10_000) });
          return text(await r.json());
        }
        case 'tab_discover': {
          const origin = String(args.origin ?? '').replace(/\/$/, '');
          if (!/^https?:\/\/[^/\s]+$/.test(origin)) return text('origin must look like https://pay.example.com', true);
          const r = await doFetch(origin + '/.well-known/tab', { signal: AbortSignal.timeout(10_000) });
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
            if (err instanceof PaymentRefused) return text(`payment refused before paying: ${err.reason}`, true);
            throw err;
          }
        }
        case 'tab_balance': {
          const wallet = String(args.wallet ?? opts.mandate.owner);
          const origins: string[] = [];
          if (args.origin) origins.push(String(args.origin).replace(/\/$/, ''));
          else if (opts.catalog) {
            const r = await doFetch(opts.catalog.replace(/\/$/, '') + '/v1/catalog.json', { signal: AbortSignal.timeout(10_000) });
            const doc = (await r.json()) as { gateways?: Array<{ origin: string; ok: boolean }> };
            for (const g of doc.gateways ?? []) if (g.ok) origins.push(g.origin);
          }
          if (origins.length === 0) return text('no gateway origin known (set TAB_CATALOG or pass origin)', true);
          const balances = await Promise.all(
            origins.map(async (origin) => {
              try {
                const r = await doFetch(origin + '/.well-known/tab/wallet/' + encodeURIComponent(wallet), { signal: AbortSignal.timeout(10_000) });
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
    } catch (err) {
      return text(`error: ${(err as Error).message}`, true);
    }
  }

  return { list: TAB_TOOLS, call };
}
