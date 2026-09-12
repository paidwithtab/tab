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
  <img src="https://img.shields.io/badge/spec-draft%200.3-1f6feb?style=flat-square" alt="Spec draft 0.3">
  <img src="https://img.shields.io/badge/wire-tab%2F0-1f6feb?style=flat-square" alt="Wire protocol tab/0">
  <img src="https://img.shields.io/badge/node-22.13%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 22.13+">
  <img src="https://img.shields.io/badge/checks-106-2da44e?style=flat-square" alt="106 automated checks">
  <img src="https://img.shields.io/badge/settlement-USDC-2775ca?style=flat-square" alt="USDC settlement">
  <img src="https://img.shields.io/badge/license-MIT-24292f?style=flat-square" alt="MIT license">
</p>

<p align="center">
  <a href="#quickstart"><b>Quickstart</b></a>
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
[Settlement](#settlement) ·
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
USDC
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

## Quickstart

> **Requires** Node.js 22.13 or newer.

```sh
git clone https://github.com/paidwithtab/tab
cd tab

npm install
npm run demo
```

The demo starts a paid API, a tab gateway, a catalog, and a local wallet.

**1. Call the paid endpoint directly.**

```sh
curl -i http://127.0.0.1:1402/quote
```

The server answers with a signed challenge:

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Tab challenge="eyJ2ZXIiOiJ0YWIvMCIs..."
```

**2. Call it through tab.**

```sh
npm run cli -- fetch \
  --agent keys/agent-claude.json \
  --mandate keys/mandate-claude.json \
  http://127.0.0.1:1402/quote
```

tab handles the payment and returns the API response together with a receipt.

**[Full walkthrough](docs/quickstart.md)**

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
    "decimals": 6,
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
  --announce https://catalog.example.com
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
import { TabClient, receiptOf } from './src/client.js';

const client = new TabClient({
  agent,
  mandate,
  maxPerCallUsd: '0.05',
});

const res = await client.fetch('https://api.example.com/v1/things/42');

console.log(receiptOf(res)?.ref);
```

tab also exposes five MCP tools, so compatible agents can discover and purchase services without ever receiving the owner's private key:

| Tool | Purpose |
| --- | --- |
| `tab_search` | Find services in a catalog |
| `tab_discover` | Inspect a service and its pricing |
| `tab_fetch` | Make a paid request |
| `tab_balance` | Check remaining budget |
| `tab_limits` | Read the active mandate constraints |

**[Read the buyer documentation](docs/buyers.md)**

## Settlement

tab supports USDC settlement on Robinhood Chain, following a delivery first model. The gateway does not settle a payment until the upstream service has responded successfully.

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

tab currently runs 106 automated checks across protocol behavior, adversarial conditions, and EVM settlement.

| Suite | Checks | Coverage |
| --- | :---: | --- |
| `npm test` | 51 | Gateway, catalog, MCP, receipts, payment lifecycle |
| `npm run test:adversarial` | 24 | Concurrency, replay, mutation, SSRF, persistence |
| `npm run test:evm` | 31 | Cryptography, EVM transactions, Robinhood Chain |

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
          │   API    │                │   USDC   │
          └──────────┘                └──────────┘
```

<details>
<summary><b>Repository layout</b></summary>

```text
src/          protocol, gateway, catalog, client, CLI and MCP
src/evm/      EVM cryptography, transactions and JSON RPC
src/rails/    sandbox and EVM settlement rails
web/          site and catalog
examples/     demos and example specifications
test/         protocol, adversarial and EVM tests

SPEC.md       protocol specification
DEPLOY.md     deployment and operations
```

</details>

## Protocol

The specification lives in [SPEC.md](SPEC.md).

**Current version:** Draft 0.3 · **Wire protocol:** `tab/0`

## Roadmap

Areas currently under exploration:

- x402 compatibility
- Agents acting as sellers
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
    <a href="docs/sellers.md">Sellers</a> ·
    <a href="DEPLOY.md">Deploy</a> ·
    <a href="SECURITY.md">Security</a> ·
    <a href="https://x.com/paidwithtab">@paidwithtab</a>
  </sub>
</p>
