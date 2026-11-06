// The five tab tools an agent gets, as data plus an implementation: what the
// MCP server exposes to Claude Code and what the company's model adapter hands
// to the Messages API. One place, so both agents see the same tools.

import { saveProof } from './proof.js';
import { microToUsd, formatAmount, usdToMicro, normalizeUsd } from './protocol.js';
import { approvalThreshold, delegateMandate, mandateChain, perCallCap, type Mandate } from './mandate.js';
import type { KeyPair } from './keys.js';
import type { ApprovalRequest } from './approval.js';
import { TabClient, PaymentRefused, receiptOf, x402ResponseOf, escrowOf, approvalRequestOf, type EscrowTicket } from './client.js';

export interface TabToolOptions {
  agent: KeyPair;
  mandate: Mandate;
  maxPerCallUsd?: string;
  currency?: string; // what this agent pays in; default USD
  catalog?: string; // catalog origin
  fetch?: typeof fetch;
  x402Ledger?: string; // where x402 spend against the mandate is kept between runs
  /** 3.0: channels this agent pays from (the TabClient channels option). */
  channels?: { depositUsd?: string; file?: string };
  /** 3.0: told when a payment waits for the owner's approval, so a host (tab OS) can put it in front of them. */
  onApprovalRequired?: (request: ApprovalRequest, origin: string, url: string) => void | Promise<void>;
  /** 3.0: told when an agent opens a pay-on-delivery order, so a host can follow it. */
  onEscrow?: (ticket: EscrowTicket, url: string) => void | Promise<void>;
  /** 3.0: told when the agent delegates part of its mandate, so a host can show the chain. */
  onDelegate?: (child: Mandate) => void | Promise<void>;
  /**
   * 3.0: offer tab_delegate. Off by default: an agent talked into it would hand a portable slice of
   * its mandate to whatever key it was given. Turn it on for agents meant to hire helpers.
   */
  allowDelegate?: boolean;
  /** 3.1: keep every paid response as a proof folder here (body, signed receipt, request, mandate), checkable with tab verify. */
  proofDir?: string;
}

/** What a host passes to the tools besides the key and mandate. */
export type TabHooks = Pick<TabToolOptions, 'onApprovalRequired' | 'onEscrow' | 'onDelegate' | 'channels'>;

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
        limit: { type: 'number', description: 'how many routes to return, best matches first (default 20, at most 100); the result says how many matched in total' },
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
      'Fetch a URL, paying per request over HTTP 402 within the mandate: tab gateways, and x402 sites (USDG on Robinhood Chain, USDC on Base) from the agent\'s own funded address. Returns status, the payment receipt or x402 settlement (if any) and the body. A payment above the mandate\'s approval threshold comes back as approval_required: tell the owner, and call again with the same request once they approved it. escrow: true pays on delivery on routes that offer it (the result comes later, read it with tab_escrow).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'HTTP method, default GET' },
        body: { type: 'string', description: 'request body for POST/PUT/PATCH' },
        escrow: { type: 'boolean', description: 'pay on delivery: the money is held until the seller delivers, refunded if it does not' },
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
  {
    name: 'tab_escrow',
    description: 'Check a pay-on-delivery order from tab_fetch (escrow: true): held, delivered (returns the result and its verified delivery receipt) or refunded.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'the order\'s status URL, from tab_fetch' },
        token: { type: 'string', description: 'the order\'s token, from tab_fetch' },
        wait_s: { type: 'number', description: 'wait up to this many seconds for delivery (default 0, at most 120)' },
      },
      required: ['status', 'token'],
    },
  },
  {
    name: 'tab_delegate',
    description: 'Hand part of this agent\'s mandate to another agent key: a sub-mandate signed by this agent, inside every limit of its own. Spend under it counts against this mandate too. Returns the sub-mandate JSON to give that agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'the other agent\'s public key (wallet id)' },
        budget: { type: 'string', description: 'its budget, at most this mandate\'s, e.g. "0.25"' },
        max_per_call: { type: 'string', description: 'optional per-call cap, at most this mandate\'s' },
        allow: { type: 'array', items: { type: 'string' }, description: 'optional realms, inside this mandate\'s allow list' },
        hours: { type: 'number', description: 'optional lifetime in hours; never past this mandate\'s expiry' },
      },
      required: ['agent', 'budget'],
    },
  },
  {
    name: 'tab_channel',
    description: 'Payment channels: one deposit at a gateway, then each call there is paid by a signed voucher with no transaction per call, settled once at close. action "open" (origin, deposit), "list", or "close" (origin). While a channel is open, tab_fetch to that gateway pays from it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'list', 'close'] },
        origin: { type: 'string', description: 'gateway origin, e.g. https://pay.example.com' },
        deposit: { type: 'string', description: 'for open: the deposit, e.g. "0.50"' },
      },
      required: ['action'],
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
    x402Ledger: opts.x402Ledger,
    channels: opts.channels ?? {},
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
            mandate_max_per_call_usd: perCallCap(opts.mandate) === null ? null : microToUsd(perCallCap(opts.mandate)!),
            // 3.0: payments above this wait for the owner's approval; a sub-mandate names the chain above it
            approve_above: approvalThreshold(opts.mandate) === null ? null : microToUsd(approvalThreshold(opts.mandate)!),
            mandate: opts.mandate.id,
            delegated_from: opts.mandate.parent ? mandateChain(opts.mandate).slice(1).map((m) => ({ mandate: m.id, agent: m.agent })) : null,
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
          u.searchParams.set('limit', String(Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100)));
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
            const init = {
              method,
              headers: args.body != null ? { 'content-type': 'application/json' } : undefined,
              body: args.body != null ? String(args.body) : undefined,
            };
            const r = await client.fetch(String(args.url), init, { escrow: args.escrow === true });
            const pending = await approvalRequestOf(r);
            if (pending) {
              await opts.onApprovalRequired?.(pending, new URL(String(args.url)).origin, String(args.url));
              return text({
                status: 402, approval_required: true, amount: formatAmount(Number(pending.amount), pending.currency), resource: pending.resource, realm: pending.realm,
                request: pending.id,
                next: 'This payment is above the approval threshold. The owner has been asked (or approves with tab mandate approve). Once approved, call tab_fetch again with exactly the same request.',
              }, true);
            }
            const ticket = escrowOf(r);
            // only a call the agent placed pay on delivery is an order
            if (ticket && args.escrow === true) await opts.onEscrow?.(ticket, String(args.url));
            const bytes = new Uint8Array(await r.arrayBuffer());
            const bodyText = new TextDecoder().decode(bytes);
            const receipt = receiptOf(r);
            const check = receipt ? await client.verify(String(args.url), r, bytes, init) : null;
            const proof = receipt && opts.proofDir
              ? saveProof(opts.proofDir, { url: String(args.url), method, body: init.body }, { status: r.status, contentType: r.headers.get('content-type') }, bytes, receipt, opts.mandate)
              : null;
            return text({
              status: r.status,
              paid: receipt ? formatAmount(Number(receipt.amount), receipt.currency) : null,
              paid_usd: receipt && (receipt.currency ?? 'USD') === 'USD' ? microToUsd(Number(receipt.amount)) : null,
              receipt,
              receipt_verified: check ? check.ok : null,
              ...(check && !check.ok ? { receipt_problem: check.reason } : {}),
              ...(proof ? { proof: proof.dir } : {}),
              // paid to an x402 site: what it reports settling (its transaction on chain is the record)
              ...(x402ResponseOf(r) ? { x402: x402ResponseOf(r) } : {}),
              ...(ticket ? { escrow: { order: ticket.id, state: ticket.state, deadline: ticket.deadline, status: ticket.status, token: ticket.token } } : {}),
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
        case 'tab_escrow': {
          const ticket: EscrowTicket = { id: String(args.status ?? '').split('/').pop() ?? '', state: 'held', deadline: '', status: String(args.status ?? ''), token: String(args.token ?? '') };
          if (!/^https?:\/\//.test(ticket.status)) return text('status must be the order\'s status URL from tab_fetch', true);
          const out = await client.escrowResult(ticket, Math.min(Math.max(Number(args.wait_s ?? 0) || 0, 0), 120) * 1000);
          return text({
            state: out.state, order: out.order,
            ...(out.body ? { receipt: out.receipt, receipt_verified: out.verified?.ok ?? false, body: new TextDecoder().decode(out.body).slice(0, 50_000) } : {}),
          });
        }
        case 'tab_delegate': {
          if (!opts.allowDelegate) return text('delegation is off for this agent (the host enables it with allowDelegate, or TAB_ALLOW_DELEGATE=1 for tab mcp)', true);
          const hours = Number(args.hours ?? 0);
          let child: Mandate;
          try {
            child = delegateMandate(opts.agent, opts.mandate, {
              agent: String(args.agent ?? ''), budgetUsd: normalizeUsd(String(args.budget ?? '')),
              maxPerCallUsd: args.max_per_call ? normalizeUsd(String(args.max_per_call)) : undefined,
              allow: Array.isArray(args.allow) ? args.allow.map(String) : undefined,
              expiresInMs: hours > 0 ? hours * 3_600_000 : undefined,
            });
          } catch (err) { return text(`cannot delegate: ${(err as Error).message}`, true); }
          if (!/^[A-Za-z0-9_-]{43}$/.test(child.agent)) return text('agent must be a wallet id (base64url public key)', true);
          await opts.onDelegate?.(child);
          return text({ sub_mandate: child, budget: formatAmount(Number(child.budget), currency), expires_at: child.expires_at, note: 'give this JSON to that agent; its spend counts against your mandate too' });
        }
        case 'tab_channel': {
          const action = String(args.action ?? '');
          if (action === 'list') return text({ channels: Object.values(client.channels()) });
          const origin = String(args.origin ?? '').replace(/\/$/, '');
          if (!/^https?:\/\/[^/\s]+$/.test(origin)) return text('origin must look like https://pay.example.com', true);
          try {
            if (action === 'open') {
              usdToMicro(normalizeUsd(String(args.deposit ?? '')));
              return text({ channel: await client.openChannel(origin, normalizeUsd(String(args.deposit))) });
            }
            if (action === 'close') return text(await client.closeChannel(origin));
          } catch (err) {
            if (err instanceof PaymentRefused) return text(`refused before paying: ${err.reason}`, true);
            return text(`channel ${action} failed: ${(err as Error).message}`, true);
          }
          return text('action must be open, list or close', true);
        }
        default:
          return text(`unknown tool: ${name}`, true);
      }
    } catch (err) {
      return text(`error: ${(err as Error).message}`, true);
    }
  }

  return { list: opts.allowDelegate ? TAB_TOOLS : TAB_TOOLS.filter((t) => t.name !== 'tab_delegate'), call };
}
