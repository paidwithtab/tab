# Give an agent a tab

This guide takes you from nothing to an agent that can discover APIs, pay for them in USDG on Robinhood Chain, and prove what it bought, while being cryptographically unable to spend past the limits you set.

## The fast path

```sh
npx paidwithtab init
```

One command creates the keys below, signs a mandate, and claims $1.00 of starter credits on the public gateway. Those credits are sandbox money that only spends on `pay.paidwithtab.com`. The rest of this guide is the real-money path: USDG on Robinhood Chain, where the same keys and the same mandate work unchanged.

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

## 2. Fund the owner

**Testnet first, it is free.** Chain id 46630, test USDC at `0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5`, explorer at explorer.testnet.chain.robinhood.com.

1. Get testnet ETH for the owner address. The official faucet is https://faucet.testnet.chain.robinhood.com/ and needs nothing but the address; third-party faucets (QuickNode, Alchemy) want a small ETH balance and some history on Ethereum mainnet first. If the official site rate-limits you, try it from a phone on mobile data.
2. The test dollar is open-mint. From a clone of the repo, `npx tsx scripts/evm-mint.ts owner.json 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5 5.00` mints $5.00 to the owner.
3. Give the agent a little gas. The agent's account sends the payment transactions, so it needs a sliver of ETH:

```sh
npx paidwithtab evm fund --from owner.json --to agent.json --eth 0.002
```

**Mainnet, when you mean it.** Chain id 4663. The dollar is USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, explorer at robinhoodchain.blockscout.com. Send a little ETH for gas and the USDG you intend to spend to the owner address from the Robinhood app, choosing Robinhood Chain as the network, or bridge from Ethereum through the canonical Arbitrum bridge. Add `--rpc https://rpc.mainnet.chain.robinhood.com` to every `evm` command below and use the USDG address as the token. Once real money is at the owner address, keep that key off any server.

No testnet funds yet? Everything below also works on the free `ledger` rail; run the [quickstart](quickstart.md) sandbox instead and come back.

## 3. The mandate: sign the rules once

```sh
npx paidwithtab mandate issue --owner owner.json --agent agent.json \
  --budget 5.00 --window day --max-per-call 0.05 \
  --allow 'testnet.paidwithtab.com' --allow 'mainnet.paidwithtab.com' \
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
  https://testnet.paidwithtab.com/wikipedia/api/rest_v1/page/summary/HTTP_402
```

Exit codes: 0 paid and served, 1 the API answered non-2xx (you were not charged), 2 the client refused before paying.

**From Claude Code**, via the built-in MCP server:

```sh
claude mcp add tab \
  -e TAB_AGENT=$PWD/agent.json -e TAB_MANDATE=$PWD/mandate.json \
  -e TAB_MAX_PER_CALL=0.05 -e TAB_CATALOG=https://paidwithtab.com \
  -- npx -y paidwithtab mcp
```

Claude gets `tab_search` (find routes by keyword and max price), `tab_discover`, `tab_fetch`, `tab_balance`, and `tab_limits`. `TAB_MAX_PER_CALL` is a second, client-side cap on top of the mandate; the model cannot raise either one. The same server works in Cursor, Codex, Windsurf and Claude Desktop; [agents.md](agents.md) has the JSON for each, plus framework tools and Python.

**From your own code:**

```ts
import { TabClient, receiptOf, PaymentRefused } from 'paidwithtab/client';

const client = new TabClient({
  agent, mandate,
  maxPerCallUsd: '0.05',
  onChallenge: (chal, req) => Number(req.amount) <= 20_000,  // your own veto, micro-USD
});
const res = await client.fetch('https://testnet.paidwithtab.com/fx/latest?base=USD');
const receipt = receiptOf(res);   // null if the route was free or the call was voided
```

On a 402 the client checks the price, signs a credential binding that exact request (query string and body digest included), pays, and retries exactly once. `PaymentRefused` is thrown before any money is at risk.

## 5. Trust what happened

Every paid response carries a receipt: amount, resource, payer, and a ref like `evm:0x...` that is the settlement transaction on the Robinhood Chain explorer ([testnet](https://explorer.testnet.chain.robinhood.com), [mainnet](https://robinhoodchain.blockscout.com)). The first mainnet payment through tab is [here](https://robinhoodchain.blockscout.com/tx/0xed2380386cdb99d1597ad544d2cee0798e247ef0d48784b60e78bfc5e2db733d). Check balances any time:

```sh
npx paidwithtab evm balance --wallet owner.json \
  --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5 --agent agent.json
```

That prints your dollars, your ETH, and exactly how much allowance the agent has left.

## Running several agents

Issue each agent its own key, its own mandate, and its own allowance from the same owner account:

```
research agent    $10/day, max $0.02/call, allow *.data-sellers.com
coding agent      $25/day, max $0.10/call, allow mainnet.paidwithtab.com
scraper           $1/day,  max $0.005/call, allow *
```

Budgets are per mandate, so one agent exhausting its tab never touches another's. [agents.md](agents.md) covers wiring each of those agents up and where their keys should live.
