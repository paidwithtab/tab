# Security policy

tab moves money. If you find a way to break a payment invariant, we want to
know before anyone else does.

## What counts

Anything that violates the guarantees in [SPEC.md §9](SPEC.md#9-security-considerations), for example:

- spending beyond a mandate's budget, per-call cap, realm list, or expiry
- redeeming one challenge or one signed payment more than once
- getting a paid response without a capture, or a capture without a response, outside the documented one-call trust bounds
- forging or mutating mandates, credentials, or request commitments
- making the catalog fetch internal addresses (SSRF) or crash the accounting

## How to report

Use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). Please do not open a public issue
for anything exploitable.

Include what you can: the invariant broken, a reproduction (the adversarial
suite in `test/adversarial.ts` is a good template), and the version or commit.

## Scope notes

- The `ledger` rail is sandbox money by design; findings there matter only if
  they also break the shared verification path.
- Known, documented trust bounds (SPEC.md §9, for example a gateway
  broadcasting a held payment without serving) are not vulnerabilities, but
  ways to *widen* them are.
- Testnet deployments run play money; demonstrations against your own
  deployment are always in scope and appreciated.
