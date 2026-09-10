#!/usr/bin/env bash
# One-command sandbox: keys, mandates, sandbox money, upstream :4101,
# gateway :1402, catalog + front end :1403. Idempotent; Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

TAB="node --no-warnings=ExperimentalWarning --import tsx src/cli.ts"
export PREMIUM_KEY="${PREMIUM_KEY:-demo-key}"
BUDGET="${BUDGET:-1.00}"
MAX_PER_CALL="${MAX_PER_CALL:-0.05}"
WEB_BUDGET="${WEB_BUDGET:-0.50}"
MINT_AMOUNT="${MINT:-5.00}"   # ledger amount minted to the owner

mkdir -p keys
[ -f keys/seller.json ]       || $TAB key new --out keys/seller.json
[ -f keys/owner.json ]        || $TAB key new --out keys/owner.json
[ -f keys/agent-claude.json ] || $TAB key new --out keys/agent-claude.json
[ -f keys/agent-web.json ]    || $TAB key new --out keys/agent-web.json
[ -f keys/mandate-claude.json ] || $TAB mandate issue --owner keys/owner.json --agent keys/agent-claude.json \
    --budget "$BUDGET" --window day --max-per-call "$MAX_PER_CALL" --allow 'quotes.local' --days 30 --out keys/mandate-claude.json
[ -f keys/mandate-web.json ]    || $TAB mandate issue --owner keys/owner.json --agent keys/agent-web.json \
    --budget "$WEB_BUDGET" --window day --max-per-call "$MAX_PER_CALL" --allow 'quotes.local' --days 30 --out keys/mandate-web.json

export SELLER="$(node -p "require('./keys/seller.json').publicKey")"
$TAB mint --wallet keys/owner.json --amount "$MINT_AMOUNT" --db tab.db

trap 'kill 0' EXIT INT TERM

UPSTREAM_PORT=4101 node --no-warnings=ExperimentalWarning --import tsx examples/upstream.ts &
$TAB catalog serve --db catalog.db --port 1403 --allow-private-origins \
    --try-agent keys/agent-web.json --try-mandate keys/mandate-web.json --try-max-per-call "$MAX_PER_CALL" &
sleep 1
$TAB serve --spec examples/spec.json --db tab.db --port 1402 \
    --announce http://127.0.0.1:1403 --origin http://127.0.0.1:1402 &

echo
echo "  gateway   http://127.0.0.1:1402   (curl -i http://127.0.0.1:1402/quote -> 402)"
echo "  catalog   http://127.0.0.1:1403   (open this in a browser)"
echo "  paid call: $TAB fetch --agent keys/agent-claude.json --mandate keys/mandate-claude.json http://127.0.0.1:1402/quote"
echo
wait
