#!/usr/bin/env bash
# Binds the custom domain and a free App Service managed TLS certificate.
# Run after the CNAME and asuid TXT records from deploy.sh exist:  ./infra/bind-domain.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RG="${RESOURCE_GROUP:-rg-btc-helpdesk}"
HOST=$(python3 -c "import json;print(json.load(open('infra/main.parameters.json'))['parameters']['appHostname']['value'])")
WEB=$(az webapp list -g "$RG" --query "[0].name" -o tsv)

echo "Checking DNS for $HOST ..."
nslookup -type=CNAME "$HOST" >/dev/null 2>&1 || echo "  (could not confirm the CNAME yet; continuing — Azure will verify)"

echo "Adding host name $HOST to $WEB"
az webapp config hostname add -g "$RG" --webapp-name "$WEB" --hostname "$HOST" -o none

echo "Creating free managed certificate (can take a few minutes)"
az webapp config ssl create -g "$RG" -n "$WEB" --hostname "$HOST" -o none || true
THUMB=""
for i in {1..30}; do
  THUMB=$(az webapp config ssl list -g "$RG" --query "[?subjectName=='$HOST'].thumbprint | [0]" -o tsv 2>/dev/null || true)
  [[ -n "$THUMB" ]] && break
  sleep 10
done
[[ -z "$THUMB" ]] && { echo "Certificate not ready yet. Re-run this script in a few minutes."; exit 1; }

echo "Binding certificate"
az webapp config ssl bind -g "$RG" -n "$WEB" --certificate-thumbprint "$THUMB" --ssl-type SNI -o none
echo "Done: https://$HOST"
