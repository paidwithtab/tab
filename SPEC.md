# The tab protocol, draft 0.3

How an agent pays a gateway for one HTTP request, under a spending grant its owner signed offline. Wire format and verification rules. `README.md` is the pitch, `DEPLOY.md` the operator's manual; this document is normative for `ver: "tab/0"` (the wire version is unchanged from draft 0; draft 0.1 made the request commitment of §3.2 mandatory, draft 0.2 added the `evm` rail for Robinhood Chain and the `evm_owner` mandate field, draft 0.3 made `evm` the sole settlement rail).

## 1. Model and terms

| Term | Meaning |
| --- | --- |
| **owner** | holds the funds; signs mandates offline; is never online during a payment |
| **agent** | holds its own key and a mandate; signs a credential per call |
| **gateway** | fronts an upstream API; issues challenges, verifies, reserves, forwards, captures on 2xx |
| **realm** | the string a gateway names itself with (`spec.realm`); mandates allow-list realms |
| **rail** | how money settles: `ledger` (gateway SQLite sandbox) or `evm` (ERC-20 stablecoin on Robinhood Chain) |
| **resource** | `"METHOD /path"`: the priced thing being bought |

All protocol objects are JSON. All amounts are **micro-USD** integers carried as decimal strings (`"10000"` = $0.01). Prices in gateway specs are USD strings with up to six decimals. On the evm rail, one micro-USD equals one base unit of a 6-decimal token (USDC).

**Canonical JSON**, used for everything that is signed or hashed: object keys sorted lexicographically at every depth, no insignificant whitespace, `undefined` members dropped, arrays kept in order.

**Keys.** Ed25519 at the protocol layer. A wallet id **is** a raw 32-byte public key, base64url; signatures are 64 bytes, base64url. The same key file's 32-byte seed doubles as a secp256k1 scalar for the evm rail (§5.2).

## 2. The mandate

The owner signs it once; it is not a secret, but it grants spending, so treat it like a bearer instrument bound to one agent key.

```json
{
  "ver": "tab/0",
  "id": "<base64url sha256 of the canonical body>",
  "owner": "<wallet id>",
  "agent": "<wallet id>",
  "budget": "1000000",
  "window": "total" | "day",
  "max_per_call": "50000" | null,
  "allow": ["*.example.com"],
  "issued_at": "…ISO 8601…",
  "expires_at": "…ISO 8601…",
  "evm_owner": "0x…",
  "sig": "<owner signature over the canonical body>"
}
```

`evm_owner` (optional, lowercase 0x hex) is the owner's EVM account, attested by the owner's signature; the evm rail refuses mandates without it, and payments may only `transferFrom` that address, so an agent cannot point a mandate at someone else's allowance. The *body* is the object minus `id` and `sig`. `id = sha256(canonical(body))`; `sig` is the owner's Ed25519 signature over the same bytes. `window: "day"` resets the budget each UTC calendar day; `"total"` is a lifetime budget. `allow` entries are globs over realms (`*` matches any run of characters); an empty list is invalid; use `["*"]`.

On the evm rail the mandate has an on-chain half: the owner approves the agent as ERC-20 spender on the token (section 5.2). The mandate caps what the gateway will accept; the allowance caps what the chain will move. Both must hold.

## 3. Challenges and credentials

### 3.1 Challenge

A gateway answers any unpaid request to a priced route with **402** and:

```
WWW-Authenticate: Tab challenge="<base64url(challenge JSON)>"
```

```json
{
  "ver": "tab/0",
  "id": "<base64url HMAC-SHA256>",
  "realm": "apis.example.com",
  "rail": "ledger" | "evm",
  "amount": "10000",
  "currency": "USD",
  "recipient": "<wallet id>",
  "resource": "GET /v1/things/42",
  "expires_at": "…ISO 8601…",
  "evm": { "chain_id": 46630, "token": "0x…", "decimals": 6, "recipient": "0x…",
           "max_fee_per_gas": "0x…", "max_priority_fee_per_gas": "0x…", "gas_limit": 250000 }
}
```

`id` is `HMAC-SHA256(secret, canonical(challenge minus id))` with a per-database secret the gateway generates once. The gateway therefore keeps **no state per challenge**: any edited challenge fails the HMAC before anything else is looked at. `expires_at` is ~120 s ahead. The `evm` member exists only on that rail; `evm.recipient` is the seller's payout address and the fee fields are what the agent's transaction must use verbatim.

### 3.2 Credential

The buyer retries the same request once with:

```
Authorization: Tab <base64url(credential JSON)>
```

```json
{
  "ver": "tab/0",
  "agent": "<wallet id>",
  "challenge": { …the challenge, echoed verbatim… },
  "mandate": { …the mandate… },
  "request": { "query": "?x=1", "body_sha256": "<base64url sha256 of the body>" },
  "sig": "<agent signature>",
  "evm": { "tx": "<0x hex fully-signed type-2 transaction>" }
}
```

`request` is the **request commitment**: `query` is the URL search string exactly as sent (`""` if none) and `body_sha256` is the SHA-256 (base64url) of the request body, or of zero bytes for bodyless requests. `sig` is the agent's signature over the canonical JSON of

```json
{ "agent": …, "amount": …, "body": "<body_sha256>", "challenge": "<challenge id>",
  "mandate": "<mandate id>", "query": …, "realm": …, "recipient": …, "resource": … }
```

so a credential authorizes **exactly this request** (method, path, query and body) for exactly this amount under that one challenge id, not merely "any call to the route". The `evm` member is required on the evm rail and absent on the ledger rail.

### 3.3 Receipts and voids

On success the response carries `Tab-Receipt: <base64url(receipt JSON)>`, which decodes to `{id, realm, resource, amount, currency, rail, payer, owner, recipient, ref, at}` with `ref` = `ledger:<hold id>` or `evm:<tx hash>`. If the upstream answered non-2xx, the response is passed through unchanged plus `Tab-Void: <hold id>` and nothing is charged. The upstream itself receives `Tab-Payer`, `Tab-Owner` and `Tab-Hold` request headers for attribution; the buyer's `Authorization` header is stripped and the gateway's `upstream_headers` are injected.

## 4. Verification order

The gateway verifies in exactly this order. Each failure is a fresh 402 (RFC 9457 problem, `type: urn:tab:problem:<code>`, plus a fresh challenge in `WWW-Authenticate`), except where noted.

1. **Parse** the `Authorization` header. Not base64url JSON of the right shape → `malformed-credential`. On the evm rail, a missing or unparseable embedded transaction is also `malformed-credential`.
2. **Challenge authenticity**: recompute the HMAC id. Mismatch → `invalid-challenge`. Because the id covers every challenge field, this single check makes all downstream fields trustworthy without server-side challenge state.
3. **Challenge relevance**: `realm`, `rail`, `recipient`, `amount` and `resource` must equal what this gateway would charge for this request → else `invalid-challenge`. (An HMAC-valid challenge for a cheaper route must not pay for a dearer one.)
4. **Challenge expiry** → `payment-expired`.
5. **Mandate validity**: structure, id = hash of body, owner signature, not expired → `mandate-invalid`.
6. **Agent binding**: `credential.agent` must equal `mandate.agent`, and `sig` must verify against the agent key over the full commitment including `request` → `verification-failed`. A credential with no `request` member is `malformed-credential`.
7. **Request commitment**: the query string and the SHA-256 of the body **actually received** must equal what the agent signed → `verification-failed`. (Without this, a party able to see or alter the buyer's traffic could swap the body of an authorized POST within the challenge TTL.)
8. **Realm allow-list**: the gateway's realm must match a mandate glob → `mandate-denied`.
9. Inside **one SQLite transaction**:
   a. **Single redemption**: insert the challenge id into the redeemed set; a duplicate → `invalid-challenge`. Insert-before-reserve means two racing copies of one credential cannot both pay.
   b. **Per-call cap**, then **window budget** (spend counter keyed by mandate id and UTC day for `day` windows) → `mandate-exceeded`.
   c. **Rail reservation.** Ledger: debit the owner's balance or `insufficient-funds`. Evm: parse the type-2 transaction, recover its sender from the secp256k1 signature, and require every field (chain id, fees, gas limit, token contract, value, `transferFrom(mandate.evm_owner, challenge recipient, amount)` calldata) to equal what the challenge dictates; only the nonce is the agent's to choose (→ `verification-failed`).
   d. evm only: the keccak hash of the raw transaction is stored **UNIQUE across non-voided holds**, so one signed payment can never back two served calls (→ `invalid-challenge`, "payment transaction already used"). A voided hold frees its hash: after a void the same nonce legitimately produces the same bytes.
10. After the transaction commits, the rail's chain checks (evm): the sender's nonce must equal the account's pending nonce (→ `payment-expired`), the sender must afford `gas_limit × max_fee_per_gas` (→ `insufficient-funds`), and an `eth_call` **dry run** of the transfer must not revert (revert → `insufficient-funds`: owner balance or allowance short, or the allowance revoked). On failure the spend counter is refunded and the hold voided; the redeemed challenge id stays burned.
11. **Forward upstream.** Unreachable or timed out → **502** `upstream-failed`, hold released, nothing charged. Non-2xx → passed through with `Tab-Void`, hold released, budget refunded.
12. **Capture** on 2xx. Ledger: credit the recipient. Evm: broadcast and wait for the receipt. Only now does money move. If broadcasting fails after a 2xx, the hold is voided and the buyer gets the response uncharged; the failure mode is always in the buyer's favor.

Rationale for the order: the cheapest, stateless checks run first; nothing touches the database until the credential is proven genuine; money is reserved before the upstream does any work but only *moves* after the upstream succeeded.

## 5. Rails

### 5.1 `ledger`

Balances are rows in the gateway's SQLite file, created by `tab mint`. Reserve = debit owner, capture = credit recipient, release = credit owner back. Sandbox semantics: balances are per gateway database and mean nothing anywhere else.

### 5.2 `evm` (Robinhood Chain)

USDC (or any 6-decimal ERC-20) on an EVM chain. Built for **Robinhood Chain**, an Arbitrum-stack L2 (chain id 46630 testnet, 4663 mainnet); any EVM chain with the same shape works. No custom contract.

Identity: a tab key file's 32-byte private seed doubles as a secp256k1 scalar (`d = seed mod (n-1) + 1`), so one key file yields both the Ed25519 wallet id and an EVM address (`tab evm address`). The protocol layer (mandates, credentials) stays Ed25519; only the payment transaction is secp256k1.

Setup, once: the owner calls ERC-20 `approve(agentAddress, amount)` on the token (`tab evm approve`). The allowance decrements with every `transferFrom` and `approve(agent, 0)` revokes it instantly (`tab evm revoke`). The agent's account also needs a little ETH: EVM has no native fee-payer co-signing, so the transaction sender, the agent, pays gas (`tab evm fund` moves some over; bound per call by `gas_limit × max_fee_per_gas`, which the agent signs).

Per payment the agent builds an EIP-1559 transaction from the challenge (to = token, value 0, calldata `transferFrom(evm_owner, challenge.evm.recipient, amount)`, fees and gas limit verbatim from the challenge), choosing only the nonce, which it reads from the gateway (`GET /.well-known/tab/evm/nonce/<0xaddress>`), so clients still need no RPC of their own. The gateway parses the transaction, recovers the sender, checks every field, enforces raw-tx-hash uniqueness, dry-runs the transfer, forwards upstream, and broadcasts only on 2xx. Receipt `ref` is `evm:<tx hash>`; `rail_info.explorer` (e.g. explorer.testnet.chain.robinhood.com) tells front ends where a ref can be viewed.

## 6. Discovery

`GET /.well-known/tab` on a gateway:

```json
{ "ver": "tab/0", "realm": "…", "rail": "ledger", "rail_info": { … },
  "recipient": "<wallet id>",
  "services": [ { "name": "…", "prefix": "…", "description": "…",
      "routes": [ { "method": "GET", "path": "/v1/things/:id", "price": "0.01", "description": "…" } ] } ] }
```

Also `GET /.well-known/tab/wallet/<id>` (available balance on this rail) and, if the gateway opted in, `GET /.well-known/tab/receipts?limit=` (last 200). All JSON endpoints send `Access-Control-Allow-Origin: *`. Unpriced paths are 404 and never proxied; `"0"`-priced routes are proxied unpaid.

The catalog's own API (`/v1/catalog.json`, `/v1/search`, `/v1/announce`, `/v1/refresh`, `/v1/mandate/verify`, `/v1/wallet`, `/v1/receipts`, `/v1/try`) is descriptive, not part of the payment protocol; see `DEPLOY.md` section 10.

## 7. Problem codes

`payment-required`, `malformed-credential`, `invalid-challenge`, `payment-expired`, `verification-failed`, `mandate-invalid`, `mandate-denied`, `mandate-exceeded`, `insufficient-funds` (all 402), `not-found` (404), `upstream-failed` (502). Bodies are RFC 9457 problems with `type: urn:tab:problem:<code>`.

## 8. Conformance notes

- Challenges are single-use forever within one gateway database (redeemed ids are pruned after an hour, far beyond any challenge TTL).
- A buyer must treat the absence of `Tab-Receipt` on a 2xx as "not charged" (free route or voided capture).
- Clients retry exactly once; a second 402 is an answer, not an invitation to loop.
- Unknown members in any protocol object must be ignored (they may be minted by future drafts); unknown `ver` must be rejected.

## 9. Security considerations

- **The owner key never travels.** Payments require only the agent key and the mandate. Compromise of an agent key is bounded by the mandate budget, per-call cap, realm list and expiry, and on-chain additionally by the ERC-20 allowance, which the owner can revoke at any moment.
- **The gateway is trusted by the seller, not by the owner.** A malicious gateway can at most consume the mandate budget at the priced rates on its own realm; it cannot forge mandates (owner signature) and cannot move more than the agent signed: the transfer transaction is signed by the agent and field-checked against the challenge the agent accepted, and the gateway holds no payment key at all.
- **Replay** is stopped by single-redemption of the HMAC-bound challenge id, enforced with insert-before-reserve inside the same transaction as the budget and funds checks. On the evm rail the raw-transaction hash is additionally unique across non-voided holds, and the chain's own nonce rule stops on-chain replay.
- **A gateway holding a signed payment** can broadcast it without serving the call. The buyer's exposure is one priced call; the transaction stays valid until the agent's nonce moves, so an agent that stops trusting a seller should make any other payment (moving its nonce) or have the owner revoke the allowance.
- **Agent gas exposure (evm)**: a broadcast transaction costs the agent at most `gas_limit × max_fee_per_gas`, terms it signed. A hostile gateway could quote absurd fees; the agent implicitly accepts them by signing, so clients that pay strangers may want to sanity-cap `max_fee_per_gas`.
- **The budget race** (two concurrent calls straddling the limit) is closed by doing the spend-counter update and the funds reservation in one SQLite transaction.
- **Challenge forgery** is stopped by the per-database HMAC secret; losing the database rotates the secret implicitly (old challenges die harmlessly) but also resets spend counters; see `DEPLOY.md` section 12.
- **Request binding** (new in draft 0.1): the credential signature covers the query string and a SHA-256 body digest, and the gateway compares both against the request it actually received, so an authorization describes exactly one request. Residual gap: request *headers* are not bound; do not let header values change what an upstream sells for a given priced route.
- **Catalog SSRF**: `/v1/announce` refuses origins that are IP-literals in, or resolve to, private/loopback/link-local/CGNAT/metadata ranges (unless started with `--allow-private-origins` for local development), refuses redirects and caps discovery documents at 1 MB; the wallet proxy only fetches already-catalogued origins. Residual gap: DNS rebinding between the resolve-check and the fetch, so run public catalogs on hosts with no reachable internal services.
- **Public receipts** expose payer and owner wallet ids; leave `public_receipts` off if that linkage matters.
- The web try-it agent is a deliberate hole: anyone who can reach the catalog can spend that mandate. Give it a budget you are happy to lose.

## Not in draft 0.3

x402 client compatibility · agents acting as sellers · per-token / metered pricing and payment channels · windowed budgets enforced on-chain · header binding · subscriptions · fee splits · EIP-4337 / gas sponsorship · dispute windows.
