# Give an agent a tab

This guide takes you from nothing to an agent that can discover APIs, pay for them in USDG on Robinhood Chain, and prove what it bought, while being cryptographically unable to spend past the limits you set.

## The fast path

```sh
claude mcp add --scope user tab -- npx -y https://github.com/paidwithtab/tab/releases/latest/download/paidwithtab.tgz mcp
```

That is all Claude Code needs: on first launch the MCP server sets itself up. From a shell, `tab init` does the same and prints what it made. Either way, one command creates the keys below, signs a mandate, and claims $1.00 of starter credits on the public gateway. Those credits are sandbox money that only spends on `pay.paidwithtab.com`. The rest of this guide is the real-money path: USDG on Robinhood Chain, where the same keys and the same mandate work unchanged.

## The three keys, and who holds what

| Key | Held by | Grants |
| --- | --- | --- |
| owner | you, ideally offline | signing mandates; moving your funds |
| agent | the agent's environment | spending, but only within a mandate |
| mandate (not a key, a signed grant) | travels with the agent | budget, per-call cap, allowed sellers, expiry |

The agent never touches the owner key. If an agent key leaks, the damage ceiling is the mandate's remaining budget, and on-chain at most the token allowance, which you can revoke in one transaction.

## 1. Keys

```sh
npm i -g https://github.com/paidwithtab/tab/releases/latest/download/paidwithtab.tgz   # once; the command is tab
tab key new --out owner.json
tab key new --out agent.json
```

One key file carries two identities: the wallet id used by the protocol, and an address on Robinhood Chain (`tab evm address owner.json`).

## 2. Fund the owner

**Testnet first, it is free.** Chain id 46630, test USDC at `0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5`, explorer at explorer.testnet.chain.robinhood.com.

1. Get testnet ETH for the owner address. The official faucet is https://faucet.testnet.chain.robinhood.com/ and needs nothing but the address; third-party faucets (QuickNode, Alchemy) want a small ETH balance and some history on Ethereum mainnet first. If the official site rate-limits you, try it from a phone on mobile data.
2. The test dollar is open-mint. From a clone of the repo, `npx tsx scripts/evm-mint.ts owner.json 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5 5.00` mints $5.00 to the owner.
3. Give the agent a little gas. The agent's account sends the payment transactions, so it needs a sliver of ETH:

```sh
tab evm fund --from owner.json --to agent.json --eth 0.002
```

**Mainnet, when you mean it.** Chain id 4663. The dollar is USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, explorer at robinhoodchain.blockscout.com. Send a little ETH for gas and the USDG you intend to spend to the owner address from the Robinhood app, choosing Robinhood Chain as the network, or bridge from Ethereum through the canonical Arbitrum bridge. Add `--rpc https://rpc.mainnet.chain.robinhood.com` to every `evm` command below and use the USDG address as the token. Once real money is at the owner address, keep that key off any server.

No testnet funds yet? Everything below also works on the free `ledger` rail; run the [quickstart](quickstart.md) sandbox instead and come back.

## 3. The mandate: sign the rules once

```sh
tab mandate issue --owner owner.json --agent agent.json \
  --budget 5.00 --window day --max-per-call 0.05 \
  --allow 'testnet.paidwithtab.com' --allow 'mainnet.paidwithtab.com' \
  --days 90 --out mandate.json
```

Read that back as a sentence: *this agent may spend up to $5.00 per UTC day, at most $0.05 per call, only at these sellers, until this date.* The mandate embeds your owner address (signed), so payments can only draw from your account. It is not a secret, but it grants spending, so treat the file with respect.

Then the on-chain half, an ERC-20 allowance matching what you are comfortable with:

```sh
tab evm approve --owner owner.json --agent agent.json \
  --amount 5.00 --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5
```

Two ceilings now protect you: the gateway enforces the mandate, the chain enforces the allowance. Ending it all takes one command:

```sh
tab evm revoke --owner owner.json --agent agent.json --token 0x5B6C...26f5
```

## 4. Spend

**From the command line:**

```sh
tab fetch --agent agent.json --mandate mandate.json \
  https://testnet.paidwithtab.com/wikipedia/api/rest_v1/page/summary/HTTP_402
```

Exit codes: 0 paid and served, 1 the API answered non-2xx (you were not charged), 2 the client refused before paying.

**From Claude Code**, via the built-in MCP server:

```sh
claude mcp add tab \
  -e TAB_AGENT=$PWD/agent.json -e TAB_MANDATE=$PWD/mandate.json \
  -e TAB_MAX_PER_CALL=0.05 -e TAB_CATALOG=https://paidwithtab.com \
  -- npx -y https://github.com/paidwithtab/tab/releases/latest/download/paidwithtab.tgz mcp
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
tab evm balance --wallet owner.json \
  --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5 --agent agent.json
```

That prints your dollars, your ETH, and exactly how much allowance the agent has left.

### Proof of what it bought (3.1)

`tab fetch` and the MCP server keep every paid response in `~/.tab/receipts/` (set `TAB_PROOFS` to another folder, or `off`). Each folder holds the body, the signed receipt, the request and the mandate, and anyone can check it:

```sh
tab receipts
tab verify ~/.tab/receipts/2026-11-06T13-33-32-516Z-QZt2SKGkEUN9
```

```
pay.paidwithtab.com /wikipedia/api/rest_v1/page/summary/HTTP_402: $0.001 at 2026-11-06T13:33:32.516Z (ledger:QZt2SKGkEUN94c4Z)
  ok   gateway signature    key YyKjgMBzQLgPkqo36vmPuSeKpcsxUj8CfwMUKZ2jyt4
  ok   gateway key          pay.paidwithtab.com publishes this key
  ok   response body        2564 bytes, SHA-256 2S9XKcTXHe6FQ_UdVyaIP0WLxDDmWJuY5miWuooa0Zs
  ok   response status      HTTP 200
  ok   request              GET https://pay.paidwithtab.com/wikipedia/api/rest_v1/page/summary/HTTP_402
  ok   agent authorization  signed by agent GYzcfwu2kSFQJeQnTRQRtSZGjUxV0Xvc34iNge3EvMQ
  ok   mandate              owner idWAp7Whj0Hx9fqWrRmieurZGGaXUZe28Ze7j8EFV9U signed it for this agent
proof holds
```

Change one byte of the body, the receipt or the request and it fails. What it cannot show is that the upstream API wrote the body: the gateway signs what it relayed (SPEC.md §9).

### Hear about spending (3.1)

```sh
tab alerts set --ntfy --at 50,90,100 --daily
```

The gateway posts when one of your agents reaches 50, 90 and 100 percent of its budget in a window, and once a day a statement of what your agents paid there. `--ntfy` makes a private ntfy.sh topic: install the ntfy app, subscribe to the topic it prints, and the alerts land on your phone with no account anywhere. Or give `--url` any https webhook and get JSON. `tab alerts off` stops them.

## Spend less, and see where it went (3.2)

**The cache.** The same GET inside ten minutes is answered from the proof of the first purchase, for nothing, and that proof still verifies. A seller's `Cache-Control: max-age` sets a different window and `no-store` turns it off for that route. Other methods are reused only when the seller marks the answer with `max-age`, since a repeated POST may be meant to act twice. Pass `fresh: true` to `tab_fetch` to pay for a new answer, or set `TAB_CACHE_TTL` (seconds, or `off`).

**Cost per task.** Each paid call is tagged with what the agent was working on: `TAB_TASK` if you set it, a `task` argument to `tab_fetch`, or else the git repository and branch the agent runs in (`tab@fix-login`).

```sh
tab cost --by task          # or day, realm, route; --since 2026-11-01
```

```
task                 calls       spent  cached       saved
tab@fix-login           41      $0.087      12      $0.031
TICKET-42                6      $0.018       0       $0.00
total                   47      $0.105      12      $0.031
```

The agent can ask the same with `tab_cost`, and price a plan before running it with `tab_estimate` (it asks each URL its price without paying).

**The cheapest seller that works.** `tab_search` ranks routes that have been working first, then by price (`sort: "cheapest"` or `"reliable"` to choose). When a seller fails, nothing is charged and `tab_fetch` answers with `alternatives` that do the same job.

**x402 sellers.** Search also returns x402 APIs (`kind: "x402"`), about 33,000 routes from 3,200 sellers that take USDC on Base. The agent pays them from its own address within the same mandate: fund it with a few dollars of USDC on Base.

```sh
tab evm address ~/.tab/agent.json        # the agent's 0x address, the same on every chain
```

Send USDC on Base to that address (from an exchange or a wallet). The mandate's budget, per-call cap and rules still bound every payment, counted by the client.

## Rules in the mandate (3.2)

A mandate can say which routes the agent may pay for and when:

```sh
tab mandate issue --owner owner.json --agent agent.json --budget 1.00 --window day \
  --paths "/search*" --paths "GET /wikipedia/*" --hours "mon-fri 9-17" --out mandate.json
```

A path glob that starts with `/` matches the route's path; with a method in front it matches that method only. Hours are UTC. The rules are signed into the mandate, so gateways enforce them, and the client refuses before signing, x402 sites included. A sub-mandate can only narrow them. Gateways older than 3.2 refuse a mandate with rules rather than ignore them.

## Check that nothing was rewritten (3.2)

Every receipt a 3.2 gateway signs goes into its public log, a Merkle tree whose head it signs. `tab verify` (with no folder it checks your latest purchase) now also confirms the receipt is in that log, and:

```sh
tab log check --gateway https://pay.paidwithtab.com
```

keeps the head it saw and, next time, proves the log only grew: nothing already logged was dropped or changed. Run it from cron if you want a watchman.

## Add credit by card (3.2)

On a gateway that takes card top-ups:

```sh
tab topup 5
```

prints a Stripe payment page and waits; when the payment completes, the owner wallet holds the credit. No card data reaches tab.

## Paying in a gateway's own token

Some gateways charge in a token instead of dollars. The discovery document, every 402 and every receipt say so in `currency`, and the catalog shows such prices as `0.001 TTT` rather than `$0.001`. tab's own reference deployment runs one at `token-testnet.paidwithtab.com`: the same routes as the testnet gateway, priced in TTT, an open-mint test token with 18 decimals on Robinhood Chain testnet (`0x8f6fe411e76b79d6eb6521872340c37c3210ee47`).

The flow is the dollar flow with three differences. Mint or buy the token instead of USDC; the mint script reads the token's decimals, so amounts are whole tokens:

```sh
npx tsx scripts/evm-mint.ts owner.json 0x8f6fe411e76b79d6eb6521872340c37c3210ee47 5.00
tab evm approve --owner owner.json --agent agent.json --amount 2.00 --token 0x8f6fe411e76b79d6eb6521872340c37c3210ee47
```

Issue that agent a mandate of its own, because a mandate's budget and cap are amounts of whatever the gateway charges in: `--budget 2.00` means two tokens on this realm and two dollars on a dollar realm. Keep the two apart with `--allow`:

```sh
tab mandate issue --owner owner.json --agent agent.json \
  --budget 2.00 --window day --max-per-call 0.05 --allow token-testnet.paidwithtab.com --days 30 --out mandate-ttt.json
```

And tell the client which currency it may pay in. By default it pays in USD and refuses anything else before signing, so a stray token-priced route can never spend a dollar mandate:

```sh
tab fetch --agent agent.json --mandate mandate-ttt.json --currency TTT \
  https://token-testnet.paidwithtab.com/wikipedia/api/rest_v1/page/summary/HTTP_402
```

```
paid 0.001 TTT (evm:0x1b3ee3a1…)
```

In code that is `new TabClient({ agent, mandate, currency: 'TTT' })`; for the MCP server set `TAB_CURRENCY=TTT`, and `tab_search` then returns only routes in that currency when given a price ceiling.

## Running several agents

Issue each agent its own key, its own mandate, and its own allowance from the same owner account:

```
research agent    $10/day, max $0.02/call, allow *.data-sellers.com
coding agent      $25/day, max $0.10/call, allow mainnet.paidwithtab.com
scraper           $1/day,  max $0.005/call, allow *
```

Budgets are per mandate, so one agent exhausting its tab never touches another's. [agents.md](agents.md) covers wiring each of those agents up and where their keys should live.

## After the mandate is signed (3.0)

**Revoke it.** A mandate you no longer trust dies at every gateway that hears about it, along with every sub-mandate under it:

```sh
tab mandate revoke --key owner.json --mandate mandate.json --reason "laptop lost" \
  --gateway https://pay.paidwithtab.com --gateway https://mainnet.paidwithtab.com
tab mandate status --mandate mandate.json --gateway https://pay.paidwithtab.com
```

Gateways started with `--peer` pass revocations on and poll each other every few seconds, so naming one of them is enough. On the evm rail a revocation binds gateways, not the chain: the agent's ERC-20 allowance is the hard cap, and an agent key with an allowance can move money without any gateway. Zero it in the same step:

```sh
tab mandate revoke --key owner.json --mandate mandate.json --gateway https://mainnet.paidwithtab.com \
  --token 0x5fc5360d0400a0fd4f2af552add042d716f1d168 --evm-agent agent.json
```

**Let an agent hire help.** An agent with a mandate can sign a narrower one for another agent key. Every limit stays inside its own (budget, per call cap, allowed sellers, expiry, approval threshold), and whatever the helper spends counts against the parent too, so two helpers together can never spend more than the parent allows:

```sh
tab mandate delegate --agent-key agent.json --mandate mandate.json --to helper.json --budget 0.25 --out helper-mandate.json
```

Chains stop three delegations below you. Revoking the parent kills the helper's mandate with it.

**Approve the big ones.** Issue the mandate with `--approve-above 0.50` and any payment over fifty cents waits for you. The agent's `tab fetch` stops with exit code 3 and writes the request it needs approved; you sign it and hand it to the gateway, and the agent's retry of the same call pays, once:

```sh
tab mandate approve --owner owner.json --request ~/.tab/approval-request-XXXX.json --gateway https://pay.paidwithtab.com
```

`tab fetch --wait-approval 300` waits for you instead of stopping. An approval covers exactly one call (the same route, query, body and amount) for at most an hour.

**Pay on delivery.** Routes that offer it (discovery marks them `escrow`) hold your payment until the seller delivers, and give it back if it does not by the deadline:

```sh
tab fetch --escrow --wait 300 -X POST -d '{"topic":"Lisbon"}' https://seller.example.com/jobs/essay
```

The result comes with a delivery receipt that binds your request to what was delivered. Without `--wait`, the command prints how to follow the order (`tab escrow status <url> --token <token>`).

**Open a tab at one gateway.** For many small calls at one gateway, open a payment channel: one deposit, then every call is a signed voucher with no transaction, settled once when you close it. Metered routes charge per unit (tokens, seconds), so a call can cost a fraction of a cent:

```sh
tab channel open --gateway https://pay.example.com --deposit 1.00
tab fetch --channel https://pay.example.com/model/complete?tokens=1200
tab channel list
tab channel close --gateway https://pay.example.com
```

The deposit counts against the mandate while the channel is open; closing it gives back what was not spent.
