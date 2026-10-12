#!/usr/bin/env bash
# One-command sandbox: keys, mandates, sandbox money, upstream :4101,
# gateway :1402, catalog + front end :1403. Idempotent; Ctrl-C stops everything.
# Ports are taken on your machine? UPSTREAM_PORT, GATEWAY_PORT and CATALOG_PORT override them.
set -euo pipefail
cd "$(dirname "$0")/.."

TAB="node --no-warnings=ExperimentalWarning --import tsx src/cli.ts"
export PREMIUM_KEY="${PREMIUM_KEY:-demo-key}"
BUDGET="${BUDGET:-1.00}"
MAX_PER_CALL="${MAX_PER_CALL:-0.05}"
WEB_BUDGET="${WEB_BUDGET:-0.50}"
MINT_AMOUNT="${MINT:-5.00}"   # ledger amount minted to the owner
UPSTREAM_PORT="${UPSTREAM_PORT:-4101}"
GATEWAY_PORT="${GATEWAY_PORT:-1402}"
CATALOG_PORT="${CATALOG_PORT:-1403}"
SPEC=examples/spec.json
if [ "$UPSTREAM_PORT" != 4101 ]; then
  # the shipped spec points at :4101; derive one for the chosen port
  sed "s#127.0.0.1:4101#127.0.0.1:$UPSTREAM_PORT#g" examples/spec.json > demo-spec.json
  SPEC=demo-spec.json
fi

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

UPSTREAM_PORT=$UPSTREAM_PORT node --no-warnings=ExperimentalWarning --import tsx examples/upstream.ts &
$TAB catalog serve --db catalog.db --port $CATALOG_PORT --allow-private-origins \
    --try-agent keys/agent-web.json --try-mandate keys/mandate-web.json --try-max-per-call "$MAX_PER_CALL" &
sleep 1
$TAB serve --spec $SPEC --db tab.db --port $GATEWAY_PORT \
    --announce http://127.0.0.1:$CATALOG_PORT --origin http://127.0.0.1:$GATEWAY_PORT &

echo
echo "  gateway   http://127.0.0.1:$GATEWAY_PORT   (curl -i http://127.0.0.1:$GATEWAY_PORT/quote -> 402)"
echo "  catalog   http://127.0.0.1:$CATALOG_PORT   (open this in a browser)"
echo "  paid call: $TAB fetch --agent keys/agent-claude.json --mandate keys/mandate-claude.json http://127.0.0.1:$GATEWAY_PORT/quote"
echo
wait
