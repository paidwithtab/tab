# Give an agent a tab

This guide takes you from nothing to an agent that can discover APIs, pay for them in USDC on Robinhood Chain, and prove what it bought, while being cryptographically unable to spend past the limits you set.

## The three keys, and who holds what

| Key | Held by | Grants |
| --- | --- | --- |
| owner | you, ideally offline | signing mandates; moving your funds |
| agent | the agent's environment | spending, but only within a mandate |
| mandate (not a key, a signed grant) | travels with the agent | budget, per-call cap, allowed sellers, expiry |

The agent never touches the owner key. If an agent key leaks, the damage ceiling is the mandate's remaining budget, and on-chain at most the token allowance, which you can revoke in one transaction.

## 1. Keys

```sh
npx paidwithtab key new --out owner.json
npx paidwithtab key new --out agent.json
```

One key file carries two identities: the wallet id used by the protocol, and an address on Robinhood Chain (`npx paidwithtab evm address owner.json`).

## 2. Fund the owner (Robinhood Chain testnet)

1. Get testnet ETH for the owner address from the faucet: https://faucet.testnet.chain.robinhood.com/
2. Get testnet USDC (`0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5`) to the same address.
3. Give the agent a little gas. The agent's account sends the payment transactions, so it needs a sliver of ETH:

```sh
npx paidwithtab evm fund --from owner.json --to agent.json --eth 0.005
```

No testnet funds yet? Everything below also works on the free `ledger` rail; run the [quickstart](quickstart.md) sandbox instead and come back.

## 3. The mandate: sign the rules once

```sh
npx paidwithtab mandate issue --owner owner.json --agent agent.json \
  --budget 5.00 --window day --max-per-call 0.05 \
  --allow 'api.example.com' --allow '*.trusted.dev' \
  --days 90 --out mandate.json
```

Read that back as a sentence: *this agent may spend up to $5.00 per UTC day, at most $0.05 per call, only at these sellers, until this date.* The mandate embeds your owner address (signed), so payments can only draw from your account. It is not a secret, but it grants spending, so treat the file with respect.

Then the on-chain half, an ERC-20 allowance matching what you are comfortable with:

```sh
npx paidwithtab evm approve --owner owner.json --agent agent.json \
  --amount 5.00 --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5
```

Two ceilings now protect you: the gateway enforces the mandate, the chain enforces the allowance. Ending it all takes one command:

```sh
npx paidwithtab evm revoke --owner owner.json --agent agent.json --token 0x5B6C...26f5
```

## 4. Spend

**From the command line:**

```sh
npx paidwithtab fetch --agent agent.json --mandate mandate.json \
  https://api.example.com/v1/things/42
```

Exit codes: 0 paid and served, 1 the API answered non-2xx (you were not charged), 2 the client refused before paying.

**From Claude Code**, via the built-in MCP server:

```sh
claude mcp add tab \
  -e TAB_AGENT=$PWD/agent.json -e TAB_MANDATE=$PWD/mandate.json \
  -e TAB_MAX_PER_CALL=0.05 -e TAB_CATALOG=https://catalog.example.com \
  -- npx -y paidwithtab mcp
```

Claude gets `tab_search` (find routes by keyword and max price), `tab_discover`, `tab_fetch`, `tab_balance`, and `tab_limits`. `TAB_MAX_PER_CALL` is a second, client-side cap on top of the mandate; the model cannot raise either one.

**From your own code:**

```ts
import { TabClient, receiptOf, PaymentRefused } from './src/client.js';

const client = new TabClient({
  agent, mandate,
  maxPerCallUsd: '0.05',
  onChallenge: (chal, req) => Number(req.amount) <= 20_000,  // your own veto, micro-USD
});
const res = await client.fetch('https://api.example.com/v1/things/42');
const receipt = receiptOf(res);   // null if the route was free or the call was voided
```

On a 402 the client checks the price, signs a credential binding that exact request (query string and body digest included), pays, and retries exactly once. `PaymentRefused` is thrown before any money is at risk.

## 5. Trust what happened

Every paid response carries a receipt: amount, resource, payer, and a ref like `evm:0x...` that is the settlement transaction on the [Robinhood Chain explorer](https://explorer.testnet.chain.robinhood.com). Check balances any time:

```sh
npx paidwithtab evm balance --wallet owner.json \
  --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5 --agent agent.json
```

That prints your USDC, your ETH, and exactly how much allowance the agent has left.

## Running several agents

Issue each agent its own key, its own mandate, and its own allowance from the same owner account:

```
research agent    $10/day, max $0.02/call, allow *.data-sellers.com
coding agent      $25/day, max $0.10/call, allow api.example.com
scraper           $1/day,  max $0.005/call, allow *
```

Budgets are per mandate, so one agent exhausting its tab never touches another's.
