# The tab protocol, draft 0.1

How an agent pays a gateway for one HTTP request, under a spending grant its owner signed offline. Wire format and verification rules. `README.md` is the pitch, `DEPLOY.md` the operator's manual; this document is normative for `ver: "tab/0"` (the wire version is unchanged from draft 0; draft 0.1 makes the request commitment of §3.2 mandatory — credentials without it are rejected).

## 1. Model and terms

| Term | Meaning |
| --- | --- |
| **owner** | holds the funds; signs mandates offline; is never online during a payment |
| **agent** | holds its own key and a mandate; signs a credential per call |
| **gateway** | fronts an upstream API; issues challenges, verifies, reserves, forwards, captures on 2xx |
| **realm** | the string a gateway names itself with (`spec.realm`); mandates allow-list realms |
| **rail** | how money settles: `ledger` (gateway SQLite) or `solana` (SPL stablecoin) |
| **resource** | `"METHOD /path"` — the priced thing being bought |

All protocol objects are JSON. All amounts are **micro-USD** integers carried as decimal strings (`"10000"` = $0.01). Prices in gateway specs are USD strings with up to six decimals. On the solana rail, one micro-USD equals one base unit of a 6-decimal mint.

**Canonical JSON**, used for everything that is signed or hashed: object keys sorted lexicographically at every depth, no insignificant whitespace, `undefined` members dropped, arrays kept in order.

**Keys.** Ed25519 throughout. A wallet id **is** a raw 32-byte public key, base64url. The same 32 bytes in base58 are the Solana address. Signatures are 64 bytes, base64url.

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
  "sig": "<owner signature over the canonical body>"
}
```

The *body* is the object minus `id` and `sig`. `id = sha256(canonical(body))`; `sig` is the owner's Ed25519 signature over the same bytes. `window: "day"` resets the budget each UTC calendar day; `"total"` is a lifetime budget. `allow` entries are globs over realms (`*` matches any run of characters); an empty list is invalid — use `["*"]`.

On the solana rail the mandate has an on-chain half: the owner approves the agent as SPL delegate on the owner's token account (section 5.2). The mandate caps what the gateway will co-sign; the delegation caps what the chain will move. Both must hold.

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
  "rail": "ledger" | "solana",
  "amount": "10000",
  "currency": "USD",
  "recipient": "<wallet id>",
  "resource": "GET /v1/things/42",
  "expires_at": "…ISO 8601…",
  "solana": { "mint": "<base58>", "decimals": 6, "fee_payer": "<base58>", "recent_blockhash": "<base58>" }
}
```

`id` is `HMAC-SHA256(secret, canonical(challenge minus id))` with a per-database secret the gateway generates once. The gateway therefore keeps **no state per challenge**: any edited challenge fails the HMAC before anything else is looked at. `expires_at` is ~120 s ahead on the ledger rail and ~60 s on solana (bounded by blockhash validity). The `solana` member exists only on that rail.

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
  "solana": { "tx": "<base64 partially-signed legacy transaction>" }
}
```

`request` is the **request commitment**: `query` is the URL search string exactly as sent (`""` if none) and `body_sha256` is the SHA-256 (base64url) of the request body — of zero bytes for bodyless requests. `sig` is the agent's signature over the canonical JSON of

```json
{ "agent": …, "amount": …, "body": "<body_sha256>", "challenge": "<challenge id>",
  "mandate": "<mandate id>", "query": …, "realm": …, "recipient": …, "resource": … }
```

so a credential authorizes **exactly this request** — method, path, query and body — for exactly this amount under that one challenge id, not merely "any call to the route". The `solana` member is required on the solana rail and absent otherwise.

### 3.3 Receipts and voids

On success the response carries `Tab-Receipt: <base64url(receipt JSON)>` — `{id, realm, resource, amount, currency, rail, payer, owner, recipient, ref, at}` with `ref` = `ledger:<hold id>` or `solana:<signature>`. If the upstream answered non-2xx, the response is passed through unchanged plus `Tab-Void: <hold id>` and nothing is charged. The upstream itself receives `Tab-Payer`, `Tab-Owner` and `Tab-Hold` request headers for attribution; the buyer's `Authorization` header is stripped and the gateway's `upstream_headers` are injected.

## 4. Verification order

The gateway verifies in exactly this order. Each failure is a fresh 402 (RFC 9457 problem, `type: urn:tab:problem:<code>`, plus a fresh challenge in `WWW-Authenticate`), except where noted.

1. **Parse** the `Authorization` header. Not base64url JSON of the right shape → `malformed-credential`. On the solana rail, a missing or unparseable embedded transaction is also `malformed-credential`.
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
   c. **Rail reservation**: ledger — debit the owner's balance or `insufficient-funds`; solana — rebuild the expected transaction from the challenge and compare **byte-for-byte** with the one sent (→ `verification-failed`), verify the agent's transaction signature, co-sign as fee payer.
10. Solana only, after the transaction commits: **simulate** with the gateway's signature added. Insufficient balance, exhausted or missing delegation → `insufficient-funds`; anything else → `verification-failed`. The spend counter is refunded and the hold voided; the redeemed challenge id stays burned.
11. **Forward upstream.** Unreachable or timed out → **502** `upstream-failed`, hold released, nothing charged. Non-2xx → passed through with `Tab-Void`, hold released, budget refunded.
12. **Capture** on 2xx: ledger — credit the recipient; solana — broadcast and confirm. Only now does money move. If broadcasting fails after a 2xx, the hold is voided and the buyer gets the response uncharged — the failure mode is always in the buyer's favor.

Rationale for the order: the cheapest, stateless checks run first; nothing touches the database until the credential is proven genuine; money is reserved before the upstream does any work but only *moves* after the upstream succeeded.

## 5. Rails

### 5.1 `ledger`

Balances are rows in the gateway's SQLite file, created by `tab mint`. Reserve = debit owner, capture = credit recipient, release = credit owner back. Sandbox semantics: balances are per gateway database and mean nothing anywhere else.

### 5.2 `solana`

USDC or any 6-decimal SPL mint, Token program only, legacy transactions, no custom program.

Setup, once: the owner approves the agent as delegate on the owner's ATA for the mint (`ApproveChecked`). Only one delegate can exist per token account; the delegated amount decrements on-chain with every transfer and the Token program clears the delegate when it reaches zero. `Revoke` ends it instantly, independent of mandate expiry.

Per payment, the agent builds this exact transaction from the challenge (both sides construct it with the same deterministic rules, so the gateway can compare bytes):

1. `ComputeBudget.SetComputeUnitLimit(100000)`
2. `AssociatedTokenAccount.CreateIdempotent` for the recipient's ATA, fee payer paying rent
3. `Token.TransferChecked` from the owner's ATA to the recipient's ATA, **agent as authority**, amount = challenge amount, decimals from the challenge
4. `Memo` = the challenge id

Fee payer (signature slot 0, left empty by the agent) is the gateway's key from the challenge; the agent signs slot 1. `recent_blockhash` comes from the challenge. The gateway compares the message bytes, checks the agent's signature, co-signs, simulates, and broadcasts only after the upstream answered 2xx. On any failure nothing is ever broadcast. Receipt `ref` is `solana:<signature>`.

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

- **The owner key never travels.** Payments require only the agent key and the mandate. Compromise of an agent key is bounded by the mandate budget, per-call cap, realm list and expiry — and on solana additionally by the delegated amount, which the owner can `Revoke` at any moment.
- **The gateway is trusted by the seller, not by the owner.** A malicious gateway can at most consume the mandate budget at the priced rates on its own realm; it cannot forge mandates (owner signature) and, on solana, cannot move more than the agent signed (it holds only the fee-payer key; the transfer is signed by the agent and byte-checked against the challenge the agent accepted).
- **Replay** is stopped by single-redemption of the HMAC-bound challenge id, enforced with insert-before-reserve inside the same transaction as the budget and funds checks.
- **The budget race** (two concurrent calls straddling the limit) is closed by doing the spend-counter update and the funds reservation in one SQLite transaction.
- **Challenge forgery** is stopped by the per-database HMAC secret; losing the database rotates the secret implicitly (old challenges die harmlessly) but also resets spend counters — see `DEPLOY.md` section 12.
- **Request binding** (new in draft 0.1): the credential signature covers the query string and a SHA-256 body digest, and the gateway compares both against the request it actually received — an authorization describes exactly one request. Residual gap: request *headers* are not bound; do not let header values change what an upstream sells for a given priced route.
- **Catalog SSRF**: `/v1/announce` refuses origins that are IP-literals in, or resolve to, private/loopback/link-local/CGNAT/metadata ranges (unless started with `--allow-private-origins` for local development), refuses redirects and caps discovery documents at 1 MB; the wallet proxy only fetches already-catalogued origins. Residual gap: DNS rebinding between the resolve-check and the fetch — run public catalogs on hosts with no reachable internal services.
- **Public receipts** expose payer and owner wallet ids; leave `public_receipts` off if that linkage matters.
- The web try-it agent is a deliberate hole: anyone who can reach the catalog can spend that mandate. Give it a budget you are happy to lose.

## Not in draft 0.1

x402 client compatibility · agents acting as sellers · per-token / metered pricing and payment channels · windowed budgets enforced on-chain · header binding · subscriptions · fee splits · Token-2022 · versioned transactions · dispute windows.
