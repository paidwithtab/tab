# tab: build and deploy guide

Everything needed to take this project from a clean VPS to a running gateway, catalog and front end. Written against the tree as of 2026-10-12 (`paidwithtab` version 0.4.2). `README.md` is the short pitch and `SPEC.md` is the protocol; this file is the operator's manual.

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
- `evm`: USDG, USDC or any ERC-20 with 0 to 18 decimals, including a gateway's own token (section 9, "charging in your own token"), built for **Robinhood Chain** (Arbitrum-stack L2; chain id 46630 testnet, 4663 mainnet), no custom contract. The owner `approve`s the agent as ERC-20 spender once; the agent signs a type-2 `transferFrom` transaction (its account pays gas); the gateway verifies it field-for-field and broadcasts only after the upstream answered 2xx. Section 9.

There is also a **catalog** service (search + web front end) and an **MCP server** so Claude Code can spend under a mandate.

---

## 2. Requirements

| Thing | Version | Why |
| --- | --- | --- |
| Node.js | **22.13 or newer** (dev box runs 24.18) | uses the built-in `node:sqlite` module; older Node has no SQLite |
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
README.md  SPEC.md  DEPLOY.md  LICENSE  SECURITY.md  CONTRIBUTING.md
docs/                       # quickstart.md, sellers.md, buyers.md, assets/
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
web/catalog.html            # the catalog app, served at /catalog; the marketing site is a separate, private repo
web/docs.html
web/site.css
web/catalog.html            # catalog app (search, try-it, receipts, wallet, mandate check)
web/logo.png                # wordmark, served at /logo.png
web/hero.jpg                # landing page hero background, served at /hero.jpg; shown until the globe loads,
                            #   and for reduced motion or without WebGL2
web/earth-day.jpg           # globe maps for the landing page (NASA Blue Marble, Black Marble and a land/water
web/earth-night.jpg         #   mask, public domain), served at /earth-day.jpg, /earth-night.jpg, /earth-water.png
web/earth-water.png
web/inter.woff2             # the site's fonts (Inter, Instrument Serif italic for heading accents, Geist Mono),
web/instrument-serif-italic.woff2  #   SIL OFL 1.1, served at /<name>.woff2; notices in web/fonts-license.txt
web/geist-mono.woff2
examples/
  spec.json                 # ledger-rail spec (two services, five priced routes)
  spec-evm.json             # same routes on the evm rail (Robinhood Chain testnet)
  upstream.ts               # demo API to sell (quotes, echo, secret, translate, boom, free)
  demo.sh                   # one-command sandbox
test/e2e.ts                 # 75 in-process checks, temp DB, ~1-2 min
test/adversarial.ts         # 37 hostile checks: concurrency, replay, mutation, SSRF, forgery, tampered receipts
test/evm.ts                 # 41 checks: crypto vectors, a mock EVM node, rpc failover, an 18-decimal token gateway, live Robinhood testnet reads
```

---

## 4. Install, verify, build

```sh
cd /opt/tab
npm ci                      # or npm install; installs tsx + typescript only
npx tsc --noEmit            # type-check; clean on the dev box
npm test                    # 75 passed, 0 failed on the dev box
npm run test:adversarial    # 37 passed, 0 failed: replay, concurrency, mutation, SSRF, forgery, body smuggling, tampered receipts
npm run test:evm            # 41 passed, 0 failed: keccak/secp256k1 vectors, mock chain, rpc failover, live testnet reads
npm run test:company        # 92 passed, 0 failed: accounts, host and origin checks, runs that pay, evidence, verified receipts, budgets, signed board log, sealed model keys, the claude adapter against a fake Messages API
npm run test:dashboard      # 21 passed, 0 failed: the dashboard in headless Chromium end to end (npx playwright install chromium first); --live also loads the public site and app
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
| Company server + dashboard | 1407 | `tab company serve --host app.example.com` | `company.db`, `company.db.work/` |

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
| `TAB_AGENT`, `TAB_MANDATE` | `tab mcp` | paths to the agent key and mandate JSON; default `~/.tab/agent.json` and `~/.tab/mandate.json` from `tab init` |
| `TAB_HOME` | `tab init`, `tab fetch`, `tab mcp` | where the buyer's keys live; default `~/.tab` |
| `TAB_MAX_PER_CALL` | `tab mcp` | client-side per-call ceiling in USD, independent of the mandate |
| `TAB_CATALOG` | `tab mcp` | catalog origin for `tab_search`, `tab_discover`, `tab_balance`; default `https://paidwithtab.com` |
| `SCRATCH` | tests | where temp DBs go; default OS tmpdir |
| `CLAUDE_BIN` | `tab company serve --local-claude` | the Claude Code binary claude-code agents run; default `claude` on `PATH` |
| `ANTHROPIC_API_KEY` | `tab company serve --host-model-key` | the key companies without their own run on; not set on the hosted deployment |

Any `${UPPER_CASE_NAME}` inside a spec file is replaced from the environment when the spec is loaded (`loadSpec` in `src/gateway.ts`). Unset variables become empty strings, and an empty `recipient` makes `tab serve` refuse to start.

---

## 7. CLI reference

```
tab init  [--dir ~/.tab] [--budget 1.00] [--max-per-call 0.05] [--days 90]
          [--gateway https://pay.paidwithtab.com] [--catalog https://paidwithtab.com]
tab key new [--out file]
tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                  [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7] [--out file]
tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]        sandbox: create ledger money
tab balance --wallet <pub|file> [--db tab.db]
tab serve   --spec spec.json [--db tab.db] [--port 1402] [--announce http://catalog:1403] [--origin http://host:1402]
            [--faucet 1.00]                                         ledger rail: starter credits, once per wallet
tab catalog serve [--db catalog.db] [--port 1403] [--try-agent key.json --try-mandate mandate.json]
                  [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]...
tab evm address <key.json>                                          key file -> 0x address (EIP-55)
tab evm approve --owner key.json --agent <key.json|0x> --amount 1.00 --token <0x> [--rpc url]
tab evm revoke  --owner key.json --agent <key.json|0x> --token <0x> [--rpc url]
tab evm balance --wallet <key.json|0x> --token <0x> [--agent <key.json|0x>] [--rpc url]
tab evm fund    --from key.json --to <key.json|0x> --eth 0.005 [--rpc url]
tab fetch [--agent key.json --mandate mandate.json] [--max-per-call 0.05] [-X POST] [-d body] <url>
tab mcp                                                             stdio; TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CATALOG]
tab company serve  [--db company.db] [--port 1407] [--host app.example.com]... [--gateway origin] [--catalog origin]
                   [--work dir] [--allow-private-origins] [--tick 3] [--run-timeout 600]
tab company signup|login --email ... --password ... [--server http://127.0.0.1:1407]
tab company new|model-key|fund|hire|ticket|comment|approve|pause|resume|budget|status|key   docs/company.md has every flag
```

Notes:

- `tab init` is the buyer's whole setup: it writes `owner.json`, `agent.json` and `mandate.json` to `~/.tab` (reusing keys that are already there), signs a daily-window mandate for any realm, and claims the gateway's starter credits for the owner wallet if the gateway advertises a `faucet` in its discovery document. `tab fetch` and `tab mcp` fall back to those files when no `--agent`/`--mandate` or `TAB_AGENT`/`TAB_MANDATE` is given, and `tab mcp` defaults `TAB_CATALOG` to `https://paidwithtab.com`. `TAB_HOME` moves the directory.
- `tab serve --faucet 1.00` (ledger rail only) opens `POST /.well-known/tab/faucet {wallet}`: one credit per wallet, ever, at most 20 claims per client address per day (`cf-connecting-ip`, then `x-forwarded-for`, then the socket). The discovery document gains `"faucet": "1.00"` so clients can find it. Starter credits are sandbox money that only spends on that gateway.
- Anywhere a `<pub|file>` is accepted, a path ending in `.json` is read as a key file and its `publicKey` used; anything else is taken as the public key itself.
- Key files are written with mode `0600` and look like `{"publicKey":"…","privateKey":"…"}`, both base64url raw 32 bytes. A wallet id **is** the public key; its seed also derives the key's EVM address (`tab evm address`).
- `--allow` may be repeated. Values are globs over realms: `*`, `*.example.com`, `quotes.local`. Omitted means `*`.
- `--window day` resets the budget per UTC calendar day; `total` (default) is a lifetime budget.
- `tab fetch` exit codes: 0 paid and 2xx, 1 non-2xx, 2 refused by the client's own cap before paying.
- `tab serve --announce` retries the catalog for 10 seconds, then gives up with a log line; the gateway keeps running either way. `--origin` is what the catalog will store and what buyers will call, so it must be the **public** URL, not 127.0.0.1, in production.
- `tab catalog serve --seed` pre-loads gateways at startup; `--announce` from the gateway side does the same at runtime.
- The catalog refuses to announce (or fetch) origins on private, loopback, link-local, CGNAT or cloud-metadata addresses, refuses redirects, and caps discovery documents at 1 MB: SSRF protection for a public catalog. `--allow-private-origins` disables the address check for local development (the demo passes it); never use it on a catalog reachable from the internet. `/v1/wallet` only proxies to origins already in the catalog.

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
- `recipient` is the seller's wallet id (base64url public key). On the evm rail, `evm.recipient` (the seller's 0x address) is where USDC lands.
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
| mainnet | 4663 | `https://rpc.mainnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` | the dollar on mainnet is **USDG** (Paxos), `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals; bridged USDC arrives as USDG |

`evm.rpc` may be a comma-separated list. The gateway tries the endpoints in order, moves on when one refuses (connection error, timeout, HTTP 403, 429 or 5xx) and stays on the one that answered. Chain answers such as reverts and insufficient funds are never retried elsewhere. The public specs list the official endpoint first and three public mirrors (dRPC, PublicNode, thirdweb) behind it.

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
  "currency": "USD",
  "public_receipts": true,
  "services": [ ... ]
}
```

`evm.recipient` is the seller's payout address; the token lands there. `evm.decimals` must match the contract's `decimals()`; the gateway checks before its first challenge and refuses to serve if they differ. `currency` is what prices are denominated in, `USD` unless the token is not a dollar (below). The gateway holds **no key at all**: the agent's account is the transaction sender and pays gas.

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

- One allowance per (owner, agent) pair, so one owner can run many agents against one account, each with its own allowance and mandate.
- `tab evm revoke` (allowance to 0) ends an agent's spending instantly, independent of mandate expiry.
- The agent pays gas, bounded per call by `gas_limit × max_fee_per_gas` from the challenge it signed. Keep ~0.005 ETH on an active agent; `tab evm balance` shows the ETH balance too.
- A signed-but-voided payment stays broadcastable until the agent's nonce moves. The seller could broadcast it without serving, a one-priced-call trust bound; see SPEC.md §9.
- The wallet endpoint (`/.well-known/tab/wallet/<id>`) takes a 0x address on this rail.
- Only type-2 transactions and empty access lists. Tokens may have 0 to 18 decimals since draft 0.4; the wire amount stays in micro units and is scaled to the token on chain.

`npm run test:evm` runs 41 checks: keccak-256 and RFC 6979 vectors, rpc failover across a dead endpoint, our point math cross-checked against OpenSSL, RLP/EIP-1559 roundtrips, a full 402 flow against a mock EVM node with real ERC-20 semantics, the same flow against an 18-decimal token priced in its own currency (scaling, the client's currency refusal, decimals checked against the contract), and two read-only calls against the live Robinhood testnet (chain id + USDC decimals).

**Charging in your own token.** A gateway settles in one ERC-20, and it need not be a dollar. Set `currency` to the token's symbol and `evm.token` and `evm.decimals` to the contract; prices are then amounts of that token (`"price": "0.5"` is half a token), and every challenge, receipt and catalog listing names the currency so nothing is mistaken for dollars. The reference deployment runs one such gateway next to the dollar ones, with the same routes:

```json
{
  "realm": "token-testnet.paidwithtab.com",
  "rail": "evm",
  "currency": "TTT",
  "evm": { "chain_id": 46630, "token": "0x8f6fe411e76b79d6eb6521872340c37c3210ee47", "decimals": 18, "...": "..." }
}
```

`examples/spec-token-testnet.json` and `examples/tab-gateway-token-testnet.service` are that gateway (port 1406, TTT, an open-mint test token with 18 decimals on Robinhood Chain testnet; `scripts/evm-mint.ts` mints it). `examples/spec-token.json` and `examples/tab-gateway-token.service` are the mainnet pair with the token fields left to fill in. What buyers see: `tab fetch` and the MCP server pay in USD unless `--currency TTT` or `TAB_CURRENCY=TTT` says otherwise, and refuse a token-priced challenge before signing anything; a mandate's budget and cap are in the gateway's currency, so issue one mandate per currency, each with its own `--allow` realm. `tab evm approve`, `balance` and the mint script read the contract's decimals, so amounts are always whole tokens on the command line.

---

## 10. The catalog service

`tab catalog serve` is discovery for buyers and hosts the front end.

| Endpoint | What |
| --- | --- |
| `GET /` | the landing page if `web/index.html` is present, otherwise the catalog app |
| `GET /product`, `/developers`, `/providers`, `/docs` | the site's pages (`web/<name>.html`, styled by `web/site.css`) |
| `GET /catalog` | the catalog app (`web/catalog.html`) |
| `GET /README.md`, `/SPEC.md`, `/DEPLOY.md` | the three documents at the repo root, as `text/markdown`; the docs page links to them |
| `GET /logo.png` | the wordmark used by every page |
| `GET /hero.jpg` | the landing page hero background |
| `GET /earth-day.jpg`, `/earth-night.jpg`, `/earth-water.png` | the maps the landing page globe is drawn from |
| `GET /inter.woff2`, `/instrument-serif-italic.woff2`, `/geist-mono.woff2` | the site's fonts, as `font/woff2` |
| `GET /v1/catalog.json` | every known gateway with services and routes |
| `GET /v1/search?q=&max_price=` | route search, route-level text matches outrank service-level, cheapest first; results carry the full URL to call |
| `POST /v1/announce {origin}` | fetch and verify `<origin>/.well-known/tab`, store it |
| `POST /v1/refresh` | re-fetch every stored gateway now (also runs every 60 s) |
| `POST /v1/mandate/verify {mandate, realm}` | check a mandate's signature, expiry and realm, return it decoded |
| `GET /v1/wallet?origin=&wallet=` | proxy a balance lookup to a gateway |
| `GET /v1/receipts?limit=` | receipts aggregated from every gateway with `public_receipts` |
| `GET /v1/try` | is the try-it agent configured, and its limits |
| `POST /v1/try {url, method, body}` | pay for a catalogued route with the try-it agent, return status, receipt and body |

The front end is static files under `web/` with no build step and no external scripts or fonts: the landing page at `/` (about 1360 lines, self-contained; most of it is the WebGL2 globe fixed behind the page, which the scroll carries from the hero's horizon round the sections to the closer, and which takes over from `hero.jpg` once its three maps have loaded), four pages at `/product`, `/developers`, `/providers` and `/docs` that share `web/site.css`, and the catalog app at `/catalog` (265 lines). The catalog app links `evm:` receipts to the gateway's own explorer (`rail_info.explorer`, defaulting to `explorer.testnet.chain.robinhood.com`); that is the only outbound URL in either file. Serve them from the catalog process or copy them anywhere static and point the app at the catalog with a reverse proxy on the same origin (it fetches relative `/v1/...` paths).

---

## 11. Gateway HTTP surface

| Endpoint | What |
| --- | --- |
| `GET /.well-known/tab` | discovery: version, realm, rail, rail_info, recipient, services, routes, and `faucet` when starter credits are on |
| `GET /.well-known/tab/wallet/<id>` | available balance of a wallet on this rail |
| `GET /.well-known/tab/receipts?limit=` | last receipts, only if `public_receipts` |
| `POST /.well-known/tab/faucet {wallet}` | starter credits, only with `--faucet`: credits the wallet once, 429 past the per-address limit |
| `GET /.well-known/tab/receipts?payer=&since=` | the same, filtered to one payer wallet and/or receipts at or after an ISO time |
| `GET /.well-known/tab/mandate/<id>/spent` | what one mandate has spent here, total and per window; a mandate id is the hash of a document only its owner and agent hold |
| `OPTIONS /.well-known/tab*` | CORS preflight |
| any priced route | 402 with `WWW-Authenticate: Tab …` until paid; then proxied |
| any unpriced path | 404 `not-found`, never proxied |

Every 402 body is an RFC 9457 problem with `type: urn:tab:problem:<code>` and a fresh challenge in `WWW-Authenticate`. Codes: `payment-required`, `malformed-credential`, `invalid-challenge`, `payment-expired`, `verification-failed`, `mandate-invalid`, `mandate-denied`, `mandate-exceeded`, `insufficient-funds`. A body that breaks a route's `body_allow` or `body_fixed` rule (section 8.3) is 400 `bad-request` before any challenge. Upstream unreachable is 502 `upstream-failed`, nothing charged. Upstream non-2xx is passed through with a `Tab-Void` header and the hold released.

The verification order and the reasons for it are in `SPEC.md` section 4. The short version: the challenge id is an HMAC over amount, recipient, resource and expiry with a per-database secret, so the gateway keeps no state per challenge and any edited challenge fails first; a challenge id can be redeemed once (insert-before-reserve, so two racing copies cannot both pay); the mandate budget check and the funds check are one SQLite transaction.

---

## 12. State, secrets and backups

| File | Owner | Contains | Lose it and… |
| --- | --- | --- | --- |
| `tab.db` (+ `-wal`, `-shm`) | gateway | HMAC secret, ledger wallets and balances, holds, receipts, mandate spend counters, redeemed challenge ids | ledger balances are gone; spend counters reset (mandates start fresh); outstanding challenges die harmlessly |
| `tab-evm.db` (if you name it that) | evm gateway | same minus wallets; holds carry the signed transaction until capture | spend counters reset; on-chain state is unaffected |
| `catalog.db` | catalog | announced gateways | re-announce or `--seed` |
| `company.db` | company server | accounts (scrypt hashes), sessions, companies with **custodial owner and agent keys** and **sealed model keys**, tickets, events, runs, the signed board log | companies are gone and their owner wallets with them unless the keys were exported; mode 600, back it up |
| `company.db.key` | company server | the 32-byte master key the companies' model keys are sealed under (AES-256-GCM, company id as AAD); created on first start, mode 600 | every company must paste its Anthropic key again; back it up next to the database |
| `keys/*.json` | you | private keys, mode 0600 | seller: cannot spend earnings. owner: cannot issue mandates or move funds. feepayer: gateway cannot broadcast. agent: mandate is useless |
| `keys/mandate-*.json` | you | signed mandates, not secret but grant spending | re-issue from the owner key |

Backup: stop the service or use `sqlite3 tab.db ".backup tab.bak"` for a consistent copy while running. The database is in WAL mode, so copying only `tab.db` while a process is writing can miss recent commits. Back up `keys/` to somewhere encrypted and off the box.

The gateway prunes redeemed challenge ids older than one hour every ten minutes. Holds and receipts are kept forever; the tables are small (one row per paid call).

---

## 13. Letting Claude Code spend

`tab mcp` is a Model Context Protocol server on stdio, implemented without an SDK. It exposes five tools: `tab_limits`, `tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`. It runs **where Claude Code runs**, not on the gateway, and needs only an agent key, a mandate, and network access to the gateway and catalog.

The short way, for a buyer who ran `tab init` (keys and mandate in `~/.tab`, catalog defaulting to `https://paidwithtab.com`):

```sh
claude mcp add --scope user tab -- npx -y paidwithtab mcp
```

Register it for one project with explicit files by keeping `.mcp.json` next to the code:

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
import { TabClient, tabFetch, receiptOf, PaymentRefused } from 'paidwithtab/client';

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
| `ui not found` at `/` or `/catalog` | `web/` not next to `dist/` | keep the tree layout; catalog looks in `../web` and `../../web` relative to `catalog.js`, and serves any `web/<name>.html` at `/<name>` |
| `npm test` hangs or is slow | it is doing ~50 real HTTP round trips plus a catalog refresh; 1 to 2 minutes is normal | run with `SCRATCH=/some/fast/dir` |

---

**An upstream on another continent fails with `upstream-failed` although `curl` reaches it.** Node's fetch gives each address of a host 250 ms to connect before trying the next; a round trip alone can take that long from far away. `tab serve` raises that to 2 s at startup (`setDefaultAutoSelectFamilyAttemptTimeout`), from 0.4.2. On older builds, start node with `--network-family-autoselection-attempt-timeout=2000`.

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

From the README roadmap, so you do not go looking for it: x402 client compatibility, per-token or metered pricing and payment channels, windowed budgets on-chain, header binding, subscriptions, fee splits, EIP-4337 gas sponsorship. (Body digest and query binding shipped in draft 0.1; the evm rail in 0.2; `tab init` and the starter-credits faucet in 0.4; companies of agents, with a company earning through its own gateway, in 2.1; bring-your-own model keys and the API-based claude adapter in 2.2; signed receipts in 2.3.)

Starter credits are not a wallet product: they live in one gateway's ledger and cannot be moved, topped up with a card, or spent on another gateway. The path from starter credits to real money is still the evm rail with a funded owner account.

---

## 19. The reference deployment

The gateways behind paidwithtab.com (pay, testnet and mainnet) run exactly as sections 8, 9 and 19.3 describe, from `examples/spec-public.json`, `examples/spec-testnet.json` and `examples/spec-mainnet.json`, with the unit files in `examples/`. The operator's own notes for that box, the go-live and chain trial scripts and the launch plan, live in a private repository and are not part of this project.

### 19.3 Paid routes and provider keys


Three services in the public specs front paid providers. The gateway injects the provider key as an upstream header, so buyers never see it and the spec never holds it. Each service names the variable it needs in `requires`; if that variable is unset or empty when the gateway starts, the service is skipped with a log line instead of being listed broken. Set the key, restart the unit, and the routes appear in discovery and in the catalog within seconds.

| Route | Provider | Buyer pays | Provider charges you | Key |
| --- | --- | --- | --- | --- |
| `POST /search` | Tavily, `api.tavily.com/search` | $0.01 | about $0.008 per search | `TAVILY_API_KEY` |
| `POST /extract` | Tavily, `api.tavily.com/extract` | $0.01 | per page | `TAVILY_API_KEY` |
| `POST /translate` | DeepL, `api-free.deepl.com/v2/translate` | $0.02 | free tier 500k chars a month; pro is `api.deepl.com`, change the upstream | `DEEPL_API_KEY` |
| `POST /speech/listen` | Deepgram, `api.deepgram.com/v1/listen` | $0.02 | about $0.0043 per audio minute | `DEEPGRAM_API_KEY` |
| `POST /speech/speak` | Deepgram, `api.deepgram.com/v1/speak` | $0.02 | about $0.03 per 1k characters | `DEEPGRAM_API_KEY` |
| `POST /google/search`, `/news`, `/images` | Serper, `google.serper.dev` | $0.005 | about $0.001 per search | `SERPER_API_KEY` |
| `POST /exa/search`, `/contents` | Exa, `api.exa.ai` | $0.01 | about $0.007 per search | `EXA_API_KEY` |
| `POST /scrape/scrape` | Firecrawl, `api.firecrawl.dev/v1` | $0.005 | $0.001 to $0.003 per page | `FIRECRAWL_API_KEY` |
| `GET /brave/web/search`, `/news/search` | Brave Search, `api.search.brave.com` | $0.005 | per query, free tier available | `BRAVE_API_KEY` |
| `POST /ocr/text` | Mathpix, `api.mathpix.com/v3` | $0.005 | about $0.002 per image | `MATHPIX_APP_ID`, `MATHPIX_APP_KEY` |
| `POST /image/fal-ai/flux/schnell` | fal.ai, `fal.run` | $0.05 | about $0.003 per image | `FAL_KEY` |

The last six were written from each provider's documentation and have not been exercised with a real key yet; test one call after setting the key and fix the spec if the provider's shape has moved. Sixteen more services front keyless public APIs (Open-Meteo geocoding, air quality and marine, arXiv, Hacker News, Open Library, Wikidata, Nominatim, Crossref, PubMed, USGS, Stack Exchange, CoinGecko, GitHub, OpenAlex) and were each exercised with a paid call on 2026-10-12. Services that need a User-Agent to be admitted carry one in `upstream_headers`.

Keys live in `~/tab/.env` (mode 600, gitignored; `examples/env.example` is the template). The three gateway units read it through `EnvironmentFile=-%h/tab/.env`, so one file feeds all three rails. The try-it mandate behind the Buy button caps a call at $0.01, so `/search` works from the site and the two $0.02 routes need a buyer's own mandate.

### 19.2 Backups

`bash scripts/backup.sh` copies every `*.db` with SQLite's online backup API and every file in `keys/` into `~/tab-backups/tab-<stamp>.tar.gz` (mode 600), then extracts the archive to a temp directory and runs `pragma integrity_check` on each database before reporting success. It keeps the last 30 archives. `bash scripts/backup.sh --verify-only <archive>` repeats the restore test on an old archive. Run it daily from cron, and copy the archives off the box; a backup that lives only on the machine it protects is not a backup.

---

## 20. The company server

`tab company serve` is the orchestrator described in `docs/company.md`: accounts, companies, agents, tickets, runs, and the signed board log, in one process on `company.db`. The reference deployment runs it at app.paidwithtab.com from `examples/tab-company.service` on port 1407, behind the same Cloudflare tunnel as the other hosts (`app.paidwithtab.com -> http://127.0.0.1:1407` in the tunnel's ingress).

Install:

```sh
cp examples/tab-company.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now tab-company
journalctl --user -u tab-company -f
```

What to check before opening it up:

- `--host app.paidwithtab.com` (or your hostname) is on the command line. Any other Host header is answered 421; that is the DNS rebinding defence, and it also means a request through the tunnel with the wrong hostname fails loudly instead of quietly serving.
- Claude agents run in the server process against the Anthropic Messages API on each company's own key, with the tab tools and nothing else; the hosted unit runs with neither `--local-claude` nor `--host-model-key`, so no sign-up can spend the host's accounts or run a binary on the box. A self-hosted server may add either; with `--local-claude`, `claude --version` must work as the service user and that account must be signed in (the unit's `Environment=PATH=` names `~/.local/bin` for that case).
- `company.db` is mode 600. It holds scrypt password hashes, sessions, the custodial owner and agent keys of every hosted company, and their model keys sealed under `company.db.key` (also mode 600, created on first start). `scripts/backup.sh` includes the database; copy the key file next to it.
- `company.db.work/<company id>/` is where claude-code agents write files, where that adapter is on; it grows with use.
- No `--allow-private-origins`. Companies name gateways by origin and the server fetches their discovery documents; the private-address check is what keeps that from reaching internal services.
- The default gateway (`--gateway`) is where a new company spends unless it names one; starter credits for the owner wallet come from that gateway's faucet when it has one. The public ledger gateway does, so a hosted company can run on sandbox credits before anyone funds a real wallet.
- Sign up and log in are rate limited per client address, 20 per 15 minutes, using `cf-connecting-ip` first, so the tunnel's address does not count as one client.

The surface is the JSON API under `/api/` (every route in `src/company/server.ts`, all authenticated except sign up, log in, health and templates) and the dashboard at `/`. The CLI client commands talk to the same API with a bearer token.

