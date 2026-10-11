#!/usr/bin/env bash
# One-time go-live for the three public gateways behind the tab tunnel (DEPLOY.md section 19).
# Run from a normal terminal on the box; it asks for your sudo password once:
#   bash scripts/go-live.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=$HOME/.cloudflared/tab-config.yml

echo "== 1. testnet and mainnet gateway units (user level, next to tab-gateway)"
cp examples/tab-gateway-testnet.service examples/tab-gateway-mainnet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tab-gateway-testnet tab-gateway-mainnet
systemctl --user is-active tab-gateway tab-gateway-testnet tab-gateway-mainnet | paste -sd' '

echo "== 2. tunnel ingress for pay, testnet and mainnet"
cp -n "$CFG" "$CFG.bak-$(date +%Y%m%d)" || true
python3 -I - "$CFG" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
add = """  - hostname: pay.paidwithtab.com
    service: http://127.0.0.1:1402
  - hostname: testnet.paidwithtab.com
    service: http://127.0.0.1:1404
  - hostname: mainnet.paidwithtab.com
    service: http://127.0.0.1:1405
"""
if 'pay.paidwithtab.com' not in s:
    s = s.replace("  - service: http_status:404", add + "  - service: http_status:404")
    open(p, 'w').write(s)
    print("ingress added")
else:
    print("ingress already present")
PY
cloudflared tunnel --config "$CFG" ingress validate

echo "== 3. DNS records pointing at the tunnel"
for h in pay testnet mainnet; do cloudflared tunnel route dns tab "$h.paidwithtab.com" || true; done

echo "== 4. restart the tunnel, install the catalog unit with the Buy button (sudo)"
sudo systemctl restart cloudflared-tab
sudo cp examples/tab-catalog.service /etc/systemd/system/tab-catalog.service
sudo systemctl daemon-reload
sudo systemctl restart tab-catalog
sleep 6

echo "== 5. announce the gateways to the catalog"
for h in pay testnet mainnet; do
  curl -s -m 10 -X POST -H 'content-type: application/json' \
    -d "{\"origin\":\"https://$h.paidwithtab.com\"}" http://127.0.0.1:1403/v1/announce
  echo
done

echo "== 6. verify from the outside"
for h in pay testnet mainnet; do
  printf '%s: ' "$h"
  curl -s -m 10 -o /dev/null -w '%{http_code}\n' "https://$h.paidwithtab.com/.well-known/tab"
done
curl -s -m 10 https://paidwithtab.com/v1/catalog.json | head -c 800
echo
echo "done. open https://paidwithtab.com/catalog"
