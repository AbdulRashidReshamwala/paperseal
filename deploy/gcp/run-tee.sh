#!/usr/bin/env bash
# Starts ONE Confidential VM running the TEE image, by digest, on the
# production confidential-space image (not debug).
#
# Usage:
#   PROJECT_ID=... REGION=... ZONE=... [BUCKET=...] [DRY_RUN=1] ./run-tee.sh \
#     --exam-id=0x<32 bytes> --exam-start=<secs> --delta=<secs> \
#     --lock-round=<n> --unlock-round=<n> --end-round=<n> \
#     --criteria-hash=0x<32 bytes> --rpc-host=<hostname> \
#     --registry=0x<20 bytes> --chain-id=<n> \
#     --image-digest=sha256:<64 hex> [--replace]
#
# The ten exam settings become tee-cmd in the exact order of spec/api.md,
# "Exam Settings". They are attested, so they must match the on-chain exam
# byte for byte. --replace deletes an existing VM of the same name first.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

replace=0
for a in "$@"; do
  case "$a" in
    --replace) replace=1 ;;
    --exam-id=*|--exam-start=*|--delta=*|--lock-round=*|--unlock-round=*|--end-round=*|\
    --criteria-hash=*|--rpc-host=*|--registry=*|--chain-id=*|--image-digest=*)
      k="${a%%=*}"; k="${k#--}"; printf -v "v_${k//-/_}" %s "${a#*=}" ;;
    *) die "unknown argument: $a" ;;
  esac
done

order=(exam-id exam-start delta lock-round unlock-round end-round criteria-hash rpc-host registry chain-id)
val() { local n="v_${1//-/_}"; printf %s "${!n:-}"; }
for k in "${order[@]}" image-digest; do [ -n "$(val "$k")" ] || die "missing --$k"; done

hex32='^0x[0-9a-f]{64}$'; hex20='^0x[0-9a-f]{40}$'; dec='^(0|[1-9][0-9]*)$'
chk() { [[ "$(val "$1")" =~ $2 ]] || die "--$1 has the wrong format (lowercase hex or canonical decimal, as in spec/api.md)"; }
chk exam-id "$hex32"; chk criteria-hash "$hex32"; chk registry "$hex20"
for k in exam-start delta lock-round unlock-round end-round chain-id; do chk $k "$dec"; done
[[ "$(val rpc-host)" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "--rpc-host must be a lowercase hostname with no scheme, port or path"
[[ "$(val image-digest)" =~ ^sha256:[0-9a-f]{64}$ ]] || die "--image-digest must be sha256:<64 lowercase hex>"

# tee-cmd: a JSON array, one "--name=value" per setting. Values are validated
# above to contain no quote, backslash or tilde, so no escaping is needed.
cmd="["
for k in "${order[@]}"; do cmd+="\"--$k=$(val "$k")\","; done
cmd="${cmd%,}]"

image="${IMAGE_REPO}@$(val image-digest)"
# "^~^" makes "~" the separator between metadata keys, because tee-cmd has commas.
metadata="^~^tee-image-reference=${image}~tee-cmd=${cmd}~tee-env-STORAGE_BUCKET=${BUCKET}~tee-container-log-redirect=cloud_logging"

if exists gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"; then
  if [ "$replace" = 1 ]; then
    run gcloud compute instances delete "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --quiet
  else
    die "VM $VM_NAME already exists. Settings are fixed at creation: pass --replace to delete and recreate it. Recreating loses the TEE's in-memory state."
  fi
fi

# Static external IP (regional, reused if it exists).
if exists gcloud compute addresses describe "$ADDRESS_NAME" --region="$REGION" --project="$PROJECT_ID"; then
  echo "address $ADDRESS_NAME exists"
else
  run gcloud compute addresses create "$ADDRESS_NAME" --region="$REGION" --project="$PROJECT_ID"
fi

# Firewall: 8080 from Cloudflare's published IPv4 ranges only.
ranges="$(curl -fsS https://www.cloudflare.com/ips-v4 | tr '\n' ',' | sed 's/,$//')"
[[ "$ranges" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2},)*[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] \
  || die "could not read Cloudflare's IP ranges from https://www.cloudflare.com/ips-v4"
if exists gcloud compute firewall-rules describe "$FIREWALL_NAME" --project="$PROJECT_ID"; then
  run gcloud compute firewall-rules update "$FIREWALL_NAME" --project="$PROJECT_ID" \
    --source-ranges="$ranges"
else
  run gcloud compute firewall-rules create "$FIREWALL_NAME" --project="$PROJECT_ID" \
    --network="$NETWORK" --direction=INGRESS --action=ALLOW --rules=tcp:8080 \
    --source-ranges="$ranges" --target-tags="$NETWORK_TAG"
fi

# n2d + SEV supports live migration, which the docs set as MIGRATE.
if [ "$DRY_RUN" = 1 ]; then
  address='<static IP of '"$ADDRESS_NAME"'>'
else
  address="$(gcloud compute addresses describe "$ADDRESS_NAME" --region="$REGION" --project="$PROJECT_ID" --format='value(address)')"
fi
run gcloud compute instances create "$VM_NAME" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --confidential-compute-type=SEV \
  --maintenance-policy=MIGRATE \
  --shielded-secure-boot \
  --image-project=confidential-space-images \
  --image-family=confidential-space \
  --service-account="$SA_EMAIL" \
  --scopes=cloud-platform \
  --network="$NETWORK" --tags="$NETWORK_TAG" \
  --address="$address" \
  --metadata="$metadata"

echo "image:   $image"
echo "address: $address"
echo "Point the Cloudflare proxied A record at that address, port 8080 is the origin."
echo "A demo VM costs money while it runs. Stop it afterwards: ./stop-tee.sh"
