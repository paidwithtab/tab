# tab

**A payment gateway for software agents.** Put it in front of any HTTP API, price the routes in a JSON spec, and callers pay per request with HTTP 402.

The idea that makes it different from x402 and similar schemes: the spending limit is a **mandate** — a signed object the owner of the money issues once (budget, per-call cap, allowed realms, expiry). The agent holds its own key and carries the mandate with every payment. The gateway enforces the budget, so the owner is never online during a payment and the agent can never exceed what was signed, no matter what it is told.

```
owner ──signs once──▶ mandate ──carried by──▶ agent ──pays per call──▶ gateway ──▶ your API
                                                                        │
                                                                 enforces budget,
                                                              settles on a rail
```

- **Zero runtime dependencies.** Ed25519, SHA-256, HMAC, base58, SPL instruction encoding, JSON-RPC and the MCP server are hand-written on Node ≥ 22.13 built-ins (including `node:sqlite`).
- **Three rails.** `ledger` (sandbox balances in SQLite, instant, free), `solana` (USDC via SPL delegation, the gateway co-signs as fee payer), and `evm` — USDC on **Robinhood Chain** (or any EVM chain): the owner `approve`s the agent once, the agent signs each `transferFrom`, the gateway verifies it field-for-field and broadcasts only after your API answered 2xx. No custom program or contract on either chain.
- **A catalog** with search and a web front end, so buyers can find priced routes.
- **An MCP server**, so Claude Code can spend under a mandate it can never exceed.

## Try it in one command

```sh
npm install
npm run demo        # keys, sandbox money, demo API :4101, gateway :1402, catalog + UI :1403
```

Then open http://127.0.0.1:1403/ (landing page) or http://127.0.0.1:1403/catalog (search, buy, receipts), or pay from the command line:

```sh
npm run cli -- fetch --agent keys/agent-claude.json --mandate keys/mandate-claude.json http://127.0.0.1:1402/quote
```

`npm test` runs 51 end-to-end checks in-process; `npm run test:adversarial` runs 24 hostile checks (replay, concurrency exactness, request mutation, mandate forgery, catalog SSRF); `npm run test:solana` runs 26 on-chain checks against a local validator (`npm run demo:solana` starts one); `npm run test:evm` runs 31 checks for the Robinhood Chain rail (crypto vectors, a mock EVM node, live testnet reads).

## Documents

- [`SPEC.md`](SPEC.md) — the protocol: wire format, verification order, rails. Draft 0.
- [`DEPLOY.md`](DEPLOY.md) — the operator's manual: clean VPS to running gateway, catalog and front end.

## Roadmap

x402 client compatibility · agents as sellers · per-token and metered pricing, payment channels · windowed budgets on-chain · header binding · subscriptions · fee splits · Token-2022.
