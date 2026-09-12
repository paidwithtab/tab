<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.png">
    <img src="docs/assets/wordmark-light.png" alt="tab" width="280">
  </picture>
</p>

<h3 align="center">Agents need things. Give them a tab.</h3>

<p align="center">
  Price any HTTP API in a JSON file and get paid per request over <b>HTTP 402</b>.<br>
  Agents spend under <b>signed mandates</b> they can never exceed. Settled in <b>USDC on Robinhood Chain</b>.<br>
  <b>Zero runtime dependencies.</b>
</p>

<p align="center">
  <a href="#try-it-in-60-seconds">Quickstart</a> ·
  <a href="docs/sellers.md">Sell your API</a> ·
  <a href="docs/buyers.md">Give an agent a tab</a> ·
  <a href="SPEC.md">Protocol spec</a> ·
  <a href="DEPLOY.md">Operator's manual</a>
</p>

---

Autonomous agents can already *do* most things. What they can't do is **buy** things. Today that means a human creating accounts, copying API keys, and entering card details for every service an agent might need. tab replaces all of that with one idea:

> **Give an agent a wallet with rules, instead of giving it your wallet.**

The **owner** of the money signs a **mandate** once, offline: a budget, a per-call price cap, a list of allowed sellers, an expiry. The **agent** holds its own key and carries the mandate with every payment. The **gateway** in front of each API enforces the mandate cryptographically. The owner is never online during a payment, and the agent can never spend past what was signed, *no matter what it is told*.

```
 owner ──signs once──▶ mandate ──carried by──▶ agent ──pays per call──▶ gateway ──▶ your API
                                                                          │
                                                              verifies · enforces budget
                                                              settles USDC on Robinhood Chain
```

## Why this and not an API key?

| | API keys + billing | tab mandates |
|---|---|---|
| Onboarding | account, card, key per service | none. Discover, pay, done |
| Spend limit | hope and dashboards | cryptographic: budget, per-call cap, realm allow-list, expiry |
| Who enforces it | the agent's own prompt 🙃 | the seller's gateway, on every request |
| Revocation | rotate keys everywhere | one on-chain revoke, instant |
| Receipts | monthly invoice | signed receipt per request, on-chain ref |
| Settlement | 30-day invoices | USDC per call, only after your API answered 2xx |

A seller is **only paid when they deliver**: the gateway reserves the payment, forwards the request, and broadcasts the settlement transaction *only after the upstream answers 2xx*. Failures always land in the buyer's favor.

## Try it in 60 seconds

```sh
git clone https://github.com/tabprotocol/tab && cd tab
npm install
npm run demo
```

That starts a demo API, a gateway selling its routes, and the catalog with the web UI, with sandbox money already minted:

```sh
curl -i http://127.0.0.1:1402/quote            # → 402 Payment Required + a challenge
npm run cli -- fetch \
  --agent keys/agent-claude.json \
  --mandate keys/mandate-claude.json \
  http://127.0.0.1:1402/quote                  # → pays $0.01, returns the quote + a receipt
```

Open **http://127.0.0.1:1403/** for the site and **http://127.0.0.1:1403/catalog** to search routes, buy with one click, and watch receipts stream in.

## Sell your API

One JSON file prices your routes; one process fronts your upstream. You hold **no payment keys at all**: USDC lands directly at your payout address.

```json
{
  "realm": "api.example.com",
  "recipient": "<your wallet id>",
  "rail": "evm",
  "evm": { "rpc": "${EVM_RPC}", "chain_id": 46630, "token": "${TOKEN}",
           "decimals": 6, "recipient": "${YOUR_0x_ADDRESS}" },
  "upstream": "http://127.0.0.1:8080",
  "routes": [
    { "method": "GET",  "path": "/v1/things/:id", "price": "0.01"  },
    { "method": "POST", "path": "/v1/generate",   "price": "0.002" }
  ]
}
```

```sh
tab serve --spec spec.json --announce https://catalog.example.com
```

Unpriced paths are never proxied. Priced paths answer 402 until paid, then proxy with your upstream credentials injected and the buyer's stripped. → **[docs/sellers.md](docs/sellers.md)**

## Give an agent a tab

```sh
tab key new --out agent.json
tab mandate issue --owner owner.json --agent agent.json \
    --budget 5.00 --window day --max-per-call 0.05 --allow 'api.example.com' --out mandate.json
```

Then let **Claude Code** spend under it. Five MCP tools (`tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`, `tab_limits`), and Claude never sees the owner key:

```sh
claude mcp add tab \
  -e TAB_AGENT=agent.json -e TAB_MANDATE=mandate.json -e TAB_MAX_PER_CALL=0.05 \
  -e TAB_CATALOG=https://catalog.example.com \
  -- npx -y tabprotocol mcp
```

Or from code:

```ts
import { TabClient, receiptOf } from './src/client.js';

const client = new TabClient({ agent, mandate, maxPerCallUsd: '0.05' });
const res = await client.fetch('https://api.example.com/v1/things/42');
console.log(receiptOf(res)?.ref);   // evm:0x..., the settlement tx on Robinhood Chain
```

→ **[docs/buyers.md](docs/buyers.md)**

## How a payment works

1. Agent calls a priced route → gateway answers **402** with a signed challenge (price, recipient, resource, chain parameters; HMAC-bound, single-use).
2. Agent checks the price against its own caps, then signs a **credential** binding the challenge, its mandate, and *the exact request* (query string plus body SHA-256). On the evm rail it also signs the one legal `transferFrom` transaction.
3. Gateway verifies everything in a fixed order ([SPEC §4](SPEC.md#4-verification-order)), reserves budget and funds atomically in SQLite, and forwards to the upstream.
4. On **2xx**: broadcast, confirm, respond with a `Tab-Receipt` (ref = the on-chain tx). On anything else: the response passes through with `Tab-Void`, and **nothing is charged**.

## Trust model, briefly

- **The owner key never travels.** Compromising an agent costs at most the mandate's remaining budget, and on-chain at most the ERC-20 allowance, revocable instantly.
- **The gateway holds no payment keys.** It cannot move more than the agent signed; every transaction field is checked against the challenge the agent accepted.
- **Replay is dead twice over**: single-use challenge ids in the gateway, nonces on the chain. And one signed payment can never back two served calls.
- All of it is hand-written on Node built-ins (Ed25519, keccak-256, secp256k1 + RFC 6979, RLP, EIP-1559, ERC-20, JSON-RPC, MCP) and verified against published test vectors and OpenSSL. `node_modules` holds dev tooling only.

**106 checks stand behind this**, and they are not unit-test theater:

| Suite | Checks | Proves |
|---|---|---|
| `npm test` | 51 | the full 402 flow: gateway, catalog, MCP subprocess, voids, receipts |
| `npm run test:adversarial` | 24 | 150 concurrent calls on a $1.00 budget settle at **exactly 100 paid**; replay pays exactly once; every credential mutation is rejected; SSRF refused; restarts forget nothing |
| `npm run test:evm` | 31 | crypto vectors + OpenSSL cross-checks, a mock EVM node, live reads against Robinhood Chain testnet |

## Project layout

```
src/            gateway, catalog, client, CLI, MCP server, protocol
src/evm/        hand-written keccak-256, secp256k1, RLP, EIP-1559, ERC-20, JSON-RPC
src/rails/      ledger (SQLite sandbox) · evm (USDC on Robinhood Chain)
web/            the site and catalog app: static files, no build step, no CDN
examples/       demo API, spec templates, one-command sandbox
test/           the three suites above
SPEC.md         the protocol, draft 0.3: wire format and verification rules
DEPLOY.md       from a clean VPS to a running gateway, catalog and site
```

## Roadmap

x402 client compatibility · agents as sellers · per-token and metered pricing, payment channels · windowed budgets on-chain · header binding · subscriptions · fee splits · gas sponsorship (EIP-4337).

## License

[MIT](LICENSE). Found a way to break a payment invariant? Report it privately: **[SECURITY.md](SECURITY.md)**.
