# Sell your API

You have an HTTP API. tab puts a price tag on it and collects per request, in USDG on Robinhood Chain, with no accounts, no billing code, and no payment keys on your server.

## What you are setting up

```
buyers ──▶ your gateway (tab serve) ──▶ your existing API
                 │
        402 until paid, then proxy
        USDG ──▶ your payout address
```

The gateway is a reverse proxy you run next to your API. It answers 402 with a signed challenge until a request is paid, verifies the payment, forwards the request, and broadcasts the settlement only after your API answers 2xx. If your API errors, the buyer is not charged. You are only paid when you deliver, and buyers can verify that property in [SPEC.md](../SPEC.md) rather than take your word for it.

## 1. Keys and addresses

```sh
npx paidwithtab key new --out seller.json     # your wallet id (keep the file safe)
npx paidwithtab evm address seller.json       # your 0x payout address on Robinhood Chain
```

The gateway itself holds neither file. Only the public wallet id and the payout address go in the spec.

## 2. Price your routes

`spec.json`:

```json
{
  "realm": "api.example.com",
  "recipient": "<publicKey from seller.json>",
  "rail": "evm",
  "evm": {
    "rpc": "https://rpc.testnet.chain.robinhood.com",
    "chain_id": 46630,
    "token": "0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5",
    "decimals": 6,
    "recipient": "<your 0x payout address>",
    "explorer": "https://explorer.testnet.chain.robinhood.com"
  },
  "public_receipts": true,
  "services": [
    {
      "name": "myapi",
      "prefix": "",
      "upstream": "http://127.0.0.1:8080",
      "upstream_headers": { "Authorization": "Bearer ${MY_INTERNAL_TOKEN}" },
      "routes": [
        { "method": "GET",  "path": "/v1/things/:id", "price": "0.01",  "description": "One thing" },
        { "method": "POST", "path": "/v1/generate",   "price": "0.002", "description": "Generate" },
        { "method": "GET",  "path": "/healthz",       "price": "0",     "description": "Free" }
      ]
    }
  ]
}
```

The rules that matter:

- `realm` is the name mandates allow-list against. Use your public hostname.
- Paths support `:param` segments. A price of `"0"` means free and proxied; paths with no priced route return 404 and are never proxied.
- `upstream_headers` are injected on the way through and the buyer's `Authorization` is stripped, so buyers never see your internal credentials and your API never sees theirs.
- `${UPPER_CASE}` in the spec is expanded from the environment at load time. Keep secrets in an env file, not the spec.
- `requires: ["MY_INTERNAL_TOKEN"]` on a service lists the variables it cannot run without. If one is unset at start, the gateway skips that service and logs it, rather than listing routes that would fail upstream.
- `public_receipts: true` exposes your last 200 receipts, which the catalog's live feed reads. Turn it off if payer wallet ids should stay private.
- For chain ids, RPC endpoints and the mainnet USDG address, see [DEPLOY.md section 9](../DEPLOY.md).

## 3. Serve

```sh
npx paidwithtab serve --spec spec.json \
  --announce https://paidwithtab.com \
  --origin https://api.example.com
```

`--announce` registers you with a catalog so agents can find your routes; `--origin` is the public URL buyers will call. The gateway gives your API 60 seconds to answer; when the work behind a route takes longer (a report your agents write, say), raise it with `--upstream-timeout 300`. The buyer is charged only once the answer arrives. State lives in one SQLite file next to the process. Production hardening (systemd, nginx or Caddy with TLS, firewalling, backups) is [DEPLOY.md section 8](../DEPLOY.md); the short version is: put TLS in front, keep the raw port off the internet.

## 4. Verify you get paid

```sh
curl -s https://api.example.com/.well-known/tab | jq .routes   # your price list, machine readable
curl -si https://api.example.com/v1/things/42 | head -3        # 402 + challenge
npx paidwithtab evm balance --wallet seller.json \
  --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5           # USDC arriving per call
```

Every paid call also returns the buyer a `Tab-Receipt` whose ref is the settlement transaction; your payout address is visible on the [Robinhood Chain explorer](https://explorer.testnet.chain.robinhood.com).

## Take x402 payments too

On the evm rail with a token that implements EIP-3009 (USDG on Robinhood Chain does), the same gateway can be paid by any [x402](https://github.com/coinbase/x402) client, which reaches the agents and wallets built on Coinbase's standard without them installing anything. Add the token's EIP-712 domain to the spec and give the gateway a small gas wallet that settles the transfers:

```json
"evm": { "...": "...", "eip712": { "name": "Global Dollar", "version": "1" } }
```

```sh
npx paidwithtab key new --out settler.json      # fund its 0x address with about 0.0004 ETH
npx paidwithtab serve --spec spec.json --origin https://pay.example.com --x402-settler settler.json
```

Every 402 then carries x402 requirements next to the tab challenge. The money still goes straight from the buyer to your payout address; the settler only pays gas, about 0.00001 ETH a call on Robinhood Chain. Calls are settled after your API answered, and a payment that does not settle withholds the response, exactly as for tab buyers. SPEC section 5.3 has the details.

## Attribution, refund-free by design

Your upstream receives three extra headers on paid calls: `Tab-Payer` (the agent), `Tab-Owner` (whose money), `Tab-Hold` (the payment id). Log them and you have per-caller usage accounting with zero integration work. There is no refund flow to build because failed calls are never charged in the first place.

## Pricing notes

**Pricing in your own token.** A gateway settles in one ERC-20, and it can be yours. Put its symbol in `currency` and its contract and decimals under `evm`:

```json
{ "rail": "evm", "currency": "TTT",
  "evm": { "chain_id": 46630, "token": "0x8f6fe411e76b79d6eb6521872340c37c3210ee47", "decimals": 18, "recipient": "0x…your payout…" } }
```

Prices are then amounts of the token, every 402 and receipt names it, the catalog shows `0.5 TTT` instead of `$0.50`, and buyers must opt in with `--currency TTT` before their client will pay. The gateway checks `decimals` against the contract at start. To take dollars and your token for the same routes, run two gateways from two specs that differ only in realm, currency and token, and announce both; the catalog lists each route twice with its price on each.


Prices are USD strings with up to six decimals, so $0.000001 routes are legal. Since buyers' mandates carry per-call caps (commonly $0.05), pricing at or under common caps means agents can buy without their owners ever raising a limit. Cheap and honest beats clever: the catalog sorts by price.
