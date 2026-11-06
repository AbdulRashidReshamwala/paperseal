# Reads deploy.json into the shell variables the deploy scripts use.
# Sourced by deploy/gcp/lib.sh, deploy/doctor.sh and deploy/web-config.sh, not run directly.
#
# The file is $DEPLOY_JSON when set, else deploy/deploy.json if it exists.
# Without either, nothing is read and the scripts work from exported variables
# alone, as before. A variable that is already set always wins over the file,
# so `PROJECT_ID=other ./run-tee.sh ...` still overrides it.
#
# See spec/deploy.md and spec/deploy.schema.json. The file holds no secret.
# shellcheck shell=bash disable=SC2034

DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_ROOT/.." && pwd)"

_cfg_die() { echo "error: $*" >&2; exit 1; }

# Foundry installs to ~/.foundry/bin, which a non-interactive shell may not have.
if ! command -v cast >/dev/null 2>&1 && [ -x "$HOME/.foundry/bin/cast" ]; then
  PATH="$PATH:$HOME/.foundry/bin"
fi

DEPLOY_JSON_FILE=""
if [ -n "${DEPLOY_JSON:-}" ]; then
  [ -f "$DEPLOY_JSON" ] || _cfg_die "DEPLOY_JSON=$DEPLOY_JSON does not exist"
  DEPLOY_JSON_FILE="$DEPLOY_JSON"
elif [ -f "$DEPLOY_ROOT/deploy.json" ]; then
  DEPLOY_JSON_FILE="$DEPLOY_ROOT/deploy.json"
fi

if [ -n "$DEPLOY_JSON_FILE" ]; then
  command -v jq >/dev/null 2>&1 || _cfg_die "jq is needed to read $DEPLOY_JSON_FILE"
  jq -e 'type == "object"' "$DEPLOY_JSON_FILE" >/dev/null 2>&1 \
    || _cfg_die "$DEPLOY_JSON_FILE is not a JSON object"
  # One line per value present in the file: NAME<TAB>value. Schema patterns
  # allow no tab or newline in any value.
  while IFS=$'\t' read -r _cfg_k _cfg_v; do
    [ -n "${!_cfg_k:-}" ] || printf -v "$_cfg_k" '%s' "$_cfg_v"
  done < <(jq -r '
    [ ["PROJECT_ID",         .gcp.project],
      ["REGION",             .gcp.region],
      ["ZONE",               .gcp.zone],
      ["MACHINE_TYPE",       .gcp.machineType],
      ["IMAGE_REPO",         .image.repo],
      ["BUCKET",             .storage.bucket],
      ["INGRESS_KIND",       .ingress.kind],
      ["TEE_HOST",           .ingress.teeHost],
      ["APP_HOST",           .web.appHost],
      ["VERIFIER_HOST",      .web.verifierHost],
      ["CHAIN_ID",           .chain.chainId],
      ["RPC_URL",            .chain.rpcUrl],
      ["RPC_HOST",           .chain.rpcHost],
      ["REGISTRY",           .chain.registry],
      ["APPS_REPOSITORY",    .apps.repository],
      ["APPS_ARKIV_WRITERS", .apps.arkivWriters],
      ["APPS_SWARM_API_URL", .apps.swarmApiUrl],
      ["APPS_RELEASE_TAG",   .apps.releaseTag]
    ] | .[] | select(.[1] != null) | [.[0], (.[1] | tostring)] | @tsv' "$DEPLOY_JSON_FILE")
  unset _cfg_k _cfg_v
fi

# ingress.kind defaults to what the scripts have always done.
: "${INGRESS_KIND:=cloudflare}"
