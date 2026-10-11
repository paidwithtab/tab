#!/usr/bin/env bash
# End-to-end paid call over the evm rail, against the public gateway for one chain.
#   bash scripts/chain-trial.sh testnet    # needs testnet ETH at the owner address (faucet)
#   bash scripts/chain-trial.sh mainnet    # needs real ETH and USDG at the owner address
# Owner key: keys/mainnet-owner.json. Agent key: keys/mainnet-agent.json. Same keys on both chains.
set -euo pipefail
cd "$(dirname "$0")/.."
NET=${1:-testnet}
case "$NET" in
  testnet) RPC=https://rpc.testnet.chain.robinhood.com; TOKEN=0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5; GAS=0.002; BUDGET=1.00 ;;
  mainnet) RPC=https://rpc.mainnet.chain.robinhood.com; TOKEN=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; GAS=0.0005; BUDGET=0.50 ;;
  *) echo "usage: $0 testnet|mainnet"; exit 1 ;;
esac
TAB="node --no-warnings=ExperimentalWarning dist/src/cli.js"
OWNER=keys/mainnet-owner.json; AGENT=keys/mainnet-agent.json; MANDATE=keys/mandate-$NET.json
REALM=$NET.paidwithtab.com

echo "== balances before"
$TAB evm balance --wallet $OWNER --token $TOKEN --agent $AGENT --rpc $RPC

if [ "$NET" = testnet ]; then
  echo "== mint 5.00 test USDC to the owner (open-mint testnet token)"
  npx tsx scripts/evm-mint.ts $OWNER $TOKEN 5.00 $RPC
fi

echo "== give the agent gas ($GAS ETH) and a $BUDGET allowance"
$TAB evm fund --from $OWNER --to $AGENT --eth $GAS --rpc $RPC
$TAB evm approve --owner $OWNER --agent $AGENT --amount $BUDGET --token $TOKEN --rpc $RPC

echo "== issue a mandate for $REALM"
$TAB mandate issue --owner $OWNER --agent $AGENT --budget $BUDGET --window day --max-per-call 0.05 --allow $REALM --days 30 --out $MANDATE

echo "== one paid call (Wikipedia summary, \$0.001)"
$TAB fetch --agent $AGENT --mandate $MANDATE "https://$REALM/wikipedia/api/rest_v1/page/summary/HTTP_402" | head -c 400; echo

echo "== balances after, and the public receipt"
$TAB evm balance --wallet $OWNER --token $TOKEN --agent $AGENT --rpc $RPC
curl -s -m 10 "https://$REALM/.well-known/tab/receipts?limit=1"; echo
echo "look for the tx on the explorer listed in examples/spec-$NET.json"
