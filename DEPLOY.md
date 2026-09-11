# tab: build and deploy guide

Everything needed to take this project from a clean VPS to a running gateway, catalog and front end. Written against the tree as of 2026-09-10 (`package.json` version 0.0.1). `README.md` is the short pitch and `SPEC.md` is the protocol; this file is the operator's manual.

---

## 1. What this is

**tab** is a payment gateway for software agents. You put it in front of any HTTP API, price the routes in a JSON spec, and callers pay per request with HTTP 402.

The one idea that makes it different from x402 and similar schemes: the spending limit is a **mandate**, a signed object the owner of the money issues once (budget, per-call cap, allowed realms, expiry). The agent holds its own key and carries the mandate with every payment. The **gateway** enforces the budget, so the owner is never online during a payment and the agent can never exceed what was signed, no matter what it is told.

Three roles, one binary:

| Role | Holds | Does |
| --- | --- | --- |
| Owner | funds + owner key | signs mandates offline, funds a wallet |
| Agent | agent key + mandate | signs a credential per call, pays within the mandate |
| Gateway (seller) | spec + SQLite + optional fee-payer key | issues 402 challenges, verifies, reserves, forwards upstream, captures on 2xx |

Money moves over a **rail**. Two ship:

- `ledger`: balances in the gateway's own SQLite file. Free, instant, sandbox money created with `tab mint`.
- `evm`: USDC or any 6-decimal ERC-20 — built for **Robinhood Chain** (Arbitrum-stack L2; chain id 46630 testnet, 4663 mainnet), no custom contract. The owner `approve`s the agent as ERC-20 spender once; the agent signs a type-2 `transferFrom` transaction (its account pays gas); the gateway verifies it field-for-field and broadcasts only after the upstream answered 2xx. Section 9.

There is also a **catalog** service (search + web front end) and an **MCP server** so Claude Code can spend under a mandate.

---

## 2. Requirements

| Thing | Version | Why |
| --- | --- | --- |
| Node.js | **22.13 or newer** (dev box has 22.22.2) | uses the built-in `node:sqlite` module; older Node has no SQLite |
| npm | 10.x | ships with Node 22 |
| TypeScript, tsx, @types/node | devDependencies, installed by `npm install` | the only dependencies in the whole project |
| curl, bash | any | demo scripts |

**Zero runtime dependencies.** Ed25519, keccak-256, secp256k1 ECDSA, SHA-256, HMAC, RLP, EIP-1559 transactions, ERC-20 encoding, JSON-RPC and the MCP server are all hand-written on top of Node built-ins. `node_modules` is roughly 40 MB of dev tooling and nothing else.

Node prints `ExperimentalWarning: SQLite is an experimental feature` on every start. All npm scripts pass `--no-warnings=ExperimentalWarning` to silence it. Copy that flag into your systemd units.

Install Node 22 on Ubuntu/Debian:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # must be >= v22.13
```

---

## 3. Getting the code onto the VPS

The working tree is a git repository (the pre-hardening baseline is tagged `draft-0`). Clone it, or copy it with rsync excluding everything `.gitignore` excludes (state, secrets, build output):

```sh
rsync -av --delete \
  --exclude node_modules --exclude dist \
  --exclude '*.db' --exclude '*.db-*' \
  --exclude keys/ --exclude .env \
  /home/deploy/tab/  user@vps:/opt/tab/
```

Do **not** copy `keys/` or the `.db` files unless you deliberately want to migrate the sandbox state. Fresh keys and a fresh database are the right starting point. If you do migrate a database, copy `x.db`, `x.db-wal` and `x.db-shm` together while the process is stopped (WAL mode).

The files that matter:

```
package.json  tsconfig.json  .gitignore  .mcp.json
README.md  SPEC.md  DEPLOY.md
bin/tab.js                  # runs dist/src/cli.js after `npm run build`
src/                        # the code, ~2,000 lines
  cli.ts                    # the `tab` command
  gateway.ts                # reverse proxy + 402 handshake
  catalog.ts                # catalog service, search, try-it, serves web/ (/ and /catalog)
  client.ts                 # payment-aware fetch (TabClient, tabFetch)
  mcp.ts                    # MCP server on stdio
  protocol.ts               # wire format, canonical JSON, HMAC binding
  keys.ts  mandate.ts  store.ts
  rails/{index,ledger,evm,budget}.ts
  evm/{keccak,secp256k1,rlp,tx,rpc,pay}.ts   # hand-written keccak-256 + ECDSA, EIP-1559, ERC-20
web/index.html              # landing page, single file, no build step, no CDN
web/catalog.html            # catalog app (search, try-it, receipts, wallet, mandate check)
web/logo.png                # wordmark, served at /logo.png
web/hero.jpg                # landing page hero background, served at /hero.jpg
examples/
  spec.json                 # ledger-rail spec (two services, five priced routes)
  spec-evm.json             # same routes on the evm rail (Robinhood Chain testnet)
  upstream.ts               # demo API to sell (quotes, echo, secret, translate, boom, free)
  demo.sh                   # one-command sandbox
test/e2e.ts                 # 51 in-process checks, temp DB, ~1-2 min
test/adversarial.ts         # 24 hostile checks: concurrency, replay, mutation, SSRF, forgery
test/evm.ts                 # 31 checks: crypto vectors, a mock EVM node, live Robinhood testnet reads
```

---

## 4. Install, verify, build

```sh
cd /opt/tab
npm ci                      # or npm install; installs tsx + typescript only
npx tsc --noEmit            # type-check; clean on the dev box
npm test                    # 51 passed, 0 failed on the dev box
npm run test:adversarial    # 24 passed, 0 failed: replay, concurrency, mutation, SSRF, forgery
npm run test:evm            # 31 passed, 0 failed: keccak/secp256k1 vectors, mock chain, live testnet reads
```

These suites run everything in one process on random ports with a temp SQLite file, so they are safe to run on a box that already has a gateway up (`test:evm` additionally makes two read-only calls to the public Robinhood testnet RPC and silently skips them offline). The adversarial suite is the one that proves the money invariants (e.g. 150 concurrent calls against a $1.00 budget settle at exactly 100 paid); run it after any change to the payment path.

Two ways to run the code:

**A. Directly from TypeScript with tsx** (what every npm script and demo does):

```sh
node --no-warnings=ExperimentalWarning --import tsx src/cli.ts <command>
# same thing:
npm run cli -- <command>
```

**B. Compiled** (what you want under systemd):

```sh
npm run build               # tsc -> dist/
node bin/tab.js <command>   # bin/tab.js imports ../dist/src/cli.js
# or
node --no-warnings=ExperimentalWarning dist/src/cli.js <command>
```

Verified: `npm run build` produces `dist/src/cli.js` and `node bin/tab.js` prints the usage. The catalog finds `web/` from `dist/src/` by walking up two directories, so keep `web/` next to `dist/`. Re-run `npm run build` after every code change; tsx picks changes up automatically.

To make `tab` a global command: `npm link` after building, or symlink `bin/tab.js` into `/usr/local/bin/tab`.

---

## 5. Components, ports and bind address

| Process | Default port | Command | State file |
| --- | --- | --- | --- |
| Example upstream (demo only) | 4101 | `npm run upstream` / `examples/upstream.ts` | none |
| Gateway, ledger rail | 1402 | `tab serve --spec spec.json` | `tab.db` |
| Catalog + front end | 1403 | `tab catalog serve` | `catalog.db` |

**All servers listen on every interface** (`server.listen(port)` with no host). On a VPS that means they are public the moment they start. Either firewall the ports and put nginx or Caddy in front (section 8), or bind them to loopback by editing the two `listen(` calls in `src/cli.ts` to `listen(port, '127.0.0.1', …)`.

One gateway can front many upstreams; one catalog can list many gateways; you can run several gateways on one box with different `--db` files and ports.

---

## 6. Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `SELLER` | spec files via `${SELLER}` | wallet id (base64url public key) that gets paid |
| `PREMIUM_KEY` | `examples/spec.json`, `examples/upstream.ts` | demo API key injected as `X-Api-Key`; default `demo-key` |
| `EVM_RPC` | `tab evm *`, `spec-evm.json`, `test/evm.ts` | EVM JSON-RPC URL; default `https://rpc.testnet.chain.robinhood.com` |
| `TOKEN` | `spec-evm.json` | ERC-20 stablecoin contract on the evm rail (testnet USDC: `0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5`) |
| `SELLER_EVM` | `spec-evm.json` | the seller's 0x payout address (`tab evm address keys/seller.json`) |
| `MINT` | `demo.sh` | **ledger amount** to mint to the owner, default `5.00` |
| `UPSTREAM_PORT` | `examples/upstream.ts` | default 4101 |
| `BUDGET`, `MAX_PER_CALL`, `WEB_BUDGET` | demo scripts | mandate terms for the Claude agent (1.00 / 0.05) and the web try-it agent (0.50) |
| `TAB_AGENT`, `TAB_MANDATE` | `tab mcp` | paths to the agent key and mandate JSON (required) |
| `TAB_MAX_PER_CALL` | `tab mcp` | client-side per-call ceiling in USD, independent of the mandate |
| `TAB_CATALOG` | `tab mcp` | catalog origin for `tab_search`, `tab_discover`, `tab_balance` |
| `SCRATCH` | tests | where temp DBs go; default OS tmpdir |

Any `${UPPER_CASE_NAME}` inside a spec file is replaced from the environment when the spec is loaded (`loadSpec` in `src/gateway.ts`). Unset variables become empty strings, and an empty `recipient` makes `tab serve` refuse to start.

---

## 7. CLI reference

```
tab key new [--out file]
tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                  [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7] [--out file]
tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]        sandbox: create ledger money
tab balance --wallet <pub|file> [--db tab.db]
tab serve   --spec spec.json [--db tab.db] [--port 1402] [--announce http://catalog:1403] [--origin http://host:1402]
tab catalog serve [--db catalog.db] [--port 1403] [--try-agent key.json --try-mandate mandate.json]
                  [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]...
tab evm address <key.json>                                          key file -> 0x address (EIP-55)
tab evm approve --owner key.json --agent <key.json|0x> --amount 1.00 --token <0x> [--rpc url]
tab evm revoke  --owner key.json --agent <key.json|0x> --token <0x> [--rpc url]
tab evm balance --wallet <key.json|0x> --token <0x> [--agent <key.json|0x>] [--rpc url]
tab evm fund    --from key.json --to <key.json|0x> --eth 0.005 [--rpc url]
tab fetch --agent key.json --mandate mandate.json [--max-per-call 0.05] [-X POST] [-d body] <url>
tab mcp                                                             stdio; TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CATALOG]
```

Notes:

- Anywhere a `<pub|file>` is accepted, a path ending in `.json` is read as a key file and its `publicKey` used; anything else is taken as the public key itself.
- Key files are written with mode `0600` and look like `{"publicKey":"…","privateKey":"…"}`, both base64url raw 32 bytes. A wallet id **is** the public key; its seed also derives the key's EVM address (`tab evm address`).
- `--allow` may be repeated. Values are globs over realms: `*`, `*.example.com`, `quotes.local`. Omitted means `*`.
- `--window day` resets the budget per UTC calendar day; `total` (default) is a lifetime budget.
- `tab fetch` exit codes: 0 paid and 2xx, 1 non-2xx, 2 refused by the client's own cap before paying.
- `tab serve --announce` retries the catalog for 10 seconds, then gives up with a log line; the gateway keeps running either way. `--origin` is what the catalog will store and what buyers will call, so it must be the **public** URL, not 127.0.0.1, in production.
- `tab catalog serve --seed` pre-loads gateways at startup; `--announce` from the gateway side does the same at runtime.
- The catalog refuses to announce (or fetch) origins on private, loopback, link-local, CGNAT or cloud-metadata addresses, refuses redirects, and caps discovery documents at 1 MB — SSRF protection for a public catalog. `--allow-private-origins` disables the address check for local development (the demo passes it); never use it on a catalog reachable from the internet. `/v1/wallet` only proxies to origins already in the catalog.

---

## 8. Production deployment, step by step

This deploys a ledger-rail gateway fronting **your** API, plus the catalog with the front end, behind nginx with TLS. Swap section 9 in for the evm rail (Robinhood Chain).

### 8.1 System user and directory

```sh
sudo useradd --system --home /opt/tab --shell /usr/sbin/nologin tab
sudo mkdir -p /opt/tab && sudo chown tab:tab /opt/tab
# rsync the tree in (section 3), then:
sudo -u tab bash -c 'cd /opt/tab && npm ci && npm run build'
```

### 8.2 Keys and a mandate

```sh
cd /opt/tab
sudo -u tab mkdir -p keys
sudo -u tab node bin/tab.js key new --out keys/seller.json      # gets paid
sudo -u tab node bin/tab.js key new --out keys/owner.json       # funds buyers (sandbox)
sudo -u tab node bin/tab.js key new --out keys/agent.json       # a buyer
sudo -u tab node bin/tab.js mandate issue --owner keys/owner.json --agent keys/agent.json \
    --budget 10.00 --window day --max-per-call 0.05 --allow apis.example.com --days 90 --out keys/mandate-agent.json
sudo -u tab node bin/tab.js mint --wallet keys/owner.json --amount 50.00 --db /opt/tab/tab.db
```

The owner key is only needed to sign mandates and to mint sandbox money. Keep it **off** the server if you can: issue mandates on your laptop and copy just the mandate JSON up. The seller key never needs to be on the server either; only its public key goes in the spec. A gateway holds no private key at all, on either rail.

### 8.3 The spec

`/opt/tab/spec.json`, fronting a real upstream and injecting its API key:

```json
{
  "realm": "apis.example.com",
  "recipient": "${SELLER}",
  "public_receipts": true,
  "services": [
    {
      "name": "translate",
      "prefix": "/google/translate",
      "upstream": "https://translation.googleapis.com",
      "upstream_headers": { "Authorization": "Bearer ${GOOGLE_TOKEN}" },
      "description": "Google Translate v2",
      "routes": [
        { "method": "POST", "path": "/language/translate/v2", "price": "0.002", "description": "Translate text" }
      ]
    },
    {
      "name": "myapi",
      "prefix": "",
      "upstream": "http://127.0.0.1:8080",
      "routes": [
        { "method": "GET",  "path": "/v1/things/:id", "price": "0.01", "description": "One thing" },
        { "method": "GET",  "path": "/healthz",       "price": "0",    "description": "Free" }
      ]
    }
  ]
}
```

Rules:

- `realm` is the string mandates allow-list against. Pick your public hostname.
- `recipient` is the seller's wallet id (base64url public key). On the evm rail, `evm.recipient` — the seller's 0x address — is where USDC lands.
- `prefix` is matched longest-first. `""` is the root. A request to `<prefix><rest>` forwards to `<upstream><rest>` with the query string intact.
- `path` supports `:param` segments; anything else is literal. Method is case-insensitive.
- `price` is USD with up to six decimals. `"0"` routes are forwarded unpaid. Paths with no priced route return 404 and are **never proxied**.
- `upstream_headers` are added on the way through and `Authorization` from the buyer is stripped, so the buyer never sees your upstream credential and the upstream never sees the buyer's.
- The upstream also receives `Tab-Payer`, `Tab-Owner` and `Tab-Hold` headers so it can attribute the call.
- `public_receipts: true` exposes the last 200 receipts at `/.well-known/tab/receipts`; the front end's live feed reads it.
- Single-service shorthand: top-level `upstream`, `upstream_headers`, `routes` instead of `services`.

Put the secrets in an environment file, not the spec:

```sh
sudo install -m 600 -o tab -g tab /dev/null /opt/tab/.env
sudo -u tab tee /opt/tab/.env >/dev/null <<EOF
SELLER=$(node -p "require('/opt/tab/keys/seller.json').publicKey")
GOOGLE_TOKEN=ya29....
EOF
```

### 8.4 systemd units

`/etc/systemd/system/tab-gateway.service`:

```ini
[Unit]
Description=tab payment gateway
After=network-online.target
Wants=network-online.target

[Service]
User=tab
Group=tab
WorkingDirectory=/opt/tab
EnvironmentFile=/opt/tab/.env
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning /opt/tab/dist/src/cli.js serve \
    --spec /opt/tab/spec.json --db /opt/tab/tab.db --port 1402 \
    --announce http://127.0.0.1:1403 --origin https://pay.example.com
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/tab
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/tab-catalog.service`:

```ini
[Unit]
Description=tab catalog and front end
After=network-online.target
Wants=network-online.target

[Service]
User=tab
Group=tab
WorkingDirectory=/opt/tab
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning /opt/tab/dist/src/cli.js catalog serve \
    --db /opt/tab/catalog.db --port 1403 \
    --try-agent /opt/tab/keys/agent.json --try-mandate /opt/tab/keys/mandate-agent.json --try-max-per-call 0.05
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/tab
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Drop the `--try-agent`/`--try-mandate` flags if you do not want a public "Buy" button that spends real (sandbox or on-chain) money from your owner wallet. With them, anyone who can reach the catalog can spend up to that mandate's budget per day, capped per call, on catalogued routes only.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tab-catalog tab-gateway
sudo journalctl -u tab-gateway -f          # logs go to stderr with ISO timestamps
```

Start the catalog first, or just start both: the gateway retries `--announce` for 10 seconds.

### 8.5 nginx with TLS

The protocol lives entirely in HTTP headers (`WWW-Authenticate`, `Authorization`, `Tab-Receipt`, `Tab-Void`), which nginx passes through by default. The `Authorization` header carries a base64 credential of about 1 KB on the ledger rail and about 2 KB on the evm rail (it embeds a signed transaction), so raise the header buffers a little.

```nginx
server {
    listen 443 ssl http2;
    server_name pay.example.com;
    ssl_certificate     /etc/letsencrypt/live/pay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.example.com/privkey.pem;
    large_client_header_buffers 4 16k;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:1402;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
server {
    listen 443 ssl http2;
    server_name catalog.example.com;
    ssl_certificate     /etc/letsencrypt/live/catalog.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/catalog.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:1403;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

Then firewall the raw ports:

```sh
sudo ufw allow 22,80,443/tcp
sudo ufw deny 1402/tcp && sudo ufw deny 1403/tcp && sudo ufw deny 1404/tcp
sudo ufw enable
```

CORS is already `Access-Control-Allow-Origin: *` on every JSON endpoint of both services, so the front end may be served from a different origin than the gateways it talks to.

### 8.6 Smoke test from anywhere

```sh
curl -s https://pay.example.com/.well-known/tab | jq .routes
curl -si https://pay.example.com/v1/things/42 | head -5        # expect 402 + WWW-Authenticate: Tab ...
node bin/tab.js fetch --agent keys/agent.json --mandate keys/mandate-agent.json https://pay.example.com/v1/things/42
node bin/tab.js balance --wallet keys/seller.json --db /opt/tab/tab.db   # on the server: seller got paid
curl -s https://catalog.example.com/v1/search?q=thing | jq .
```

---

## 9. The EVM rail: Robinhood Chain

Everything in section 8 applies. Robinhood Chain is an Arbitrum-stack L2; the rail is plain EVM, so any chain with USDC works, but the defaults point at Robinhood.

**Chain facts.**

| Cluster | chain id | public RPC (rate-limited) | explorer | USDC |
| --- | --- | --- | --- | --- |
| testnet | 46630 | `https://rpc.testnet.chain.robinhood.com` | `https://explorer.testnet.chain.robinhood.com` | `0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5` |
| mainnet | 4663 | `https://rpc.mainnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` | check the explorer |

For production use a provider endpoint (Alchemy/QuickNode/dRPC support Robinhood Chain) instead of the public RPC. Beware lookalike explorer domains (rh-scan and similar); the two above are the official ones. Testnet ETH comes from `https://faucet.testnet.chain.robinhood.com/`.

**Keys.** A tab key file already contains everything: its 32-byte seed doubles as a secp256k1 scalar, so `tab evm address keys/owner.json` prints the owner's 0x address. Mandates issued by `tab mandate issue` automatically embed that address as `evm_owner` (the owner's signed attestation of which EVM account its mandates spend).

**Spec.** `examples/spec-evm.json` is the template:

```json
{
  "realm": "pay.example.com",
  "recipient": "${SELLER}",
  "rail": "evm",
  "evm": { "rpc": "${EVM_RPC}", "chain_id": 46630, "token": "${TOKEN}", "decimals": 6,
           "recipient": "${SELLER_EVM}", "explorer": "https://explorer.testnet.chain.robinhood.com" },
  "public_receipts": true,
  "services": [ ... ]
}
```

`evm.recipient` is the seller's payout address — USDC lands there. The gateway holds **no key at all**: the agent's account is the transaction sender and pays gas.

**Funding, once.**

```sh
export EVM_RPC=https://rpc.testnet.chain.robinhood.com TOKEN=0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5
node bin/tab.js evm address keys/owner.json     # send testnet ETH here (faucet) and USDC
node bin/tab.js evm fund --from keys/owner.json --to keys/agent.json --eth 0.005   # gas for the agent
# the on-chain half of the mandate: owner approves the agent as ERC-20 spender
node bin/tab.js evm approve --owner keys/owner.json --agent keys/agent.json --amount 10.00 --token $TOKEN
node bin/tab.js evm balance --wallet keys/owner.json --token $TOKEN --agent keys/agent.json
```

**How a paid call settles.** The challenge carries chain id, token, payout address, fee caps and a gas limit; the agent asks the gateway for its account nonce (`GET /.well-known/tab/evm/nonce/<0x...>`), builds the one legal EIP-1559 `transferFrom` transaction, signs it, and sends it in the credential. The gateway parses it, recovers the sender, requires every field except the nonce to match the challenge (and the `transferFrom` owner to match the mandate's signed `evm_owner`), stores the raw-tx hash UNIQUE so one signed payment can never back two calls, checks the nonce and gas balance, dry-runs the transfer with `eth_call`, forwards upstream, and broadcasts only on 2xx. Receipt `ref` is `evm:<tx hash>`.

**Operational facts.**

- One allowance per (owner, agent) pair — so one owner can run many agents against one account, each with its own allowance and mandate.
- `tab evm revoke` (allowance to 0) ends an agent's spending instantly, independent of mandate expiry.
- The agent pays gas, bounded per call by `gas_limit × max_fee_per_gas` from the challenge it signed. Keep ~0.005 ETH on an active agent; `tab evm balance` shows the ETH balance too.
- A signed-but-voided payment stays broadcastable until the agent's nonce moves. The seller could broadcast it without serving — a one-priced-call trust bound; see SPEC.md §9.
- The wallet endpoint (`/.well-known/tab/wallet/<id>`) takes a 0x address on this rail.
- Only type-2 transactions, empty access lists, 6-decimal tokens in draft 0.2.

`npm run test:evm` runs 31 checks: keccak-256 and RFC 6979 vectors, our point math cross-checked against OpenSSL, RLP/EIP-1559 roundtrips, a full 402 flow against a mock EVM node with real ERC-20 semantics, and two read-only calls against the live Robinhood testnet (chain id + USDC decimals).

---

## 10. The catalog service

`tab catalog serve` is discovery for buyers and hosts the front end.

| Endpoint | What |
| --- | --- |
| `GET /` | the landing page (`web/index.html`) |
| `GET /catalog` | the catalog app (`web/catalog.html`) |
| `GET /logo.png` | the wordmark used by both pages |
| `GET /hero.jpg` | the landing page hero background |
| `GET /v1/catalog.json` | every known gateway with services and routes |
| `GET /v1/search?q=&max_price=` | route search, route-level text matches outrank service-level, cheapest first; results carry the full URL to call |
| `POST /v1/announce {origin}` | fetch and verify `<origin>/.well-known/tab`, store it |
| `POST /v1/refresh` | re-fetch every stored gateway now (also runs every 60 s) |
| `POST /v1/mandate/verify {mandate, realm}` | check a mandate's signature, expiry and realm, return it decoded |
| `GET /v1/wallet?origin=&wallet=` | proxy a balance lookup to a gateway |
| `GET /v1/receipts?limit=` | receipts aggregated from every gateway with `public_receipts` |
| `GET /v1/try` | is the try-it agent configured, and its limits |
| `POST /v1/try {url, method, body}` | pay for a catalogued route with the try-it agent, return status, receipt and body |

The front end is two HTML files with no build step and no external scripts or fonts: a 325-line landing page at `/` and the 217-line catalog app at `/catalog`. The catalog app links `evm:` receipts to the gateway's own explorer (`rail_info.explorer`, defaulting to `explorer.testnet.chain.robinhood.com`); that is the only outbound URL in either file. Serve them from the catalog process or copy them anywhere static and point the app at the catalog with a reverse proxy on the same origin (it fetches relative `/v1/...` paths).

---

## 11. Gateway HTTP surface

| Endpoint | What |
| --- | --- |
| `GET /.well-known/tab` | discovery: version, realm, rail, rail_info, recipient, services, routes |
| `GET /.well-known/tab/wallet/<id>` | available balance of a wallet on this rail |
| `GET /.well-known/tab/receipts?limit=` | last receipts, only if `public_receipts` |
| `OPTIONS /.well-known/tab*` | CORS preflight |
| any priced route | 402 with `WWW-Authenticate: Tab …` until paid; then proxied |
| any unpriced path | 404 `not-found`, never proxied |

Every 402 body is an RFC 9457 problem with `type: urn:tab:problem:<code>` and a fresh challenge in `WWW-Authenticate`. Codes: `payment-required`, `malformed-credential`, `invalid-challenge`, `payment-expired`, `verification-failed`, `mandate-invalid`, `mandate-denied`, `mandate-exceeded`, `insufficient-funds`. Upstream unreachable is 502 `upstream-failed`, nothing charged. Upstream non-2xx is passed through with a `Tab-Void` header and the hold released.

The verification order and the reasons for it are in `SPEC.md` section 4. The short version: the challenge id is an HMAC over amount, recipient, resource and expiry with a per-database secret, so the gateway keeps no state per challenge and any edited challenge fails first; a challenge id can be redeemed once (insert-before-reserve, so two racing copies cannot both pay); the mandate budget check and the funds check are one SQLite transaction.

---

## 12. State, secrets and backups

| File | Owner | Contains | Lose it and… |
| --- | --- | --- | --- |
| `tab.db` (+ `-wal`, `-shm`) | gateway | HMAC secret, ledger wallets and balances, holds, receipts, mandate spend counters, redeemed challenge ids | ledger balances are gone; spend counters reset (mandates start fresh); outstanding challenges die harmlessly |
| `tab-evm.db` (if you name it that) | evm gateway | same minus wallets; holds carry the signed transaction until capture | spend counters reset; on-chain state is unaffected |
| `catalog.db` | catalog | announced gateways | re-announce or `--seed` |
| `keys/*.json` | you | private keys, mode 0600 | seller: cannot spend earnings. owner: cannot issue mandates or move funds. feepayer: gateway cannot broadcast. agent: mandate is useless |
| `keys/mandate-*.json` | you | signed mandates, not secret but grant spending | re-issue from the owner key |

Backup: stop the service or use `sqlite3 tab.db ".backup tab.bak"` for a consistent copy while running. The database is in WAL mode, so copying only `tab.db` while a process is writing can miss recent commits. Back up `keys/` to somewhere encrypted and off the box.

The gateway prunes redeemed challenge ids older than one hour every ten minutes. Holds and receipts are kept forever; the tables are small (one row per paid call).

---

## 13. Letting Claude Code spend

`tab mcp` is a Model Context Protocol server on stdio, implemented without an SDK. It exposes five tools: `tab_limits`, `tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`. It runs **where Claude Code runs**, not on the gateway, and needs only an agent key, a mandate, and network access to the gateway and catalog.

Register it for one project by keeping `.mcp.json` next to the code:

```json
{ "mcpServers": { "tab": {
  "command": "node", "args": ["--no-warnings=ExperimentalWarning", "--import", "tsx", "src/cli.ts", "mcp"],
  "env": { "TAB_AGENT": "keys/agent-claude.json", "TAB_MANDATE": "keys/mandate-claude.json",
           "TAB_MAX_PER_CALL": "0.05", "TAB_CATALOG": "https://catalog.example.com" } } } }
```

Or for every project (built version, absolute paths):

```sh
claude mcp add --scope user tab \
  -e TAB_AGENT=/opt/tab/keys/agent-claude.json -e TAB_MANDATE=/opt/tab/keys/mandate-claude.json \
  -e TAB_MAX_PER_CALL=0.05 -e TAB_CATALOG=https://catalog.example.com \
  -- node --no-warnings=ExperimentalWarning /opt/tab/dist/src/cli.js mcp
```

Claude never sees the owner key. It can only spend within the mandate, the gateway enforces that, and `TAB_MAX_PER_CALL` adds a second, client-side cap. `.claude/settings.local.json` in this tree just enables the `tab` server from `.mcp.json`.

---

## 14. Using it from code

```ts
import { TabClient, tabFetch, receiptOf, PaymentRefused } from './src/client.js';

const client = new TabClient({ agent, mandate, maxPerCallUsd: '0.05',
  onChallenge: (challenge, request) => Number(request.amount) <= 20_000 });   // optional veto, amounts in micro-USD
const res = await client.fetch('https://pay.example.com/v1/things/42');
const receipt = receiptOf(res);           // null if the route was free or the call was voided
```

`tabFetch(url, init, options)` is the functional form. On 402 it parses the challenge, signs a credential (and on the evm rail builds and signs the payment transaction), and retries exactly once. It throws `PaymentRefused` when the price exceeds `maxPerCallUsd` or `onChallenge` says no; the gateway is never contacted with a credential in that case.

Server side, `createGateway(spec, { store, rail?, log? })` and `createCatalog({ store, tryAgent?, log? })` return plain `http.Server`s, which is how `test/e2e.ts` runs everything in one process on port 0.

---

## 15. Quick sandbox on the VPS

If you just want the whole thing up to poke at, the demo does everything in section 8.2 with sandbox money:

```sh
npm run demo          # keys/, owner minted 5.00, mandates, upstream :4101, gateway :1402, catalog + UI :1403
```

It is idempotent (re-uses existing keys and mandates) and runs all three processes in the foreground until Ctrl-C. Env overrides: `BUDGET`, `MAX_PER_CALL`, `WEB_BUDGET`, `MINT` (ledger amount), `PREMIUM_KEY`. Then open `http://<vps>:1403/` (or tunnel: `ssh -L 1403:127.0.0.1:1403 user@vps`).

Remember these bind on all interfaces and the web try-it button spends the owner's sandbox balance for anyone who clicks it. Fine for play money; firewall it or do not run it on a public IP with real keys.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SyntaxError: The requested module 'node:sqlite' does not provide…` or `Cannot find module 'node:sqlite'` | Node older than 22.13 | upgrade Node |
| `ExperimentalWarning: SQLite is an experimental feature` | expected | add `--no-warnings=ExperimentalWarning` |
| `error: spec.recipient is required` | `${SELLER}` unset when the spec loaded | export `SELLER` or put it in the `EnvironmentFile` |
| `error: mandate is not for this agent key` | agent key file and mandate disagree | re-issue with `--agent` pointing at the right key |
| `could not announce to http://…` | catalog not up within 10 s, or wrong URL | start the catalog, then `curl -X POST catalog/v1/announce -d '{"origin":"https://pay.example.com"}'` |
| catalog stores the gateway with `ok: false` | catalog could not fetch `<origin>/.well-known/tab` | `--origin` must be reachable **from the catalog**; use the public URL |
| `POST /v1/announce` returns 403 `refused: … is not a public address` | SSRF guard: the origin is on a private/loopback address | use the public origin, or `--allow-private-origins` on a local dev catalog |
| 402 `verification-failed: request does not match the signed commitment` | body or query string changed between signing and sending | send exactly the bytes the credential signed (the built-in client does) |
| 402 `mandate-invalid: mandate has no evm_owner` on the evm rail | mandate issued before the evm rail existed | re-issue with `tab mandate issue` (it embeds the owner's 0x address automatically) |
| 402 `insufficient-funds: agent account cannot cover gas` | the agent's EVM account has no ETH | `tab evm fund --from keys/owner.json --to keys/agent.json --eth 0.005` |
| 402 `payment-expired: stale nonce` on the evm rail | another payment from this agent landed in between | just retry; the client fetches a fresh nonce per attempt |
| 402 `mandate-denied: realm … not in mandate allow list` | mandate `--allow` does not match the spec's `realm` | issue a mandate with `--allow <realm>` or `*` |
| 402 `mandate-exceeded` | per-call cap or window budget hit | wait for the next UTC day, or issue a bigger mandate |
| 402 `insufficient-funds` on ledger | owner wallet empty in **this gateway's** `tab.db` | `tab mint --db <that db>`; ledger balances are per gateway database |
| 502 `upstream-failed` | upstream unreachable from the gateway | check the `upstream` origin; nothing was charged |
| `EADDRINUSE` | another gateway or the demo still running | `ss -ltnp | grep 140` and stop it, or pick `--port` |
| `ui not found` at `/` or `/catalog` | `web/` not next to `dist/` | keep the tree layout; catalog looks in `../web` and `../../web` relative to `catalog.js` |
| `npm test` hangs or is slow | it is doing ~50 real HTTP round trips plus a catalog refresh; 1 to 2 minutes is normal | run with `SCRATCH=/some/fast/dir` |

---

## 17. Security checklist before real money

- [ ] Ports 1402/1403/1404 firewalled; only nginx/Caddy exposed, TLS on.
- [ ] Owner key not on the server, or at least not in the same directory as the gateway.
- [ ] `keys/` mode 0700, key files 0600, owned by the service user.
- [ ] No `--try-agent` on a public catalog, or a mandate with a budget you are happy to lose.
- [ ] Agents hold only working-capital ETH for gas.
- [ ] Upstream API keys live in `EnvironmentFile`, mode 0600, not in the spec.
- [ ] `public_receipts` off if payer and owner wallet ids should not be public.
- [ ] Backups of `keys/` and `*.db` tested.
- [ ] `npm run test:adversarial` passes on the box (money invariants under concurrency, replay, mutation, SSRF).
- [ ] Catalog running **without** `--allow-private-origins` if it is reachable from the internet.
- [ ] Read `SPEC.md` section 9 and "Not in draft 0.3": credentials bind method, path, query and body digest, but **not headers**; no gas sponsorship, no dispute window.

---

## 18. What is not built yet

From the README roadmap, so you do not go looking for it: x402 client compatibility, agents acting as sellers, per-token or metered pricing and payment channels, windowed budgets on-chain, header binding, subscriptions, fee splits, EIP-4337 gas sponsorship. (Body digest and query binding shipped in draft 0.1; the evm rail in 0.2.)
