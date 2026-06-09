#!/usr/bin/env bash
# Expose the Tellus frontend at https://tellus.gnostr.cloud via the SHARED cloudflared tunnel that already
# fronts saturn / uranus / hyades.gnostr.cloud. The tunnel is REMOTE-managed (config in the Cloudflare API,
# not the in-cluster ConfigMap). Adding a hostname is: a proxied DNS CNAME + ONE ingress rule on the tunnel.
#
# Careful FETCH-MODIFY-WRITE: never blindly overwrites the tunnel config (that would drop the other
# hostnames). It fetches the live ingress, drops any prior tellus rule (idempotent re-runs), inserts the
# single tellus rule ahead of the catch-all, prints the proposed config, and writes only when APPLY=1.
#
# Requires CF_API_TOKEN (Account: Cloudflare Tunnel:Edit + Zone: DNS:Edit on gnostr.cloud).
#   CF_API_TOKEN=... ./deploy/cloudflare-tellus-hostname.sh          # dry run (prints the diff)
#   CF_API_TOKEN=... APPLY=1 ./deploy/cloudflare-tellus-hostname.sh  # apply
set -euo pipefail

ACCOUNT_ID="d401d9ab54fed2ee0ca8f3b36dc6622a"
TUNNEL_ID="ff0a3600-cfb7-419c-b76a-2c4fe4f83b27"
# Override HOSTNAME/ZONE to front the same Tellus deployment under another domain (e.g. the apex
# tellus.garden once its zone is on this Cloudflare account): TELLUS_HOSTNAME=tellus.garden TELLUS_ZONE=tellus.garden
ZONE_NAME="${TELLUS_ZONE:-gnostr.cloud}"
HOSTNAME="${TELLUS_HOSTNAME:-tellus.gnostr.cloud}"
ORIGIN_SERVICE="http://tellus.tellus.svc.cluster.local:80"
API="https://api.cloudflare.com/client/v4"

: "${CF_API_TOKEN:?set CF_API_TOKEN (Account: Cloudflare Tunnel:Edit + Zone: DNS:Edit)}"
auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")
req() { curl -fsS "${auth[@]}" "$@"; }
ok()  { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)'; }

echo "==> Resolving zone id for ${ZONE_NAME}"
ZONE_ID="$(req "${API}/zones?name=${ZONE_NAME}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')"
echo "    zone id: ${ZONE_ID}"

# ---- 1. DNS CNAME (proxied) -> <tunnel>.cfargotunnel.com (idempotent) ----
echo "==> Ensuring DNS CNAME ${HOSTNAME} -> ${TUNNEL_ID}.cfargotunnel.com (proxied)"
EXIST="$(req "${API}/zones/${ZONE_ID}/dns_records?name=${HOSTNAME}")"
REC_ID="$(echo "${EXIST}" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')"
DNS_BODY="$(python3 - "$HOSTNAME" "$TUNNEL_ID" <<'PY'
import json,sys
host,tid=sys.argv[1],sys.argv[2]
print(json.dumps({"type":"CNAME","name":host,"content":f"{tid}.cfargotunnel.com","proxied":True}))
PY
)"
if [ -z "${REC_ID}" ]; then
  if [ "${APPLY:-0}" = "1" ]; then
    req -X POST "${API}/zones/${ZONE_ID}/dns_records" -d "${DNS_BODY}" | ok && echo "    created."
  else
    echo "    [dry-run] would CREATE: ${DNS_BODY}"
  fi
else
  echo "    already exists (id ${REC_ID}) — leaving as-is."
fi

# ---- 2. Tunnel ingress (fetch -> modify -> write) ----
echo "==> Fetching live tunnel configuration"
CFG="$(req "${API}/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations")"

NEW_CFG="$(CFG_JSON="${CFG}" THOST="$HOSTNAME" TORIGIN="$ORIGIN_SERVICE" python3 <<'PY'
import json,os
host,origin=os.environ["THOST"],os.environ["TORIGIN"]
doc=json.loads(os.environ["CFG_JSON"])
cfg=doc.get("result",{}).get("config") or {}
ingress=cfg.get("ingress",[]) or []
# Drop any existing tellus rule (idempotent) and the trailing catch-all; re-add tellus + catch-all.
ingress=[r for r in ingress if r.get("hostname")!=host]
catchall=None
if ingress and "hostname" not in ingress[-1] and ingress[-1].get("service","").startswith("http_status"):
    catchall=ingress.pop()
ingress.append({"hostname":host,"service":origin})
ingress.append(catchall or {"service":"http_status:404"})
cfg["ingress"]=ingress
print(json.dumps({"config":cfg}, indent=2))
PY
)"

echo "==> Proposed tunnel config:"
echo "${NEW_CFG}"

if [ "${APPLY:-0}" = "1" ]; then
  echo "==> Applying (PUT configurations)"
  echo "${NEW_CFG}" | req -X PUT "${API}/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" -d @- | ok \
    && echo "    applied. Verify: curl -s https://${HOSTNAME}/health  (expect {\"ok\":true})"
else
  echo "==> DRY RUN — re-run with APPLY=1 to write DNS + ingress."
fi
