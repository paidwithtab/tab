<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.png">
    <img src="docs/assets/wordmark-light.png" alt="tab" width="240">
  </picture>
</p>

<h3 align="center">Payments for software agents.</h3>

<p align="center">
  Give agents controlled spending power without giving them your wallet.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/buyers.md">For agents</a> ·
  <a href="docs/sellers.md">For sellers</a> ·
  <a href="SPEC.md">Protocol</a> ·
  <a href="https://x.com/paidwithtab">@paidwithtab</a>
</p>

---

## What is tab?

tab is an open payment protocol for software agents.

It lets an agent discover a paid HTTP service, receive a price, authorize the purchase against rules set by its owner, pay, and receive the result, without requiring a human to create an account, enter a card, or copy an API key.

The core idea is simple:

> **Give an agent a wallet with rules, instead of giving it your wallet.**

Owners define those rules with a signed **mandate**. A mandate can specify:

* total budget
* maximum price per request
* allowed sellers
* expiration
* spending window

The owner signs once. The agent can then transact independently, but it cannot exceed what the owner authorized.

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

## Why tab?

Software agents can already call APIs and use tools. Paying for those services is different.

Today, a human usually has to create an account, enter payment information, generate an API key, configure billing, and hand credentials to the agent. tab replaces that process with an HTTP payment.

```http
Agent → API

HTTP/1.1 402 Payment Required
Price: $0.01
```

```http
Agent → tab → authorized payment

HTTP/1.1 200 OK
Tab-Receipt: evm:0x...
```

* No account creation.
* No card details.
* No shared owner key.
* No unrestricted wallet.

## Mandates

A mandate is a signed spending authorization from an owner to an agent.

```text
Owner authorizes:

Agent             7f2c...
Budget            $25.00
Maximum per call  $0.05
Allowed sellers   api.example.com
Expires           2026-10-01
```

The owner key never needs to be online while the agent is operating. Every payment is independently checked by the seller's gateway against the signed mandate. Changing the agent's prompt cannot increase its authority.

## HTTP 402

tab uses standard HTTP payment semantics. A priced endpoint responds with `402 Payment Required` and a signed challenge describing the purchase. The agent evaluates the price against its mandate and signs a credential for that exact request.

The gateway then:

1. verifies the challenge
2. verifies the mandate
3. verifies the agent
4. verifies the exact request
5. reserves the budget
6. calls the upstream service
7. settles only after a successful response
8. returns a signed receipt

If the upstream service fails, the payment is voided.

## Quickstart

Requires Node.js 22.13 or newer.

```sh
git clone https://github.com/paidwithtab/tab
cd tab

npm install
npm run demo
```

The demo starts a paid API, a tab gateway, a catalog, and a local wallet.

Try the paid endpoint directly:

```sh
curl -i http://127.0.0.1:1402/quote
```

The server responds:

```http
HTTP/1.1 402 Payment Required
```

Now call it through tab:

```sh
npm run cli -- fetch \
  --agent keys/agent-claude.json \
  --mandate keys/mandate-claude.json \
  http://127.0.0.1:1402/quote
```

tab handles the payment and returns the API response with a receipt.

## For API providers

Any HTTP API can become payable with a small JSON specification.

```json
{
  "realm": "api.example.com",
  "recipient": "<wallet>",
  "rail": "evm",
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

The gateway handles payment negotiation, authorization, settlement, receipts, and proxying. Your application continues to serve normal HTTP.

[Read the seller documentation →](docs/sellers.md)

## For agent developers

Create an agent key:

```sh
tab key new --out agent.json
```

Issue it a mandate:

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

The agent can now make purchases within those limits.

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

tab also exposes five MCP tools, so compatible agents can discover and purchase services without receiving the owner's private key:

```text
tab_search
tab_discover
tab_fetch
tab_balance
tab_limits
```

[Read the buyer documentation →](docs/buyers.md)

## Settlement

tab supports USDC settlement on Robinhood Chain. Payments follow a delivery first model.

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

The gateway does not settle the payment until the upstream service successfully responds.

## Security model

tab is designed around bounded authority.

**Owner keys stay offline.** The owner signs the mandate. The agent never receives the owner's private key.

**Agents have explicit limits.** Compromising an agent exposes only the authority granted by its mandate.

**Requests are cryptographically bound.** Credentials commit to the exact request, including its query string and body digest.

**Payments cannot be replayed.** Challenges are single use, and chain settlement provides an additional nonce boundary.

**Gateways do not hold buyer payment keys.** The gateway verifies and broadcasts what the agent authorized. It cannot create arbitrary payments on the agent's behalf.

## Tested against failure

tab currently has 106 automated checks across protocol behavior, adversarial conditions, and EVM settlement.

| Suite | Checks | Coverage |
| --- | --- | --- |
| `npm test` | 51 | Gateway, catalog, MCP, receipts and payment lifecycle |
| `npm run test:adversarial` | 24 | Concurrency, replay, mutation, SSRF and persistence |
| `npm run test:evm` | 31 | Cryptography, EVM transactions and Robinhood Chain |

The concurrency suite includes 150 simultaneous $0.01 requests against a $1.00 mandate. Exactly 100 are allowed to settle.

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

## Repository

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

## Protocol

The protocol specification is maintained in [SPEC.md](SPEC.md).

Current version: Draft 0.3. Wire protocol: `tab/0`.

## Roadmap

Current areas of exploration include x402 compatibility, agents acting as sellers, metered pricing, payment channels, windowed onchain budgets, header binding, subscriptions, fee splits, and gas sponsorship.

## License

MIT. Security issues involving payment invariants should be reported privately using [SECURITY.md](SECURITY.md).
