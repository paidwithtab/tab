# Contributing

Thanks for looking under the hood. tab is small on purpose: one binary,
zero runtime dependencies. Contributions that keep it that way are the
easiest to land.

## Ground rules

1. **Zero runtime dependencies is a hard rule.** Everything runs on Node ≥ 22.13
   built-ins. If a change needs a package at runtime, it needs a very good
   argument; the crypto (Ed25519, keccak-256, secp256k1, RLP, EIP-1559) is
   hand-written and vector-verified, and stays that way.
2. **The payment path is guilty until proven innocent.** Any change touching
   verification, budgets, holds, or settlement must keep every suite green and
   should usually *add* an adversarial check proving the thing it claims.
3. **Docs are part of the change.** SPEC.md is normative; DEPLOY.md states
   verifiable facts (test counts, line counts, behavior). If your change makes
   a documented claim false, update the claim in the same PR.

## Dev setup

```sh
git clone https://github.com/tabprotocol/tab && cd tab
npm install            # typescript, tsx, @types/node: dev tooling only
npx tsc --noEmit       # must stay clean
npm test               # 51 end-to-end checks, in-process, temp DB
npm run test:adversarial   # 24 hostile checks: the money invariants
npm run test:evm       # 31 checks: crypto vectors, mock EVM node, live testnet reads
npm run demo           # full local sandbox: gateway :1402, catalog + site :1403
```

`npm run cli -- <command>` runs the CLI from TypeScript; `npm run build` then
`node bin/tab.js` runs the compiled form.

## Pull requests

- Small and focused beats large and mixed.
- State which suites you ran. If you touched the payment path, all three.
- Match the existing style: plain Node built-ins, comments that state
  constraints rather than narrate code.

## Security findings

Not here. See [SECURITY.md](SECURITY.md) for private reporting.
