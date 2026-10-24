<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.png">
    <img src="docs/assets/wordmark-light.png" alt="tab" width="240">
  </picture>
</p>

<h3 align="center">Payments for software agents.</h3>

<p align="center">
  Give an agent a wallet with rules, instead of giving it your wallet.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/spec-draft%200.6-1f6feb?style=flat-square" alt="Spec draft 0.6">
  <img src="https://img.shields.io/badge/wire-tab%2F0-1f6feb?style=flat-square" alt="Wire protocol tab/0">
  <img src="https://img.shields.io/badge/node-22.13%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22.13+">
  <img src="https://img.shields.io/badge/checks-289-2da44e?style=flat-square" alt="289 automated checks">
  <img src="https://img.shields.io/badge/settlement-USDG-2775ca?style=flat-square" alt="USDG settlement">
  <img src="https://img.shields.io/badge/license-MIT-24292f?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <a href="#quickstart"><b>Quickstart</b></a>
  ·
  <a href="https://app.paidwithtab.com"><b>Run a company</b></a>
  ·
  <a href="docs/buyers.md">For agents</a>
  ·
  <a href="docs/sellers.md">For sellers</a>
  ·
  <a href="SPEC.md">Protocol</a>
  ·
  <a href="DEPLOY.md">Deployment</a>
  ·
  <a href="https://x.com/paidwithtab">@paidwithtab</a>
</p>

---

## Contents

[What is tab](#what-is-tab) ·
[Why tab](#why-tab) ·
[Mandates](#mandates) ·
[How a payment works](#how-a-payment-works) ·
[Quickstart](#quickstart) ·
[For API providers](#for-api-providers) ·
[For agent developers](#for-agent-developers) ·
[Companies](#companies) ·
[Settlement](#settlement) ·
[x402](#x402) ·
[Security model](#security-model) ·
[Testing](#testing) ·
[Architecture](#architecture) ·
[Roadmap](#roadmap)

---

## What is tab

tab is an open payment protocol for software agents.

It lets an agent discover a paid HTTP service, receive a price, authorize the purchase against rules set by its owner, pay, and receive the result. No human has to create an account, enter a card, or copy an API key.

Owners define those rules once, in a signed **mandate**:

| Constraint | Purpose |
| --- | --- |
| Total budget | Caps lifetime spend |
| Maximum price per request | Blocks a single expensive call |
| Allowed sellers | Restricts where money can go |
| Spending window | Resets the budget each UTC day, or keeps one lifetime total |
| Expiration | Ends the authority automatically |

The owner signs once. The agent then transacts on its own, and it cannot exceed what the owner authorized.

```text
Owner
  │
  │ signs mandate
  ▼
Agent
  │
  │ HTTP request
  ▼
Gateway ────────► API
  │
  │ verifies mandate
  │ enforces budget
  │ settles payment
  ▼
USDG
```

## Why tab

Software agents can already call APIs and use tools. Paying for those services is the part that still requires a person.

Today a human creates an account, enters payment information, generates an API key, configures billing, and hands credentials to the agent. tab replaces all of that with an HTTP payment.

<table>
<tr><th align="left">Without tab</th><th align="left">With tab</th></tr>
<tr valign="top"><td>

```http
Agent calls API

HTTP/1.1 402 Payment Required
```

Account signup, card on file, API key handoff, billing setup.

</td><td>

```http
Agent pays through tab

HTTP/1.1 200 OK
Tab-Receipt: evm:0x...
```

No account. No card details. No shared owner key. No unrestricted wallet.

</td></tr>
</table>

## Mandates

A mandate is a signed spending authorization from an owner to an agent.

| Field | Example |
| --- | --- |
| Agent | `7f2c...` |
| Budget | `$25.00` |
| Maximum per call | `$0.05` |
| Allowed sellers | `api.example.com` |
| Expires | `2026-10-01` |

The owner key never has to be online while the agent is working. Every payment is checked independently by the seller's gateway against the signed mandate, so changing the agent's prompt cannot increase its authority.

## How a payment works

tab uses standard HTTP payment semantics. A priced endpoint answers with `402 Payment Required` and a signed challenge describing the purchase. The agent checks the price against its mandate and signs a credential bound to that exact request.

The gateway then runs the full lifecycle:

| Step | Action |
| --- | --- |
| 1 | Verify the challenge |
| 2 | Verify the mandate |
| 3 | Verify the agent |
| 4 | Verify the exact request |
| 5 | Reserve the budget |
| 6 | Call the upstream service |
| 7 | Settle only after a successful response |
| 8 | Return a signed receipt |

If the upstream service fails, the payment is voided.

The receipt is signed by a key the gateway publishes, and it binds the whole purchase together: the mandate that allowed it, the exact request the agent signed, a hash of the response body that came back, the seller, and the payment (on Robinhood Chain, the transaction hash). So a receipt proves what was bought, not just that money moved. The client checks it against the bytes it received, and any edit breaks it.

## Quickstart

> **Requires** Node.js 22.13 or newer.

Give an agent a tab in one command:

```sh
npx paidwithtab init
```

This creates an owner key and an agent key in `~/.tab`, signs a mandate ($1.00 per day, $0.05 per call, 90 days), and claims $1.00 of starter credits on the public gateway at `pay.paidwithtab.com`. Nothing to fund, no chain, no API keys.

Those credits buy real things: 8,638 routes across 484 services, from web search, translation and speech to text to block explorers for 42 chains, market data from 20 exchanges, Wikipedia in 48 languages, SEC filings, US Treasury data, genomes, proteins and chemistry, package registries, RDAP and DNS, weather and space weather, between $0.001 and $0.02 a call. The full list with prices is in the [quickstart](docs/quickstart.md#what-the-starter-credits-buy).

**1. Pay for something from the shell.**

```sh
npx paidwithtab fetch "https://pay.paidwithtab.com/wikipedia/api/rest_v1/page/summary/Lisbon"
```

```
paid 0.001 (ledger:cpKKYHocOLKlDW8n)
{"type":"standard","title":"Lisbon", ...}
```

**2. Let Claude Code spend.**

```sh
claude mcp add --scope user tab -- npx -y paidwithtab mcp
```

Then ask Claude for something it needs to pay for, for example "find the weather in Lisbon through tab". It searches the catalog at [paidwithtab.com/catalog](https://paidwithtab.com/catalog), pays per request, and can never exceed the mandate.

**3. See a price tag.**

```sh
curl -i https://pay.paidwithtab.com/fx/latest?base=USD
```

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Tab challenge="eyJ2ZXIiOiJ0YWIvMCIs..."
```

The starter credits are sandbox money on that one gateway. For real money, fund an agent with USDG on Robinhood Chain: [docs/buyers.md](docs/buyers.md).

Want the whole stack on your machine? `git clone https://github.com/paidwithtab/tab && cd tab && npm install && npm run demo` starts a paid API, a gateway, a catalog and a local wallet. **[Full walkthrough](docs/quickstart.md)**

## For API providers

Any HTTP API becomes payable with a small JSON specification. Leave out `rail` to run on sandbox balances while you develop.

```json
{
  "realm": "api.example.com",
  "recipient": "<wallet>",
  "rail": "evm",
  "evm": {
    "rpc": "https://rpc.testnet.chain.robinhood.com",
    "chain_id": 46630,
    "token": "0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5",
    "decimals": 6,                     // the token's decimals, 0 to 18; USDG and USDC have 6
    "recipient": "<your 0x payout address>"
  },
  "upstream": "http://127.0.0.1:8080",
  "routes": [
    { "method": "GET",  "path": "/v1/things/:id", "price": "0.01"  },
    { "method": "POST", "path": "/v1/generate",   "price": "0.002" }
  ]
}
```

Start the gateway:

```sh
tab serve \
  --spec spec.json \
  --announce https://paidwithtab.com
```

The gateway handles payment negotiation, authorization, settlement, receipts, and proxying. Your application keeps serving normal HTTP.

**[Read the seller documentation](docs/sellers.md)**

## For agent developers

**1. Create an agent key.**

```sh
tab key new --out agent.json
```

**2. Issue it a mandate.**

```sh
tab mandate issue \
  --owner owner.json \
  --agent agent.json \
  --budget 5.00 \
  --window day \
  --max-per-call 0.05 \
  --allow 'api.example.com' \
  --out mandate.json
```

**3. Spend within those limits.**

```ts
import { TabClient, receiptOf } from 'paidwithtab/client';

const client = new TabClient({
  agent,
  mandate,
  maxPerCallUsd: '0.05',
});

const url = 'https://api.example.com/v1/things/42';
const res = await client.fetch(url);
const body = new Uint8Array(await res.arrayBuffer());

console.log(receiptOf(res)?.ref);
console.log(await client.verify(url, res, body)); // { ok: true }
```

Or skip the key handling: `npx paidwithtab init` does all three steps and claims starter credits on the public gateway.

tab also exposes five MCP tools, so compatible agents can discover and purchase services without ever receiving the owner's private key:

| Tool | Purpose |
| --- | --- |
| `tab_search` | Find services in a catalog |
| `tab_discover` | Inspect a service and its pricing |
| `tab_fetch` | Make a paid request |
| `tab_balance` | Check remaining budget |
| `tab_limits` | Read the active mandate constraints |

**[Read the buyer documentation](docs/buyers.md)**

Hooking tab into a particular agent, with the MCP JSON for Cursor, Codex, Windsurf and Claude Desktop, framework tools, Python by subprocess, and where keys live in production: **[docs/agents.md](docs/agents.md)**

## Companies

tab 2.2 runs a company of agents on top of the payment layer: `tab company` and the dashboard at [app.paidwithtab.com](https://app.paidwithtab.com). A company has a mission, a budget, agents with roles, and tickets. An agent is Claude, running on the Anthropic API key you add to the company with the five tab tools and nothing else, or any HTTP endpoint you point at (a self-hosted server can also run Claude Code). The difference from a plain agent orchestrator is where the money lives:

- Every run gets its own mandate, signed by the company's owner key and capped at the smallest of the company's remaining budget, the agent's per-run budget and the ticket's cap. The gateway enforces it; the agent cannot exceed it.
- What a run spent is what the gateways booked against that mandate, attributed to the run, the ticket and the company, receipt by receipt. Model cost is booked too. The company warns at 80 percent and pauses at 100.
- Nothing closes without evidence: a receipt id, a URL, a file, the literal output. "Done" without it goes to review.
- Hire, budget, approve, pause and publish are board actions signed with the owner key and verified on every read. Export the key and sign them offline.
- A company can earn: publish the gateway it sells through and its receipts show up as earnings.

The first run takes under a minute and needs no key: sign up and press Start, or run `tab company quickstart`. A starter agent pays $0.002 for two Wikipedia lookups and hands back the answer with both signed receipts.

```sh
tab company serve --host app.example.com          # one process, SQLite, no dependencies
tab company signup --email you@example.com --password ...
tab company quickstart                            # a $1 company; its starter agent pays and answers at once
tab company new --template examples/companies/research.json
tab company model-key --key sk-ant-...            # your Anthropic key, sealed at rest; your agents run on it
tab company fund && tab company status
```

[docs/company.md](docs/company.md) has the packet an agent receives, the result it must return, the adapters, the board log and the server's trust boundary.

## Settlement

tab settles in USDG on Robinhood Chain mainnet and test USDC on its testnet, or in any ERC-20 a gateway chooses to charge in (its prices, challenges and receipts then name that token in `currency`), following a delivery first model. The gateway does not settle a payment until the upstream service has responded successfully.

```text
authorize
    │
    ▼
reserve
    │
    ▼
call API
    │
    ├── failure ──► void
    │
    ▼
success
    │
    ▼
settle
    │
    ▼
receipt
```

## x402

tab speaks [x402](https://github.com/coinbase/x402), the HTTP 402 payment standard that Coinbase started and Cloudflare, Visa and Mastercard build on, in both directions.

**x402 buyers can pay a tab gateway.** On the evm rail, every 402 carries x402 requirements (a `PAYMENT-REQUIRED` header) next to tab's own challenge. An x402 client signs an EIP-3009 transfer of exactly the price to the seller, sends it as `PAYMENT-SIGNATURE`, and gets the response with `PAYMENT-RESPONSE` and a signed tab receipt. The gateway checks the signature, the amount, the recipient and the time window, dry-runs the transfer, calls the upstream, and only then settles the transfer on chain from a small gas wallet of its own (`--x402-settler`). If it does not settle, the response is withheld. The public mainnet gateway takes x402 payments in USDG on Robinhood Chain (`eip155:4663`) today, so all of its routes are open to any x402 agent with no tab software at all.

**tab agents can pay x402 sites.** When a site answers 402 with only x402 requirements, the tab client pays it within the owner's mandate: realm (the site's hostname), per-call cap, budget and expiry, in a token it knows (USDG on Robinhood Chain, USDC on Base). x402 has the payer sign the transfer itself, so the owner funds the agent's own address with a small amount (`tab evm fund --amount 5.00 --token 0x...`), and that balance is a hard ceiling on top of the mandate. The client counts what it signs against the mandate in `x402-spent.json` next to the agent's keys, since an x402 site keeps no tab budget.

A gateway that speaks both is paid the tab way by a tab client, so owners keep custody and the mandate is enforced on both sides.

## Security model

tab is built around bounded authority.

| Property | Guarantee |
| --- | --- |
| **Owner keys stay offline** | The owner signs the mandate. The agent never receives the owner's private key. |
| **Agents have explicit limits** | Compromising an agent exposes only the authority its mandate granted. |
| **Requests are cryptographically bound** | Credentials commit to the exact request, including query string and body digest. |
| **Payments cannot be replayed** | Challenges are single use, and chain settlement adds a nonce boundary. |
| **Gateways hold no buyer keys** | The gateway verifies and broadcasts what the agent authorized. It cannot create payments on its own. |

Security issues involving payment invariants should be reported privately through [SECURITY.md](SECURITY.md).

## Testing

tab currently runs 289 automated checks across protocol behavior, adversarial conditions, EVM settlement and the company orchestrator, plus 28 browser checks of the dashboard.

| Suite | Checks | Coverage |
| --- | :---: | --- |
| `npm test` | 81 | Gateway, catalog, MCP, receipts, payment lifecycle, starter credits, `tab init`, body rules, spend by mandate, catalog health and stale serving |
| `npm run test:adversarial` | 48 | Concurrency, replay, mutation, SSRF, persistence, body smuggling, forged and tampered receipts |
| `npm run test:evm` | 59 | Cryptography, EVM transactions, Robinhood Chain, x402 both ways |
| `npm run test:company` | 101 | Accounts and the trust boundary, runs that pay at a real gateway, evidence and verified receipts, budgets, the signed board log, sealed model keys, the claude adapter against a scripted Messages API, claude-code through a fake binary |
| `npm run test:dashboard` | 28 | The dashboard in a real browser (Playwright, `npx playwright install chromium` once): sign up, the quickstart's starter agent paying and answering, found from a template, add a model key, claim credits, a ticket runs to done, evidence and run log, log out; `--live` also loads the public site and app |

> The concurrency suite fires 150 simultaneous $0.01 requests at a $1.00 mandate. Exactly 100 settle.

## Architecture

```text
                        ┌─────────────┐
                        │    Owner    │
                        └──────┬──────┘
                               │
                         signed mandate
                               │
                               ▼
┌─────────────┐        ┌─────────────┐
│   Catalog   │◄──────►│    Agent    │
└─────────────┘        └──────┬──────┘
                              │
                         HTTP + payment
                              │
                              ▼
                       ┌─────────────┐
                       │ tab Gateway │
                       └──────┬──────┘
                              │
                     verify + authorize
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          ┌──────────┐                ┌──────────┐
          │   API    │                │   USDG   │
          └──────────┘                └──────────┘
```

<details>
<summary><b>Repository layout</b></summary>

```text
src/          protocol, gateway, catalog, client, CLI and MCP
src/tools.ts  the five tab tools, shared by the MCP server and the company's claude adapter
src/company/  the company orchestrator: store, engine, adapters, model (the Messages API loop), secrets, packet, board, server
src/evm/      EVM cryptography, transactions and JSON RPC
src/rails/    sandbox and EVM settlement rails
web/          site, catalog and the company dashboard
examples/     demos, example specifications and company templates
test/         protocol, adversarial, EVM and company tests

SPEC.md       protocol specification
DEPLOY.md     deployment and operations
```

</details>

## Protocol

The specification lives in [SPEC.md](SPEC.md).

**Current version:** Draft 0.6 · **Wire protocol:** `tab/0`, and x402 version 2

## Roadmap

Areas currently under exploration:

- Metered pricing and payment channels
- Windowed onchain budgets
- Header binding and subscriptions
- Fee splits and gas sponsorship

## License

MIT. See [LICENSE](LICENSE).

<p align="center">
  <sub>
    <a href="SPEC.md">Protocol</a> ·
    <a href="docs/buyers.md">Buyers</a> ·
    <a href="docs/agents.md">Agents</a> ·
    <a href="docs/sellers.md">Sellers</a> ·
    <a href="DEPLOY.md">Deploy</a> ·
    <a href="SECURITY.md">Security</a> ·
    <a href="https://x.com/paidwithtab">@paidwithtab</a>
  </sub>
</p>
