# Sell your API

You have an HTTP API. tab puts a price tag on it and collects per request, in USDC on Robinhood Chain, with no accounts, no billing code, and no payment keys on your server.

## What you are setting up

```
buyers ──▶ your gateway (tab serve) ──▶ your existing API
                 │
        402 until paid, then proxy
        USDC ──▶ your payout address
```

The gateway is a reverse proxy you run next to your API. It answers 402 with a signed challenge until a request is paid, verifies the payment, forwards the request, and broadcasts the settlement only after your API answers 2xx. If your API errors, the buyer is not charged. You are only paid when you deliver, and buyers can verify that property in [SPEC.md](../SPEC.md) rather than take your word for it.

## 1. Keys and addresses

```sh
npx tabprotocol key new --out seller.json     # your wallet id (keep the file safe)
npx tabprotocol evm address seller.json       # your 0x payout address on Robinhood Chain
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
- `public_receipts: true` exposes your last 200 receipts, which the catalog's live feed reads. Turn it off if payer wallet ids should stay private.
- For chain ids, RPC endpoints and mainnet USDC, see [DEPLOY.md section 9](../DEPLOY.md).

## 3. Serve

```sh
npx tabprotocol serve --spec spec.json \
  --announce https://catalog.example.com \
  --origin https://api.example.com
```

`--announce` registers you with a catalog so agents can find your routes; `--origin` is the public URL buyers will call. State lives in one SQLite file next to the process. Production hardening (systemd, nginx or Caddy with TLS, firewalling, backups) is [DEPLOY.md section 8](../DEPLOY.md); the short version is: put TLS in front, keep the raw port off the internet.

## 4. Verify you get paid

```sh
curl -s https://api.example.com/.well-known/tab | jq .routes   # your price list, machine readable
curl -si https://api.example.com/v1/things/42 | head -3        # 402 + challenge
npx tabprotocol evm balance --wallet seller.json \
  --token 0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5           # USDC arriving per call
```

Every paid call also returns the buyer a `Tab-Receipt` whose ref is the settlement transaction; your payout address is visible on the [Robinhood Chain explorer](https://explorer.testnet.chain.robinhood.com).

## Attribution, refund-free by design

Your upstream receives three extra headers on paid calls: `Tab-Payer` (the agent), `Tab-Owner` (whose money), `Tab-Hold` (the payment id). Log them and you have per-caller usage accounting with zero integration work. There is no refund flow to build because failed calls are never charged in the first place.

## Pricing notes

Prices are USD strings with up to six decimals, so $0.000001 routes are legal. Since buyers' mandates carry per-call caps (commonly $0.05), pricing at or under common caps means agents can buy without their owners ever raising a limit. Cheap and honest beats clever: the catalog sorts by price.
