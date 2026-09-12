# Quickstart

Everything below runs on your machine with sandbox money. No chain, no faucet, no accounts. When it clicks, [sellers.md](sellers.md) puts tab in front of a real API and [buyers.md](buyers.md) funds a real agent on Robinhood Chain.

## 1. Run the sandbox

```sh
git clone https://github.com/tabprotocol/tab && cd tab
npm install
npm run demo
```

The demo starts three processes and prints their addresses:

| Process | Where | What |
| --- | --- | --- |
| demo API | :4101 | the thing being sold: quotes, echo, a route that always fails |
| gateway | :1402 | prices the API's routes and enforces payment |
| catalog + site | :1403 | search, one-click buying, live receipts |

It also creates `keys/` (an owner, two agents, a seller) and mints $5.00 of sandbox money to the owner. Running it again reuses everything; it is safe to ctrl-C and restart.

## 2. See a price tag

```sh
curl -i http://127.0.0.1:1402/quote
```

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Tab challenge="eyJ2ZXIiOiJ0YWIvMCIs..."
```

That header is the whole storefront: a signed challenge naming the price ($0.01), the seller, the exact resource, and an expiry. Nothing was proxied; unpaid requests never reach the API.

## 3. Pay for it

```sh
npm run cli -- fetch \
  --agent keys/agent-claude.json \
  --mandate keys/mandate-claude.json \
  http://127.0.0.1:1402/quote
```

```
[...] paid 0.01 (ledger:PSIPesjjvD_0qygj)
{"quote":"Talk is cheap. Show me the code. ...","payer":"FIoxEpi..."}
```

What just happened: the client hit the 402, checked the price against the mandate's caps, signed a credential binding that one challenge to that one request, retried, and got the response plus a receipt. The seller's balance went up by exactly $0.01:

```sh
npm run cli -- balance --wallet keys/seller.json --db tab.db
```

## 4. Watch an agent shop

Open **http://127.0.0.1:1403/catalog**. Search finds routes across every announced gateway, cheapest first. The Buy button spends a real (sandbox) mandate held by the catalog's try-it agent, and the receipt feed updates live.

## 5. Let Claude Code spend

The repo ships `.mcp.json` preconfigured for the demo keys. Open Claude Code in this directory and ask it to find and buy a quote; it gets five tools (`tab_limits`, `tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`) and a $1.00/day mandate capped at $0.05 per call. It cannot exceed either number, and it never sees the owner key.

## 6. Break something, on purpose

Try to overspend:

```sh
for i in $(seq 1 200); do
  npm run -s cli -- fetch --agent keys/agent-claude.json \
    --mandate keys/mandate-claude.json http://127.0.0.1:1402/quote > /dev/null
done
```

Somewhere past the mandate's daily budget the calls flip to `402 mandate-exceeded` and stay there until the next UTC day. That refusal is the product.

## Where to next

- Price your own API and get paid: [sellers.md](sellers.md)
- Fund a real agent with USDC on Robinhood Chain: [buyers.md](buyers.md)
- The wire format and verification rules: [SPEC.md](../SPEC.md)
- Production deployment, TLS, systemd: [DEPLOY.md](../DEPLOY.md)
