#!/usr/bin/env bash
# Prints the apps' runtime config.json from deploy.json, as spec/deploy.md,
# "App config.json" says. It matches spec/web-config.schema.json.
#
# Usage:
#   [DEPLOY_JSON=path] deploy/web-config.sh [--exam <examId>] > apps/verifier/dist/config.json
#
# The file is $DEPLOY_JSON, else deploy/deploy.json. A variable already set in
# the environment wins over the file, as in the other scripts. --exam (or
# EXAM_ID) adds the optional examId fallback. Nothing here is secret: every
# value is a public locator, checked again by the apps' attestation, chain and
# hash checks.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/config.sh"

die() { echo "error: $*" >&2; exit 1; }

exam="${EXAM_ID:-}"
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --exam) [ $# -gt 0 ] || die "--exam needs an exam ID"; exam="$1"; shift ;;
    --exam=*) exam="${a#*=}" ;;
    *) die "unknown argument: $a" ;;
  esac
done

[ -n "$DEPLOY_JSON_FILE" ] || die "no deploy.json: copy deploy/deploy.example.json to deploy/deploy.json, or set DEPLOY_JSON"
for v in TEE_HOST RPC_URL REGISTRY CHAIN_ID; do
  [ -n "${!v:-}" ] || die "$v is empty: check $DEPLOY_JSON_FILE"
done
[ -n "${BUCKET:-}" ] || { [ -n "${PROJECT_ID:-}" ] || die "set storage.bucket or gcp.project"; BUCKET="${PROJECT_ID}-paperseal-exams"; }
if [ -n "$exam" ]; then
  exam="$(printf %s "$exam" | tr '[:upper:]' '[:lower:]')"
  [[ "$exam" =~ ^0x[0-9a-f]{64}$ ]] || die "--exam must be 0x and 64 hex digits"
fi

constants="$REPO_ROOT/spec/constants.json"
const_chain_id="$(jq -er '.chain.chainId' "$constants")"
[ "$CHAIN_ID" = "$const_chain_id" ] || die "chain.chainId ($CHAIN_ID) is not chain.chainId in spec/constants.json ($const_chain_id)"

# Optional values are left out when unset, so the apps use their own defaults.
jq -n \
  --arg teeUrl "https://$TEE_HOST" \
  --arg rpcUrl "$RPC_URL" \
  --arg registry "$REGISTRY" \
  --argjson chainId "$CHAIN_ID" \
  --arg chainName "$(jq -er '.chain.name' "$constants")" \
  --arg storageUrl "https://storage.googleapis.com/$BUCKET" \
  --arg storageBucket "$BUCKET" \
  --arg repository "${APPS_REPOSITORY:-}" \
  --arg examId "$exam" \
  --arg arkivWriters "${APPS_ARKIV_WRITERS:-}" \
  --arg swarmApiUrl "${APPS_SWARM_API_URL:-}" \
  --arg releaseTag "${APPS_RELEASE_TAG:-}" \
  '{teeUrl: $teeUrl, rpcUrl: $rpcUrl, registry: $registry, chainId: $chainId,
    chainName: $chainName, storageUrl: $storageUrl, storageBucket: $storageBucket,
    repository: $repository, examId: $examId, arkivWriters: $arkivWriters,
    swarmApiUrl: $swarmApiUrl, releaseTag: $releaseTag}
   | with_entries(select(.value != ""))'
