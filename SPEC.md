# The tab protocol, draft 0.7

How an agent pays a gateway for one HTTP request, under a spending grant its owner signed offline. Wire format and verification rules. `README.md` is the pitch, `DEPLOY.md` the operator's manual; this document is normative for `ver: "tab/0"` (the wire version is unchanged from draft 0; draft 0.1 made the request commitment of §3.2 mandatory, draft 0.2 added the `evm` rail for Robinhood Chain and the `evm_owner` mandate field, draft 0.3 made `evm` the sole settlement rail, draft 0.4 let a gateway charge in a token of any decimals and name it in `currency`, draft 0.5 made receipts signed statements that bind the policy, the request, the response and the payment, draft 0.6 added x402 in both directions, §5.3, and draft 0.7, shipped with tab 3.0, added sub-mandates and approval thresholds (§2.1, §2.2), instant revocation (§5.4), pay on delivery (§5.5) and payment channels with metered routes (§5.6). Every 0.7 member is optional: a 0.6 mandate, credential or receipt is a valid 0.7 one, and a credential without the new members signs exactly the bytes it signed before).

## 1. Model and terms

| Term | Meaning |
| --- | --- |
| **owner** | holds the funds; signs mandates offline; is never online during a payment |
| **agent** | holds its own key and a mandate; signs a credential per call |
| **gateway** | fronts an upstream API; issues challenges, verifies, reserves, forwards, captures on 2xx |
| **realm** | the string a gateway names itself with (`spec.realm`); mandates allow-list realms |
| **rail** | how money settles: `ledger` (gateway SQLite sandbox) or `evm` (ERC-20 stablecoin on Robinhood Chain) |
| **resource** | `"METHOD /path"`: the priced thing being bought |

All protocol objects are JSON. All amounts are integers of **micro units** of the gateway's currency, carried as decimal strings (`"10000"` = 0.01). The currency is USD unless the gateway's discovery document, every challenge and every receipt say otherwise in `currency`: a gateway that settles in its own token names the token's symbol there (2 to 10 upper-case letters or digits, after at most two lowercase ones, as in USDG, wETH or tTAB) and its prices are amounts of that token. Prices in gateway specs are decimal strings with up to six places. On the evm rail the token may have any number of decimals from 0 to 18; the on-chain amount is the micro amount scaled to the token's decimals (times 10^(d-6), or divided by 10^(6-d) for tokens with fewer than six, in which case every price must be whole in the token's base unit). Mandate budgets and caps are micro units too, so a mandate's numbers mean dollars on a USD gateway and tokens on a token gateway; issue one mandate per currency.

**Canonical JSON**, used for everything that is signed or hashed: object keys sorted lexicographically at every depth, no insignificant whitespace, `undefined` members dropped, arrays kept in order.

**Keys.** Ed25519 at the protocol layer. A wallet id **is** a raw 32-byte public key, base64url; signatures are 64 bytes, base64url. Since draft 0.7 a key or signature is valid only in its canonical spelling (unpadded base64url that decodes to exactly 32 or 64 bytes and re-encodes to the same string); padding, line breaks or spare bits make it invalid, so no set keyed on such a string can be fooled by a respelling. The same key file's 32-byte seed doubles as a secp256k1 scalar for the evm rail (§5.2).

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

**On chain, the allowance is the hard cap.** Nothing on chain ties `evm_owner` to the Ed25519 owner key: an agent key with an allowance can call `transferFrom` directly, or present a mandate it signed itself naming that `evm_owner`, to a gateway that does not know better. Revocation (§5.4), approval thresholds (§2.2) and sub-mandate limits (§2.1) are enforced by honest gateways, for payments made through them. To stop an agent on chain, set its allowance to zero; `tab mandate revoke --token … --evm-agent …` does both in one step, and tab OS zeroes an agent's allowance when it revokes or retires it on a company that pays on chain. Give an agent an allowance no larger than you are prepared to lose to its key.

### 2.1 Sub-mandates (draft 0.7)

An agent holding a mandate may hand a narrower slice of it to another agent key. The sub-mandate has the same shape plus `parent`, the whole parent mandate, and is signed by `parent.agent` instead of the owner. `owner` and `evm_owner` must equal the parent's (the money is still the owner's). The body that is hashed and signed includes `parent`, so the id commits to the whole chain.

A gateway verifies the chain from the leaf up: every id, every signature (the root by its owner, each child by its parent's agent), at most **3 delegations** below the owner, and every child inside its parent:

- `budget` no larger than the parent's;
- `max_per_call` set and no larger, when the parent has one;
- `approve_above` set and no larger, when the parent has one;
- every `allow` glob matched, as a literal string, by some parent glob (`*.example.com` covers `api.example.com` and `*.example.com`; a realm matching the child glob then always matches the parent);
- `expires_at` no later;
- `window` equal to the parent's, or `total`.

Spend under a sub-mandate counts against its own counter **and every ancestor's**, in the same SQLite transaction (§4 step 9b), and a refund gives back to each. Two siblings can therefore never spend past their parent together. `tab mandate delegate` and the `tab_delegate` tool issue them.

### 2.2 Approval above a threshold (draft 0.7)

`approve_above` (optional, micro units) makes any payment larger than it wait for the owner. A sub-mandate's effective threshold is the lowest in its chain. Such a payment is answered with a 402 `approval-required` problem that carries an **approval request**:

```json
{ "ver": "tab/0", "id": "<base64url sha256 of the canonical request minus id>",
  "owner": "<root owner>", "payer": "<agent>", "realm": "…", "resource": "GET /v1/report",
  "amount": "400000", "currency": "USD", "query": "?q=1", "body_sha256": "…" }
```

The owner signs an **approval** for it (a gateway keeps a posted approval only for an owner whose mandates it was paid under, and only a bounded number at a time; otherwise attach it to the retry): `{ver, request: <request id>, realm, resource, amount, issued_at, expires_at, by: <owner>, sig}`, with `expires_at` at most one hour after `issued_at`. The agent retries the same request with the approval in `credential.approval`, or the owner posts `{request, approval}` to `POST /.well-known/tab/approvals` and the plain retry finds it there (`GET /.well-known/tab/approvals/<request id>` says whether one is waiting). An approval pays for **one** call: it is spent by the hash of its signature inside the payment transaction, remembered until its own `expires_at` passes (so no pruning can revive it), its posted copy is deleted, and an attempt spends it even if the upstream then fails. An approval whose `issued_at` is more than two minutes ahead of the gateway's clock is refused. Only the root owner approves. The request binds payer, realm, route, amount, query and body but not the mandate, so an approval survives the agent being given a fresh mandate for the retry.

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
  "currency": "USD",             // or the gateway's token symbol, e.g. "TTT"
  "recipient": "<wallet id>",
  "resource": "GET /v1/things/42",
  "expires_at": "…ISO 8601…",
  "evm": { "chain_id": 46630, "token": "0x…", "decimals": 6,   // the token's decimals, 0 to 18
           "recipient": "0x…",
           "max_fee_per_gas": "0x…", "max_priority_fee_per_gas": "0x…", "gas_limit": 250000 }
}
```

`id` is `HMAC-SHA256(secret, canonical(challenge minus id))` with a per-database secret the gateway generates once. Draft 0.7 gateways add a random `nonce` member, so two buyers asking for the same route in the same millisecond get distinct challenges (before, they got one id that only the first could redeem); clients echo it like every other member. The gateway therefore keeps **no state per challenge**: any edited challenge fails the HMAC before anything else is looked at. `expires_at` is ~120 s ahead. The `evm` member exists only on that rail; `evm.recipient` is the seller's payout address and the fee fields are what the agent's transaction must use verbatim. A client pays in one currency, USD unless configured otherwise, and MUST refuse a challenge in any other currency before signing anything: the mandate's numbers would otherwise be spent in a unit the owner never priced. The gateway verifies `decimals` against the token contract's `decimals()` before issuing its first challenge.

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

Draft 0.7 adds two optional members. `escrow: true` asks for pay on delivery (§5.5) and is part of what the agent signs: the canonical JSON above gains `"escrow": true`, and is unchanged when the member is absent. `approval` carries the owner's approval for a payment above the threshold (§2.2); it is self-authenticating and not covered by the agent's signature.

### 3.3 Receipts and voids

On success the response carries `Tab-Receipt: <base64url(receipt JSON)>`. A receipt says what was bought, not only that money moved:

```json
{ "id": "<hold id>", "realm": "…", "resource": "POST /v1/things", "amount": "2000", "currency": "USD",
  "rail": "evm", "payer": "<agent>", "owner": "<owner>", "recipient": "<seller>", "ref": "evm:0x…", "at": "…",
  "mandate": "<mandate id>", "challenge": "<challenge id>",
  "request": { "query": "?q=1", "body_sha256": "…" }, "credential": "<agent signature>",
  "response": { "status": 200, "body_sha256": "…" },
  "gateway": "<receipt key>", "sig": "<gateway signature>" }
```

`ref` is `ledger:<hold id>` or `evm:<tx hash>`. `mandate` is the policy the payment ran under and `challenge` the id that fixed price, route and recipient. `request` and `credential` are the commitment and signature the agent sent (§3.2), so the receipt can be traced back to an authorization only the agent could give. `response.body_sha256` is the SHA-256 (base64url) of the body bytes the gateway relayed, after any transfer encoding is removed. `gateway` is the gateway's Ed25519 **receipt key**, published in discovery (§6), and `sig` is its signature over the canonical JSON of the receipt minus `sig`. The gateway reads the whole upstream body before capture, so the response is fixed before any money moves.

A client SHOULD verify every receipt: `gateway` equals the `receipt_key` in the gateway's discovery document, `sig` verifies, `mandate` is its own mandate, `request` is what it sent, `response.status` is the status it got, and `response.body_sha256` matches the bytes it read. A receipt that fails any of these is evidence of tampering, not of a purchase. Gateways before draft 0.5 sent receipts without the commitment members and `sig`; those never count as verified. If the upstream answered non-2xx, the response is passed through unchanged plus `Tab-Void: <hold id>` and nothing is charged. The upstream itself receives `Tab-Payer`, `Tab-Owner` and `Tab-Hold` request headers for attribution; the buyer's `Authorization` header is stripped and the gateway's `upstream_headers` are injected.

## 4. Verification order

The gateway verifies in exactly this order. Each failure is a fresh 402 (RFC 9457 problem, `type: urn:tab:problem:<code>`, plus a fresh challenge in `WWW-Authenticate`), except where noted.

1. **Parse** the `Authorization` header. Not base64url JSON of the right shape → `malformed-credential`. On the evm rail, a missing or unparseable embedded transaction is also `malformed-credential`. Then, for a service with `rate_limit_per_minute`, the gateway's own call budget to that upstream: over it → **429** `rate-limited` with `Retry-After`, before any check that could burn the challenge or hold money, so the buyer can retry the same credential. The discovery document lists the limit on the service. Services with the same `rate_limit_group` share one budget, for providers whose limit spans many hosts.
2. **Challenge authenticity**: recompute the HMAC id. Mismatch → `invalid-challenge`. Because the id covers every challenge field, this single check makes all downstream fields trustworthy without server-side challenge state.
3. **Challenge relevance**: `realm`, `rail`, `recipient`, `amount` and `resource` must equal what this gateway would charge for this request → else `invalid-challenge`. (An HMAC-valid challenge for a cheaper route must not pay for a dearer one.)
4. **Challenge expiry** → `payment-expired`.
5. **Mandate validity**: structure, id = hash of body, owner signature, not expired → `mandate-invalid`.
6. **Agent binding**: `credential.agent` must equal `mandate.agent`, and `sig` must verify against the agent key over the full commitment including `request` → `verification-failed`. A credential with no `request` member is `malformed-credential`.
7. **Request commitment**: the query string and the SHA-256 of the body **actually received** must equal what the agent signed → `verification-failed`. (Without this, a party able to see or alter the buyer's traffic could swap the body of an authorized POST within the challenge TTL.)
8. **Realm allow-list**: the gateway's realm must match a mandate glob → `mandate-denied`. Then (draft 0.7) **revocation**: no mandate in the chain may carry a revocation by a rightful signer (§5.4) → `mandate-revoked`; and **approval**: above the chain's `approve_above`, an unspent approval for exactly this request, attached or posted, signed by the root owner and in date → else `approval-required` with the approval request.
9. Inside **one SQLite transaction**:
   a. **Single redemption**: insert the challenge id into the redeemed set; a duplicate → `invalid-challenge`. Insert-before-reserve means two racing copies of one credential cannot both pay.
   b. **Per-call cap**, then **window budget** (spend counter keyed by mandate id and UTC day for `day` windows) → `mandate-exceeded`. For a sub-mandate, each level in turn, leaf first; the approval, if one was needed, is redeemed in the same transaction.
   c. **Rail reservation.** Ledger: debit the owner's balance or `insufficient-funds`. Evm: parse the type-2 transaction, recover its sender from the secp256k1 signature, and require every field (chain id, fees, gas limit, token contract, value, `transferFrom(mandate.evm_owner, challenge recipient, amount)` calldata) to equal what the challenge dictates; only the nonce is the agent's to choose (→ `verification-failed`).
   d. evm only: the keccak hash of the raw transaction is stored **UNIQUE across non-voided holds**, so one signed payment can never back two served calls (→ `invalid-challenge`, "payment transaction already used"). A voided hold frees its hash: after a void the same nonce legitimately produces the same bytes. The sender and nonce are stored **UNIQUE across reserved holds**: two different transactions at one nonce can both pass every check while only one can mine (→ `payment-expired`). The transaction must be the canonical encoding with a low-s signature, the only form nodes relay.
10. After the transaction commits, the rail's chain checks (evm): the sender's nonce must equal the account's pending nonce (→ `payment-expired`), the sender must afford `gas_limit × max_fee_per_gas` (→ `insufficient-funds`), and an `eth_call` **dry run** of the transfer must not revert (revert → `insufficient-funds`: owner balance or allowance short, or the allowance revoked). On failure the spend counter is refunded and the hold voided; the redeemed challenge id stays burned.
11. **Forward upstream.** Unreachable or timed out → **502** `upstream-failed`, hold released, nothing charged. Non-2xx → passed through with `Tab-Void`, hold released, budget refunded.
12. **Capture** on 2xx. Ledger: credit the recipient. Evm: broadcast (the gateway computes the transaction hash itself, and a transaction the network already has counts as broadcast) and wait for the receipt. Only now does money move. If the payment does not settle (the broadcast is refused, the transfer reverts), the hold is voided, nothing is charged, and the response is **withheld**: the buyer gets a 402 `payment-expired` with `Tab-Void`. Relaying it anyway would let an agent spend its own nonce or revoke its allowance during the upstream call and keep what it bought. A broadcast transaction whose receipt is merely slow stays captured, since it may still land. On the evm rail a gateway holds at most one reserved payment per sender and nonce (step 9d); a second waits for the first to settle.

Rationale for the order: the cheapest, stateless checks run first; nothing touches the database until the credential is proven genuine; money is reserved before the upstream does any work but only *moves* after the upstream succeeded.

## 5. Rails

### 5.1 `ledger`

Balances are rows in the gateway's SQLite file, created by `tab mint`. Reserve = debit owner, capture = credit recipient, release = credit owner back. Sandbox semantics: balances are per gateway database and mean nothing anywhere else.

### 5.2 `evm` (Robinhood Chain)

USDC (or any 6-decimal ERC-20) on an EVM chain. Built for **Robinhood Chain**, an Arbitrum-stack L2 (chain id 46630 testnet, 4663 mainnet); any EVM chain with the same shape works. No custom contract.

Identity: a tab key file's 32-byte private seed doubles as a secp256k1 scalar (`d = seed mod (n-1) + 1`), so one key file yields both the Ed25519 wallet id and an EVM address (`tab evm address`). The protocol layer (mandates, credentials) stays Ed25519; only the payment transaction is secp256k1.

Setup, once: the owner calls ERC-20 `approve(agentAddress, amount)` on the token (`tab evm approve`). The allowance decrements with every `transferFrom` and `approve(agent, 0)` revokes it instantly (`tab evm revoke`). The agent's account also needs a little ETH: EVM has no native fee-payer co-signing, so the transaction sender, the agent, pays gas (`tab evm fund` moves some over; bound per call by `gas_limit × max_fee_per_gas`, which the agent signs).

Per payment the agent builds an EIP-1559 transaction from the challenge (to = token, value 0, calldata `transferFrom(evm_owner, challenge.evm.recipient, amount × 10^(decimals − 6))` with `decimals` from the challenge, fees and gas limit verbatim from the challenge), choosing only the nonce, which it reads from the gateway (`GET /.well-known/tab/evm/nonce/<0xaddress>`), so clients still need no RPC of their own. The gateway parses the transaction, recovers the sender, checks every field, enforces raw-tx-hash uniqueness, dry-runs the transfer, forwards upstream, and broadcasts only on 2xx. Receipt `ref` is `evm:<tx hash>`; `rail_info.explorer` (e.g. explorer.testnet.chain.robinhood.com) tells front ends where a ref can be viewed.

### 5.3 x402 (version 2, `exact`, EIP-3009)

A gateway on the evm rail whose token implements EIP-3009 `transferWithAuthorization` (USDG and USDC do) may also take [x402](https://github.com/coinbase/x402) payments. It is configured with the token's EIP-712 domain (`evm.eip712: {name, version}`; USDG on Robinhood Chain is `Global Dollar`, `1`) and a **settler** key that pays gas for settlement and holds nothing else.

- **Offer.** Every 402 also carries `PAYMENT-REQUIRED`: base64 JSON `{x402Version: 2, error, resource: {url, mimeType}, accepts: [{scheme: "exact", network: "eip155:<chain id>", amount, asset, payTo, maxTimeoutSeconds: 120, extra: {name, version}}]}` with `amount` in the token's atomic units and `payTo` the seller's payout address.
- **Payment.** The buyer retries with `PAYMENT-SIGNATURE`: base64 JSON `{x402Version: 2, resource, accepted, payload: {signature, authorization: {from, to, value, validAfter, validBefore, nonce}}}`, the EIP-712 signature by `from` over `TransferWithAuthorization`. No `Authorization` header is sent.
- **Checks, in order:** version 2, scheme `exact`, network, asset, transfer method `eip3009`, the authorization's shape, `to` is the payout address, `value` equals the price exactly, `validAfter` is past, `validBefore` is at least 30 s away, the signature recovers to `from` with low s, the settler can pay gas, `from` holds the amount, and an `eth_call` of `transferWithAuthorization` from the settler succeeds (the authorization unused, the signature accepted by the token). Then `(from, nonce)` is redeemed and held, so one authorization backs at most one call. Failures are a 402 with `PAYMENT-RESPONSE` `{success: false, errorReason}` using x402's error codes.
- **Settlement** follows step 12: upstream first, then the settler submits `transferWithAuthorization`; the response carries `PAYMENT-RESPONSE` `{success: true, transaction, network, payer, amount}` and a signed tab receipt whose `mandate` is `x402:<payer>` and `challenge` the authorization nonce. A transfer that does not settle voids the hold and withholds the response.
- An x402 buyer carries no mandate: its signed authorization is the whole policy, one call at a time.

### 5.4 Revocation (draft 0.7)

A revocation is a signed statement that a mandate is dead:

```json
{ "ver": "tab/0", "mandate": "<mandate id>", "by": "<wallet id>", "revoked_at": "…", "reason": "…", "sig": "<by's signature over the canonical body minus sig>" }
```

It takes effect if `by` is the root owner of the mandate's chain, the mandate's issuer (the delegating agent, for a sub-mandate) or the mandate's own agent. A revoked mandate kills every sub-mandate under it. `POST /.well-known/tab/revocations` takes one, or a list of up to 100, each either bare or as `{revocation, mandate}`. The gateway keeps a revocation only after checking it against a real mandate: the one sent with it (the revoked mandate, or one under it), or one this gateway was paid under. The mandate must verify and must name the signer as one who may revoke it; anything else is refused and not stored. A revocation for a chain this gateway was paid under is kept and shared with peers. One for a chain it never saw (anyone can mint a mandate and revoke it) is kept aside in a capped table until the mandate expires, never shared, and still checked at payment: if that mandate is ever presented it is refused and the revocation joins the shared list. A batch is written in one transaction, and posts are rate limited per client address. `GET /.well-known/tab/revocations?after=<seq>` lists what a gateway holds by sequence number, each row with its `seq` and the `mandate_doc` that authorized it, so peers can check authority themselves; `GET /.well-known/tab/revocations/<mandate id>` answers one, naming its signers. A client that holds the mandate should check those signers itself rather than take a gateway's word. A gateway configured with peers pushes each new revocation to them at once and polls their lists every few seconds, so one publish reaches all of them within seconds. Open channels whose mandate is revoked take no more vouchers and are settled by the gateway's sweeper (§5.6).

### 5.5 Pay on delivery (draft 0.7)

A route the seller marks `escrow` (spec: `true` or `{"timeout_s": 3600}`) offers it in every challenge: `escrow: {timeout_s}`, plus `recipient` on the evm rail (below). A buyer that wants it signs a credential with `escrow: true`; one that does not pays as in 0.6. With it, the gateway forwards the call with `Tab-Escrow-Deadline`, `Tab-Deliver` (a URL) and `Tab-Delivery-Token`, and:

- **2xx other than 202**: delivered at once. The money passes through escrow to the seller and the receipt carries `escrow: {deadline, held_ref, delivered_at}`.
- **202**: accepted, not delivered. The payment is **held**. The response carries `Tab-Escrow: <base64url JSON {id, state: "held", deadline, token, status}>`. The seller delivers later by POSTing the result bytes to the `Tab-Deliver` URL with the delivery token (`Tab-Result-Status` optional, a 2xx other than 202), or gives up by POSTing to `…/fail`. Delivery pays the seller and signs a receipt whose `response.body_sha256` is the SHA-256 of the delivered result, bound to the buyer's signed `request` and `credential`: a **delivery receipt**. Failure, or no delivery by the deadline, refunds the owner and every spend counter in the chain.
- **non-2xx**: voided, as in 0.6.

The buyer follows its order with the token: `GET /.well-known/tab/escrow/<id>?token=` (state, deadline, receipt, refund ref) and `GET …/<id>/result?token=` (the result bytes with `Tab-Receipt`). Tokens are HMACs of the order id under the gateway secret, so no state is kept for them. `GET /.well-known/tab/escrow?payer=` lists a payer's orders on gateways with public receipts.

On the **evm rail** the held money needs an address: the gateway runs with an **escrow key**, the challenge names its address in `escrow.recipient`, and the buyer's transfer pays it there instead of `evm.recipient` (the gateway checks the calldata against it). The escrow key pays out to the seller on delivery or back to `evm_owner` on refund, paying the gas. A gateway without an escrow key does not offer escrow on the evm rail. The buyer trusts the gateway with the held money until then, as a seller already trusts it with its payout.

**Safety rules for held money.** A gateway that offers escrow or channels must be configured with its public origin: the `Tab-Deliver` URL, the order's status URL and both tokens derive from it, never from a request header (a buyer's `Host` could otherwise steer the seller's delivery to itself). Tokens are HMACs over the origin and the order id. The buyer's token may be sent as `Tab-Escrow-Token` instead of `?token=`. The result is served with `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and a sandboxing `Content-Security-Policy`, since it is the seller's bytes on the gateway's origin. An upstream response that contains the delivery token has it replaced with `[redacted]` and any header carrying it dropped before it reaches the buyer; an upstream should still never echo request headers on an escrow route. On the evm rail the buyer's transfer into escrow must **confirm** before an order or channel opens; one that does not confirm in time fails the call, and the gateway watches for it and sends it back if it lands later. Every payout out of held money is written down under a key (`escrow:<id>:seller`, `channel:<id>:buyer`, ...) before it is sent, with its signed transaction on the evm rail. Once a payout is attempted the outcome (delivered or refunded) is final: a payout that fails or does not confirm is retried under the same key, rebroadcasting the same transaction, and a new transaction is signed only when the old one can no longer land (it reverted, or its nonce went to another). A transaction counts as unable to land only on evidence about that transaction: its own receipt showing a revert, or the receipt of a cancel of ours (a zero-value transaction to ourselves at the same nonce, sent when the node keeps refusing the payout, so later payouts are not stalled behind it). A spent nonce with no receipt is never enough, since a lagging node looks the same: such a payout is marked stuck at once and reconciled if its transaction turns up. Retries back off and stop after a cap, leaving the payout marked stuck for the operator. A buyer's transfer into escrow that the node does not accept, or that does not confirm, is watched in the same way; it is treated as failed only on its own revert, or after a day with its nonce spent and no node knowing it.

### 5.6 Payment channels and metered routes (draft 0.7)

A gateway whose spec has `channels` (optional `min_deposit`, `max_ttl_s`) takes channels; discovery says so in `channels: {open, min_deposit, max_ttl_s}`.

- **Open.** `POST /.well-known/tab/channels` with `{"deposit": "1.00", "ttl_s": 86400}` is an ordinary priced call: a 402 for the deposit, then a credential that commits to that body. Every mandate check applies (revocation, approval threshold, budget across the chain) except the per-call cap, since a deposit is not one call. The deposit is held (ledger: debited from the owner; evm: transferred to the escrow address) and counts against the mandate budget. The answer is `201 {channel, receipt}` with `channel: {id, deposit, authorized, spent, held, calls, state, expires_at, …}`; the channel lives no longer than its mandate.
- **Pay.** A call to any priced route carries `Authorization: TabVoucher <base64url voucher>` instead of a credential:

```json
{ "ver": "tab/0", "channel": "<id>", "amount": "<cumulative micro>", "resource": "GET /v1/x",
  "query": "", "body_sha256": "…", "nonce": "<random, single use>", "sig": "<channel agent's signature>" }
```

The gateway checks the signature by the channel's agent, the request against the voucher, the channel's mandate chain (revocation, expiry, per-call cap; a call above the approval threshold must be paid per call so the owner can approve it), and then, in one transaction, that the nonce is new for this channel and that `amount` is no lower than the highest voucher so far, no higher than the deposit, and covers what is spent, what calls in flight hold, and this call's price. No money moves. On 2xx the call is charged and a signed receipt with `ref: "channel:<id>"` and `channel: {id, kind: "call", spent, units}` is returned with `Tab-Channel` (the channel state); on failure it is charged nothing. Refusals carry `Tab-Channel` too, so a client that fell behind resyncs.
- **Metered.** A route with `meter: {unit, per_unit}` charges a channel call `ceil(units × per_unit)`, never more than the route's `price`, where `units` is the upstream's `Tab-Units` response header (absent: the full price). Prices are micro units, so a call may cost less than a cent. A per-call buyer of a metered route pays its `price`.
- **Close.** `POST /.well-known/tab/channels/<id>/close` with `{"sig": <the agent's signature over {"action":"close","channel":id,"ver":"tab/0"}>}`, or by anyone once the channel expired; the gateway's sweeper also closes expired and revoked channels. The spent part goes to the seller and the rest back to the owner (evm: two transfers from the escrow address, so one channel costs two settlement transactions however many calls it paid), the mandate counters are refunded what was not spent, and a settlement receipt with `channel: {kind: "settle", spent, deposit}` is signed. A close waits for calls in flight.

**Trust and the contract.** With a gateway-held escrow address the buyer trusts the gateway to honour a close; it cannot double spend (the deposit is already held and vouchers only move a counter) and the gateway cannot charge more than the vouchers the agent signed. For channels that need no trust in the gateway, `contracts/TabChannel.sol` is a unidirectional channel contract: the payer deposits, the agent's EVM key signs cumulative EIP-712 vouchers `Voucher(bytes32 channel, uint256 amount)` (domain `TabChannel`, version `1`), the payee closes once with the highest voucher, and the payer can start a unilateral close that the payee may answer with its best voucher during a dispute window before the payer takes the rest back. A channel id (`keccak256(payer, salt)`) is good once: the contract keeps a never-cleared record of used ids, so an old channel's vouchers can never pay on a new one. Fee-on-transfer and rebasing tokens are not supported (the deposit is recorded as asked, not as received), and a token that can blacklist addresses can block close and finalize for a blacklisted party. It is tested on a local EVM and deployable to testnets with `tab evm deploy-channel`; draft 0.7 gateways do not yet settle through it.

**A tab client paying an x402 site.** When a 402 has x402 requirements and no tab challenge (`PAYMENT-REQUIRED`, or a version 1 body `{x402Version: 1, accepts}`), the client picks the first `exact` / `eip3009` entry in a token it knows and its own currency, converts the amount to micro units rounding up, and refuses before signing unless the mandate allows it: not expired, the site's hostname in `allow`, within `max_per_call`, the client cap, and the budget less what the client has already signed to x402 sites under this mandate and window (kept by the client, since an x402 site keeps no tab budget). It signs from the **agent's own address**, which the owner funds; that balance bounds it too. Since draft 0.7 the client also refuses an x402 price above the chain's approval threshold (an x402 site cannot take the owner's approval) and counts x402 spend against every mandate in the chain, not only the leaf, together with what the same client paid tab gateways under that mandate. Spend by other clients of the agent key, or at gateways this client did not pay, is not known to it. It cannot know of revocations; zero the agent's balance or allowance to stop it. A signed authorization counts as spent when it is sent. A 402 with both a tab challenge and x402 requirements is paid the tab way.

## 6. Discovery

`GET /.well-known/tab` on a gateway:

```json
{ "ver": "tab/0", "realm": "…", "rail": "ledger", "rail_info": { … },
  "recipient": "<wallet id>", "receipt_key": "<Ed25519 public key, base64url>",
  "x402": { "x402Version": 2, "scheme": "exact", "network": "eip155:4663", "asset": "0x…", "payTo": "0x…", "eip712": { "name": "…", "version": "…" } },
  "services": [ { "name": "…", "prefix": "…", "description": "…",
      "routes": [ { "method": "GET", "path": "/v1/things/:id", "price": "0.01", "description": "…" } ] } ] }
```

Draft 0.7 adds `features` (`revoke`, `delegation`, `approval`, and `escrow` and `channels` where offered), `revocations` and `approvals` (the paths of §5.4 and §2.2), `channels` (§5.6), and per route `escrow` and `meter`. Also `GET /.well-known/tab/wallet/<id>` (available balance on this rail, with its `currency`) and, if the gateway opted in, `GET /.well-known/tab/receipts?limit=` (last 200, each signed receipt exactly as signed). `receipt_key` is generated once per gateway database and signs every receipt it issues. All JSON endpoints send `Access-Control-Allow-Origin: *`. Unpriced paths are 404 and never proxied; `"0"`-priced routes are proxied unpaid.

The catalog's own API (`/v1/catalog.json`, `/v1/search`, `/v1/announce`, `/v1/refresh`, `/v1/health`, `/v1/mandate/verify`, `/v1/wallet`, `/v1/receipts`, `/v1/try`) is descriptive, not part of the payment protocol; see `DEPLOY.md` section 10.

## 7. Problem codes

`payment-required`, `malformed-credential`, `invalid-challenge`, `payment-expired`, `verification-failed`, `mandate-invalid`, `mandate-denied`, `mandate-exceeded`, `insufficient-funds`, and in draft 0.7 `mandate-revoked`, `approval-required` (with `approval_request`), `channel-invalid`, `channel-exhausted` (all 402), `not-found` (404), `rate-limited` (429), `upstream-failed` (502). Bodies are RFC 9457 problems with `type: urn:tab:problem:<code>`; extra members such as `approval_request` sit beside the standard ones. A client that does not know a code treats it as a refusal.

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
- **A challenge is paid only to the realm it came from** (new in 3.0.1). A client refuses a 402 whose `realm` is not the host it fetched (loopback and `.local` hosts excepted, for development), so a hostile site cannot answer with an allowed gateway's realm and be paid under that allow list. On the evm rail the client also counts every signed transfer against each level of the mandate chain before it leaves, since a signed transfer is a bearer instrument.
- **The budget race** (two concurrent calls straddling the limit) is closed by doing the spend-counter update and the funds reservation in one SQLite transaction.
- **Challenge forgery** is stopped by the per-database HMAC secret; losing the database rotates the secret implicitly (old challenges die harmlessly) but also resets spend counters; see `DEPLOY.md` section 12.
- **Request binding** (new in draft 0.1): the credential signature covers the query string and a SHA-256 body digest, and the gateway compares both against the request it actually received, so an authorization describes exactly one request. Residual gap: request *headers* are not bound; do not let header values change what an upstream sells for a given priced route.
- **Outbound fetches to named addresses** (catalog announces, wallet and receipt lookups, the try-it agent, and on a hosted company server every gateway, http agent and URL an agent asks for): only global unicast addresses, judged after resolving and checked again at connect time (so DNS rebinding between a check and the fetch gets nowhere), IPv4-mapped IPv6 judged as the IPv4 it carries, no redirects, capped size and time. Local development opts out with `--allow-private-origins`. Discovery documents are capped at 16 MB. A gateway's route prefix must keep every route on its own origin, and receipts relayed by the catalog are shape-checked.
- **What a receipt proves** (new in draft 0.5): that this gateway, under its published key, served a response with this status and body hash for this exact request, under this mandate, and booked this payment (on the evm rail, the named transaction). It does not prove the upstream produced that body: the gateway signs what it relayed, and a dishonest gateway can sign a body it made up. Closing that needs the upstream to sign its own responses, which most public APIs do not. Receipts also do not hash response headers.
- **Receipt key loss**: a new database means a new receipt key, and receipts from the old one no longer match discovery. Operators who rotate on purpose should keep the old public key on record for audits.
- **x402 settlement holds a key.** The settler key pays gas for `transferWithAuthorization` and can move nothing else: the transfer's amount and recipient are fixed by the buyer's signature. Keep a small ETH balance on it. A buyer who empties its wallet during the upstream call gets nothing (the response is withheld); the gateway loses the gas of one failed transaction at most, after a dry run that passed.
- **x402 on the client side** is bounded by the mandate as the client counts it and by the agent address's balance; fund that address with what you are prepared to see spent.
- **A mandate's budget is counted per gateway.** Each gateway keeps its own spend counter, so a `total` mandate that allows several realms can be spent up to its budget at each of them. Scope `allow` to the realms you mean, or issue one mandate per gateway, when the sum matters (hosted companies do: one mandate per run, read back from every gateway).
- **Public receipts** expose payer and owner wallet ids; leave `public_receipts` off if that linkage matters.
- The web try-it agent is a deliberate hole: anyone who can reach the catalog can spend that mandate. Give it a budget you are happy to lose.
- **Revocation is as fast as the gateways that hear it.** A gateway that is not told and does not poll keeps accepting a revoked mandate until it expires; publish to every gateway that matters, or peer them. On the evm rail it binds only gateways: zero the allowance as well (§2).
- **Revocations do not publish their mandate.** The public list carries the signed revocation, its sequence number and when it lapses, never the revoked mandate's terms. A gateway pushes the full mandate only to the peers it was configured with; a revocation heard without its mandate is held as pending and stops that mandate the first time it is presented. Pending revocations are never evicted: when the table is full, new ones are refused with 503 rather than older ones forgotten.
- **Delegation multiplies keys, not money.** A sub-mandate can never spend past any ancestor, but each delegate key is another key that can spend its slice; give sub-mandates short lives.
- **Approvals are bearer instruments for one call.** Anyone holding one can make that exact call once, for the owner, which is what the owner approved. They expire within an hour.
- **Escrow and channel deposits on the evm rail are held by the gateway's escrow key.** Its compromise exposes what is held at the time. Keep held amounts and deadlines modest, or use the TabChannel contract once gateways settle through it.
- **Delivery receipts prove what the gateway relayed as delivered**, as other receipts do (§9 above): the seller's own signature over the result would need the upstream to sign.

## Not in draft 0.7

x402 schemes other than `exact`, transfer methods other than EIP-3009 (Permit2, ERC-7710), version 1 on the gateway side · agents acting as sellers · gateways settling channels through the TabChannel contract · approvals by a delegating agent rather than the owner · windowed budgets enforced on-chain · header binding · upstream-signed responses and results · subscriptions · fee splits · EIP-4337 / gas sponsorship.
