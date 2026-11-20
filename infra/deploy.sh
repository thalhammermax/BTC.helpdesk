#!/usr/bin/env bash
# Deploys (or updates) the BTC Help Desk on Azure. Safe to re-run.
# Run from the repository root, ideally in Azure Cloud Shell (bash):  ./infra/deploy.sh
#
# Optional environment variables:
#   RESOURCE_GROUP   (default rg-btc-helpdesk)
#   LOCATION         (default from infra/main.parameters.json, else northcentralus)
#   GOOGLE_SA_KEY    path to the Google service-account JSON key (stored in Key Vault)
#   SKIP_BUILD=1     don't build/push a container image (GitHub Actions does it later)
set -euo pipefail
cd "$(dirname "$0")/.."

RG="${RESOURCE_GROUP:-rg-btc-helpdesk}"
PARAMS=infra/main.parameters.json
LOCATION="${LOCATION:-$(python3 -c "import json;print(json.load(open('$PARAMS'))['parameters']['location']['value'])" 2>/dev/null || echo northcentralus)}"
param() { python3 -c "import json;print(json.load(open('$PARAMS'))['parameters'].get('$1',{}).get('value',''))"; }

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

az account show >/dev/null 2>&1 || az login >/dev/null
SUB_NAME=$(az account show --query name -o tsv)
SUB_ID=$(az account show --query id -o tsv)
say "Subscription: $SUB_NAME ($SUB_ID)   Resource group: $RG   Region: $LOCATION"
read -rp "Continue? [y/N] " ok; [[ "$ok" =~ ^[Yy]$ ]] || exit 1

[[ -z "$(param alertEmail)" ]] && { warn "Set alertEmail in $PARAMS first."; exit 1; }
[[ -z "$(param entraClientId)" ]] && warn "entraClientId is empty: the site will deploy, but sign-in won't work until you set it and re-run."
[[ -z "$(param bootstrapAdminEmails)" ]] && warn "bootstrapAdminEmails is empty: make sure someone has the Helpdesk.Admin app role in Entra."

say "Registering resource providers (first run only takes a minute)"
for ns in Microsoft.Web Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.Storage Microsoft.ContainerRegistry Microsoft.OperationalInsights Microsoft.Insights Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" >/dev/null
done

say "Creating resource group"
az group create -n "$RG" -l "$LOCATION" -o none

DEPLOYER=$(az ad signed-in-user show --query id -o tsv)

# Reuse the existing Postgres password (kept in Key Vault) so re-runs don't rotate it.
KV=$(az keyvault list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)
PG_PASS=""
if [[ -n "$KV" ]]; then
  PG_PASS=$(az keyvault secret show --vault-name "$KV" -n postgres-admin-password --query value -o tsv 2>/dev/null || true)
fi
if [[ -z "$PG_PASS" ]]; then
  PG_PASS="Hd$(openssl rand -hex 20)!x9"
fi

DEPLOY_ARGS=(-g "$RG" -f infra/main.bicep -p "@$PARAMS" -p location="$LOCATION" deployerObjectId="$DEPLOYER" postgresAdminPassword="$PG_PASS")

say "Validating template"
az deployment group validate "${DEPLOY_ARGS[@]}" -o none

say "Deploying infrastructure (about 10 minutes on the first run)"
OUT=$(az deployment group create -n "helpdesk-$(date +%Y%m%d%H%M%S)" "${DEPLOY_ARGS[@]}" --query properties.outputs -o json)
out() { echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1']['value'])"; }
WEB=$(out webAppName); KV=$(out keyVaultName); ACR=$(out acrName)
WEB_HOST=$(out webDefaultHostname); VERIFY=$(out customDomainVerificationId)
DEPLOY_CLIENT=$(out deployIdentityClientId); TENANT=$(out tenantId)

# Key Vault role assignments can take a minute to apply; retry writes.
kv_set() { # name, then either --value X or --file Y
  local name="$1"; shift
  for i in {1..12}; do
    if az keyvault secret set --vault-name "$KV" -n "$name" "$@" -o none 2>/dev/null; then return 0; fi
    sleep 10
  done
  echo "Could not write secret $name to $KV" >&2; return 1
}
kv_has() { az keyvault secret show --vault-name "$KV" -n "$1" -o none 2>/dev/null; }

say "Storing secrets in Key Vault $KV"
kv_has session-secret || kv_set session-secret --value "$(openssl rand -base64 48)"

if ! kv_has entra-client-secret; then
  read -rsp "Entra client secret value (leave empty to set later): " ES; echo
  if [[ -n "$ES" ]]; then kv_set entra-client-secret --value "$ES"; else warn "entra-client-secret not set; sign-in will fail until it is."; fi
fi

if [[ "$(param gmailAuth)" == "service_account" ]]; then
  if ! kv_has google-service-account-json; then
    KEY="${GOOGLE_SA_KEY:-}"
    [[ -z "$KEY" ]] && read -rp "Path to Google service-account JSON key (leave empty to set later): " KEY
    if [[ -n "$KEY" ]]; then kv_set google-service-account-json --file "$KEY" --encoding utf-8; else warn "Google key not set; email won't work until it is."; fi
  fi
else
  for s in gmail-oauth-client-id gmail-oauth-client-secret gmail-oauth-refresh-token; do
    if ! kv_has "$s"; then
      read -rsp "$s (leave empty to set later): " V; echo
      [[ -n "$V" ]] && kv_set "$s" --value "$V"
    fi
  done
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  say "Building the container image in Azure Container Registry (5-8 minutes)"
  az acr build -r "$ACR" -t helpdesk:latest -t "helpdesk:manual-$(date +%Y%m%d%H%M%S)" -f Dockerfile . -o none
fi

say "Restarting the app so it picks up secrets and the image"
az webapp restart -g "$RG" -n "$WEB" -o none

say "Waiting for the app to become healthy (first start runs database migrations)"
for i in {1..40}; do
  if curl -fsS "https://$WEB_HOST/healthz" >/dev/null 2>&1; then echo "Healthy: https://$WEB_HOST/healthz"; break; fi
  sleep 15
  [[ $i == 40 ]] && warn "Not healthy yet. Check logs: az webapp log tail -g $RG -n $WEB"
done

HOST=$(param appHostname)
SUB_LABEL="${HOST%%.*}"
cat <<EOM

$(printf '\033[1;32m')Deployment complete.$(printf '\033[0m')

1) DNS: at your DNS provider for ${HOST#*.}, create:
     CNAME  $SUB_LABEL          ->  $WEB_HOST
     TXT    asuid.$SUB_LABEL    ->  $VERIFY
   Then run:  ./infra/bind-domain.sh     (adds the domain + free TLS certificate)

2) Entra app registration redirect URI (Web):  https://$HOST/auth/callback

3) GitHub repo -> Settings -> Secrets and variables -> Actions -> Variables tab -> New repository variable, add:
     AZURE_CLIENT_ID        = $DEPLOY_CLIENT
     AZURE_TENANT_ID        = $TENANT
     AZURE_SUBSCRIPTION_ID  = $SUB_ID
     AZURE_RESOURCE_GROUP   = $RG
     AZURE_WEBAPP_NAME      = $WEB
     AZURE_ACR_NAME         = $ACR
   Every push to main then tests, builds and deploys automatically.

Logs:     az webapp log tail -g $RG -n $WEB
Secrets:  az keyvault secret set --vault-name $KV -n <name> --value <value>   (then restart the app)
EOM
