#!/usr/bin/env bash
# Starts ONE Confidential VM running the TEE image, by digest, on the
# production confidential-space image (not debug).
#
# Usage, reading the settings from the chain (the usual way):
#   [DEPLOY_JSON=...] [DRY_RUN=1] ./run-tee.sh --from-chain --exam <examId> [--replace | --reset]
#
#   It calls getExam(examId) on REGISTRY through RPC_URL with `cast call` and
#   uses exactly the stored settings and image digest. REGISTRY, RPC_URL,
#   RPC_HOST and CHAIN_ID come from deploy.json (chain.*) or the environment.
#   It refuses if the exam isn't on-chain, if its rpcHost differs from
#   RPC_HOST, or if RPC_URL is on another chain. The chain is read even with
#   DRY_RUN=1, because reading changes nothing.
#
# Usage, with every setting given by hand:
#   PROJECT_ID=... REGION=... ZONE=... [BUCKET=...] [DRY_RUN=1] ./run-tee.sh \
#     --exam-id=0x<32 bytes> --exam-start=<secs> --delta=<secs> \
#     --lock-round=<n> --unlock-round=<n> --end-round=<n> \
#     --criteria-hash=0x<32 bytes> --rpc-host=<hostname> \
#     --registry=0x<20 bytes> --chain-id=<n> \
#     --image-digest=sha256:<64 hex> [--replace | --reset]
#
# The ten exam settings become tee-cmd in the exact order of spec/api.md,
# "Exam Settings". They are attested, so they must match the on-chain exam
# byte for byte. --replace deletes an existing VM of the same name first.
# --reset keeps the VM, writes the new settings and reboots it, which is faster.
# A reboot clears memory, and the launcher attests the new settings as usual.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

replace=0
reset=0
from_chain=0
manual=0
exam_arg=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --replace) replace=1 ;;
    --reset) reset=1 ;;
    --from-chain) from_chain=1 ;;
    --exam) [ $# -gt 0 ] || die "--exam needs an exam ID"; exam_arg="$1"; shift ;;
    --exam=*) exam_arg="${a#*=}" ;;
    --exam-id=*|--exam-start=*|--delta=*|--lock-round=*|--unlock-round=*|--end-round=*|\
    --criteria-hash=*|--rpc-host=*|--registry=*|--chain-id=*|--image-digest=*)
      manual=1; k="${a%%=*}"; k="${k#--}"; printf -v "v_${k//-/_}" %s "${a#*=}" ;;
    *) die "unknown argument: $a" ;;
  esac
done

order=(exam-id exam-start delta lock-round unlock-round end-round criteria-hash rpc-host registry chain-id)
val() { local n="v_${1//-/_}"; printf %s "${!n:-}"; }
hex32='^0x[0-9a-f]{64}$'; hex20='^0x[0-9a-f]{40}$'; dec='^(0|[1-9][0-9]*)$'

# getExam's return tuple, from ExamRegistry.Exam in contracts/src/ExamRegistry.sol:
# (commitHash, imageDigest, createdAt, createdBlock,
#  (examId, examStart, delta, lockRound, unlockRound, endRound, criteriaHash, rpcHost))
GET_EXAM_SIG='getExam(bytes32)((bytes20,bytes32,uint64,uint64,(bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,string)))'

if [ "$from_chain" = 1 ]; then
  [ "$manual" = 0 ] || die "--from-chain reads every setting from the chain: drop the --<setting>= flags"
  [ -n "$exam_arg" ] || die "--from-chain needs --exam <examId>"
  exam="$(printf %s "$exam_arg" | tr '[:upper:]' '[:lower:]')"
  [[ "$exam" =~ $hex32 ]] || die "--exam must be 0x and 64 hex digits"
  for v in REGISTRY RPC_URL RPC_HOST CHAIN_ID; do
    [ -n "${!v:-}" ] || die "set $v, or chain.* in deploy.json, to use --from-chain"
  done
  registry="$(printf %s "$REGISTRY" | tr '[:upper:]' '[:lower:]')"
  [[ "$registry" =~ $hex20 ]] || die "REGISTRY ($REGISTRY) is not a 20-byte hex address"
  [[ "$CHAIN_ID" =~ $dec ]] || die "CHAIN_ID ($CHAIN_ID) is not a decimal number"
  command -v cast >/dev/null || die "cast (Foundry) is needed for --from-chain"

  rpc_chain="$(cast chain-id --rpc-url "$RPC_URL" 2>&1)" || die "could not read the chain ID from $RPC_URL: $rpc_chain"
  [ "$rpc_chain" = "$CHAIN_ID" ] || die "$RPC_URL is on chain $rpc_chain, not $CHAIN_ID"
  json="$(cast call --json --rpc-url "$RPC_URL" "$registry" "$GET_EXAM_SIG" "$exam" 2>&1)" \
    || die "getExam($exam) on $registry failed: $json"
  fields="$(jq -er '.[0] as $e | $e[4] as $s
    | [$e[2], $e[1], $s[0], $s[1], $s[2], $s[3], $s[4], $s[5], $s[6], $s[7]]
    | map(tostring) | @tsv' <<<"$json")" || die "could not decode getExam's result: $json"
  IFS=$'\t' read -r created_at digest c_exam_id c_exam_start c_delta c_lock c_unlock c_end c_criteria c_rpc_host <<<"$fields"

  [ "$created_at" != 0 ] || die "exam $exam is not on-chain at $registry (chain $CHAIN_ID). Publish it in the board app first."
  [ "$(printf %s "$c_exam_id" | tr '[:upper:]' '[:lower:]')" = "$exam" ] || die "getExam returned exam $c_exam_id, not $exam"
  [ "$c_rpc_host" = "$RPC_HOST" ] \
    || die "the exam's on-chain rpcHost is \"$c_rpc_host\" but the configured one (RPC_HOST, chain.rpcHost) is \"$RPC_HOST\". The TEE would read the chain through a host the exam didn't name."
  digest="$(printf %s "${digest#0x}" | tr '[:upper:]' '[:lower:]')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ && "$digest" != "$(printf '0%.0s' {1..64})" ]] || die "the exam's on-chain imageDigest is empty or malformed"

  v_exam_id="$exam"
  v_exam_start="$c_exam_start"
  v_delta="$c_delta"
  v_lock_round="$c_lock"
  v_unlock_round="$c_unlock"
  v_end_round="$c_end"
  v_criteria_hash="$(printf %s "$c_criteria" | tr '[:upper:]' '[:lower:]')"
  v_rpc_host="$c_rpc_host"
  v_registry="$registry"
  v_chain_id="$CHAIN_ID"
  v_image_digest="sha256:$digest"
  echo "from chain $CHAIN_ID, registry $registry, exam $exam (created at $created_at):"
  for k in "${order[@]}" image-digest; do printf '  --%s=%s\n' "$k" "$(val "$k")"; done
elif [ -n "$exam_arg" ]; then
  die "--exam goes with --from-chain. To give the settings by hand, use --exam-id=... and the other flags."
fi
for k in "${order[@]}" image-digest; do [ -n "$(val "$k")" ] || die "missing --$k"; done

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
metadata="^~^tee-image-reference=${image}~tee-cmd=${cmd}~tee-env-STORAGE_BUCKET=${BUCKET}"

[ "$replace$reset" != 11 ] || die "pass --replace or --reset, not both"
if [ "$reset" = 1 ]; then
  exists gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
    || die "VM $VM_NAME doesn't exist: start it once without --reset"
  run gcloud compute instances add-metadata "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
    --metadata="$metadata"
  status="$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --format='value(status)' 2>/dev/null || true)"
  if [ "$status" = TERMINATED ]; then
    run gcloud compute instances start "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
  else
    run gcloud compute instances reset "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
  fi
  echo "VM $VM_NAME is rebooting with the new settings."
  exit 0
fi

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
