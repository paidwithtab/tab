#!/usr/bin/env bash
# Solana sandbox: starts a local test validator (under ~/.cache/tab-validator),
# fabricates a 6-decimal stablecoin, funds everyone, approves the delegation,
# and starts upstream :4101 + a solana gateway :${PORT:-1404}. Ctrl-C stops it.
# Requires the Solana CLI (solana-test-validator) for the local validator.
set -euo pipefail
cd "$(dirname "$0")/.."

TAB="node --no-warnings=ExperimentalWarning --import tsx src/cli.ts"
export SOLANA_RPC="${SOLANA_RPC:-http://127.0.0.1:8899}"
export PREMIUM_KEY="${PREMIUM_KEY:-demo-key}"
PORT="${PORT:-1404}"
BUDGET="${BUDGET:-1.00}"
MAX_PER_CALL="${MAX_PER_CALL:-0.05}"
DELEGATE="${DELEGATE:-web}"   # web | claude: which agent gets the single SPL delegation

trap 'kill 0' EXIT INT TERM

# 1. validator (skip if something already answers on SOLANA_RPC)
if ! curl -sf -X POST -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$SOLANA_RPC" >/dev/null 2>&1; then
  mkdir -p ~/.cache/tab-validator
  solana-test-validator --ledger ~/.cache/tab-validator --reset --quiet &
  echo "waiting for the validator..."
  for i in $(seq 1 60); do
    curl -sf -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$SOLANA_RPC" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# 2. keys and mandate (idempotent)
mkdir -p keys
[ -f keys/seller.json ]       || $TAB key new --out keys/seller.json
[ -f keys/owner.json ]        || $TAB key new --out keys/owner.json
[ -f keys/feepayer.json ]     || $TAB key new --out keys/feepayer.json
[ -f keys/agent-claude.json ] || $TAB key new --out keys/agent-claude.json
[ -f keys/agent-web.json ]    || $TAB key new --out keys/agent-web.json
AGENT="keys/agent-${DELEGATE}.json"
MANDATE="keys/mandate-solana-${DELEGATE}.json"
[ -f "$MANDATE" ] || $TAB mandate issue --owner keys/owner.json --agent "$AGENT" \
    --budget "$BUDGET" --window day --max-per-call "$MAX_PER_CALL" --allow 'quotes.local' --days 30 --out "$MANDATE"

# 3. SOL for fees, a fabricated stablecoin for the owner, the delegation
$TAB solana airdrop --wallet keys/feepayer.json --sol 2
$TAB solana airdrop --wallet keys/owner.json --sol 2
if [ -z "${MINT:-}" ]; then
  MINT="$(node --no-warnings=ExperimentalWarning --import tsx examples/make-mint.ts keys/owner.json keys/owner.json 100.00 | sed -n 's/^MINT=//p')"
fi
export MINT
echo "MINT=$MINT"
$TAB solana approve --owner keys/owner.json --agent "$AGENT" --amount "$BUDGET" --mint "$MINT"
$TAB solana balance --wallet keys/owner.json --mint "$MINT"

# 4. servers
export SELLER="$(node -p "require('./keys/seller.json').publicKey")"
UPSTREAM_PORT=4101 node --no-warnings=ExperimentalWarning --import tsx examples/upstream.ts &
sleep 1
$TAB serve --spec examples/spec-solana.json --db tab-solana.db --port "$PORT" &

echo
echo "  solana gateway  http://127.0.0.1:$PORT"
echo "  paid call: $TAB fetch --agent $AGENT --mandate $MANDATE http://127.0.0.1:$PORT/quote"
echo
wait
