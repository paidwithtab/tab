# tab launch plan

Written 2026-10-11 against version 0.3.0. Goal: a stranger can discover a priced route on paidwithtab.com, pay for it from Claude Code or the client, and see the receipt, first on Robinhood testnet, then on mainnet with real money.

State today: code builds, 51 e2e tests pass, paidwithtab.com serves the site, and the catalog is empty. No gateway is live, the npm package is unpublished, and mainnet settlement has never been exercised.

The phases are ordered so that each one leaves something a user can touch. Do not start a later phase until the earlier checklist is fully ticked.

---

## Phase 0: baseline on the production box (half a day)

Everything below assumes the VPS layout from DEPLOY.md section 8 (`/opt/tab`, service user `tab`, systemd units, nginx with TLS).

- [ ] `git pull` on the box so the deployed tree matches `main` (last push was 2026-09-12; the site is ahead of what is deployed).
- [x] `npm ci && npx tsc --noEmit && npm run build`
- [x] `npm test`, `npm run test:adversarial`, `npm run test:evm` all green on the box, not just the dev machine.
- [x] Node version on the box is 22.13 or newer (`node --version`).
- [ ] Backups of `keys/` and every `*.db` tested once by restoring to a temp directory.

---

## Phase 1: publish the package (one hour)

Buyers must be able to install the client and the MCP server without cloning.

- [x] `npm whoami` as the account that owns the `paidwithtab` name (or claim it; the registry returns 404 today).
- [x] `npm publish --dry-run` and check the tarball holds `bin`, `dist/src`, `web`, `docs`, `SPEC.md`, `DEPLOY.md` and nothing from `keys/` or `*.db`.
- [x] `npm publish` (the `prepublishOnly` script builds and runs the e2e suite first).
- [x] `npx paidwithtab --help` works from a clean directory on another machine.
- [x] README install section says `npm i paidwithtab` and the quickstart no longer requires `git clone`.
- [ ] Tag the release: `git tag v0.3.0 && git push --tags`.

---

## Phase 2: one live gateway with real APIs on testnet (one to two days)

This is the step that makes the catalog non-empty. Run it yourself; you are the first seller.

### 2.1 Pick the first routes

From `examples/catalog-candidates.md`, header-auth only, cheap per call, no shim needed:

| Route | Upstream | Price |
| --- | --- | --- |
| web search | Tavily `POST /search` | $0.01 |
| read a URL as markdown | Jina Reader `GET r.jina.ai/<url>` | $0.003 |
| translate | DeepL `POST /v2/translate` | $0.03 per 1k chars, flat per call to start |
| speech to text | Deepgram `POST /v1/listen` | $0.01 per minute, flat per call to start |

- [ ] Provider accounts created, API keys in `/opt/tab/.env` (mode 0600), never in the spec.
- [ ] `/opt/tab/spec.json` written from `examples/spec-evm.json` with `realm: pay.paidwithtab.com`, `rail: evm`, chain id 46630, testnet USDC `0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5`, `public_receipts: true`.
- [ ] Each route has a one-line `description` that reads well in search results (buyers find routes by text).

### 2.2 Keys and funding

- [ ] `tab key new --out keys/seller.json` and `tab evm address keys/seller.json` is the `evm.recipient` in the spec.
- [ ] Owner key generated on a machine that is not the server; only its 0x address and signed mandates go to the box.
- [ ] Owner address holds testnet ETH (faucet at `https://faucet.testnet.chain.robinhood.com/`) and testnet USDC.

### 2.3 Run it

- [ ] DNS: `pay.paidwithtab.com` points at the box; nginx vhost with TLS proxies to port 1402.
- [ ] systemd unit for the gateway from DEPLOY.md section 8.4, with `--announce http://127.0.0.1:1403 --origin https://pay.paidwithtab.com`.
- [ ] `curl https://pay.paidwithtab.com/.well-known/tab` returns the discovery document with every route.
- [ ] `curl https://paidwithtab.com/v1/catalog.json` lists the gateway; `/v1/search?q=translate` returns the DeepL route.
- [ ] Ports 1402, 1403 and 1404 are firewalled; only nginx is reachable.

### 2.4 First paid call, as a stranger would do it

On a laptop, not the server, using the published package:

- [ ] `tab key new --out agent.json`, fund it with `tab evm fund --eth 0.005`.
- [ ] `tab mandate issue --owner owner.json --agent agent.json --budget 1.00 --max-per-call 0.05 --days 7`.
- [ ] `tab evm approve --owner owner.json --agent agent.json --amount 1.00 --token <testnet USDC>`.
- [ ] `tab fetch --agent agent.json --mandate mandate.json -X POST -d '{...}' https://pay.paidwithtab.com/...` returns 2xx and a receipt with `ref: evm:<tx hash>`.
- [ ] The tx is visible on `explorer.testnet.chain.robinhood.com` and the receipt appears at `https://paidwithtab.com/v1/receipts`.
- [ ] Time the whole thing from a blank laptop and write down every step that confused you. That list is Phase 4.

### 2.5 Try-it on the site

- [ ] Catalog restarted with `--try-agent` and `--try-mandate` pointing at a mandate with a budget you are happy to lose (`--window day`, `--try-max-per-call 0.05`).
- [ ] The "Buy" button on `/catalog` completes a paid call and shows the receipt.
- [ ] Catalog is running without `--allow-private-origins`.

---

## Phase 3: mainnet settlement (one day, after Phase 2 is ticked)

Robinhood Chain mainnet launched 2026-07-01. Bridged USDC arrives there as USDG (Paxos), not USDC. The rail accepts any 6-decimal ERC-20, so this should be configuration, but nobody has verified it.

- [x] Confirm the USDG contract address on mainnet (chain id 4663) from `robinhoodchain.blockscout.com`, and that `decimals()` returns 6. If it does not, the rail needs a decimals change before anything else.
- [ ] A paid RPC endpoint (Alchemy, QuickNode or dRPC) in `EVM_RPC` instead of the public one.
- [ ] Bridge a small amount (under $20) of USDC to Robinhood Chain and confirm it lands as USDG at the owner address.
- [ ] Second gateway spec, or a second realm, with chain id 4663, the USDG token and the mainnet explorer.
- [ ] One real paid call end to end with real money; receipt visible on the mainnet explorer.
- [ ] `tab evm revoke` tested on mainnet so you know the kill switch works.
- [x] DEPLOY.md section 9 mainnet row updated with the real token address and the USDG naming.
- [ ] README and site copy say "USDG on Robinhood Chain mainnet, USDC on testnet" or whatever turns out to be true. Do not say USDC mainnet if it is not.

### Security checklist before real money (DEPLOY.md section 17, copied here so it gets ticked)

- [ ] Owner key never on the server.
- [ ] `keys/` mode 0700, key files 0600, owned by the service user.
- [ ] Agents hold only working-capital ETH for gas.
- [ ] `public_receipts` reviewed: payer wallet ids will be public.
- [ ] `npm run test:adversarial` green on the box after the mainnet config change.
- [ ] SPEC.md section 9 limits understood: credentials do not bind headers; no dispute window; a signed but unserved payment is broadcastable until the nonce moves.

---

## Phase 2b: what shipped on 2026-10-11 (version 0.4.0)

Instead of asking every buyer to fund a chain account before their first call, the public gateway runs on the ledger rail and hands out starter credits. The first run is now one command.

- [x] `tab serve --faucet 1.00`: `POST /.well-known/tab/faucet {wallet}` credits a wallet once, rate limited per address; advertised in discovery.
- [x] `tab init`: owner key, agent key, daily mandate, faucet claim, prints the `claude mcp add` line. Idempotent.
- [x] `tab fetch` and `tab mcp` default to `~/.tab`; `tab mcp` defaults the catalog to paidwithtab.com.
- [x] `examples/spec-public.json`: six routes over keyless APIs (Jina Reader, Wikipedia summary and search, Open-Meteo forecast, Frankfurter latest and by date), verified paid end to end against the live upstreams.
- [x] Tests: 59 e2e (8 new), 24 adversarial, all green. README, docs and DEPLOY.md section 19 rewritten around `npx paidwithtab init`.
- [ ] Deploy on the box: `bash scripts/go-live.sh` (units, tunnel ingress, DNS, catalog with the Buy button, announce). Prepared 2026-10-11; needs the operator's sudo.
- [x] Chain gateways prepared: `examples/spec-testnet.json`, `examples/spec-mainnet.json`, their units, and `scripts/chain-trial.sh` for the first paid call on each chain. All owner, agent and seller balances were zero on both chains on 2026-10-11.
- [x] `npm publish` (needs `npm login`). Published 2026-10-11 as 0.4.0.
- [ ] Enable the catalog's Buy button with a try-it mandate on the public gateway.

## Phase 4: make the first run survivable (one week)

Everything a new buyer hits before their first paid call. Prioritise by what Phase 2.4 showed.

- [ ] `tab init` or a quickstart script: one command that creates an agent key, requests testnet ETH, issues a mandate from a local owner key and prints the MCP config. Target: under five minutes from `npx paidwithtab` to a paid call on testnet.
- [ ] A faucet-backed demo mandate on the site so a visitor can try one call without touching a chain. The try-it agent already does this server side; expose a copyable mandate and agent key with a tiny daily budget.
- [x] `claude mcp add` one-liner in the README using the published package, not `src/cli.ts`.
- [ ] Gas: decide whether to sponsor it. Until EIP-4337 ships, the fallback is a "fund my agent" page that sends 0.005 ETH on testnet from a hot wallet with a rate limit. Without this, every new user stalls at gas.
- [ ] Error messages from `tab fetch` point at the fix (mandate realm mismatch, no allowance, no gas, expired mandate). Check each one by causing it.

---

## Phase 5: other sellers (ongoing)

- [ ] `docs/sellers.md` walkthrough re-done from scratch on a fresh VPS, timed, every snag fixed.
- [ ] Seller announcement is self serve: `POST /v1/announce` works for a stranger's origin and the catalog shows it within a minute.
- [ ] Three outside sellers approached with a concrete offer: here is a spec template for your API, here is what buyers see, here is a receipt.
- [ ] A moderation story for the catalog: how to remove a gateway that misbehaves (today: delete the row in `catalog.db` and restart).

---

## Phase 6: credibility (ongoing, in parallel with 4 and 5)

- [ ] The site shows live numbers from `/v1/receipts`: calls paid, services listed. Zero is honest; hide the block until it is not zero.
- [ ] Repo: a release on GitHub, a CHANGELOG, issues enabled, and one pinned "good first issue".
- [ ] A recorded two-minute demo of Claude Code paying for a search under a mandate, linked from the hero's "Watch demo" button (today it scrolls to the animation).
- [ ] Announce on X once Phases 1 to 3 are ticked, not before. A visitor who finds an empty catalog does not come back.

---

## Not now

From the roadmap, and deliberately parked until there are paying users: x402 compatibility, agents as sellers, metered or per-token pricing, payment channels, windowed on-chain budgets, header binding, subscriptions, fee splits. Gas sponsorship is the one exception and sits in Phase 4.

---

## Definition of done

- [ ] `npx paidwithtab` installs.
- [ ] `paidwithtab.com/catalog` lists at least four real routes behind `pay.paidwithtab.com`.
- [ ] A new user on a blank laptop completes a testnet paid call in under ten minutes following only the README.
- [ ] One mainnet payment settled and visible on the explorer.
- [ ] Every box in the security checklist is ticked.
