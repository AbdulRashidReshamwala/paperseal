#!/usr/bin/env bash
# Preflight checks for a deployment, from deploy.json (spec/deploy.md, "One
# Command per Exam"). One line per check, ok, fail or skip, then the passkey
# warning. Exits 1 if any check failed. Read-only: it creates and changes
# nothing, and needs no login.
#
# Usage: [DEPLOY_JSON=path] deploy/doctor.sh [--exam <examId>]
#
# The file is $DEPLOY_JSON, else deploy/deploy.json. As in the other scripts, a
# variable already set in the environment wins over the file for checks 2 to 7.
# --exam (or IMAGE_DIGEST=sha256:...) makes check 2 pull the manifest of that
# exam's image digest rather than only asking for the repository.
#
# Needs jq, curl, dig or host, and cast (Foundry).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/config.sh"

exam=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --exam) exam="${1:-}"; shift || true ;;
    --exam=*) exam="${a#*=}" ;;
    *) echo "error: unknown argument: $a" >&2; exit 2 ;;
  esac
done

failed=0
report() { # report ok|fail|skip <n> <title> <detail>
  printf '%-4s %s. %s: %s\n' "$1" "$2" "$3" "$4"
  [ "$1" != fail ] || failed=1
}

for tool in jq curl; do
  command -v "$tool" >/dev/null || { echo "error: $tool is needed" >&2; exit 2; }
done

CURL=(curl -sS --max-time 15)
SCHEMA="$REPO_ROOT/spec/deploy.schema.json"
CONSTANTS="$REPO_ROOT/spec/constants.json"

# --- 1. deploy.json matches the schema, and zone is in region ---------------
# The schema is checked with jq, not ajv: `npx ajv-cli` fetches a package on
# each run and needs the network. The jq walker below reads the schema itself
# and applies the keywords it uses (type, required, additionalProperties: false,
# properties, enum, pattern, minimum, $ref to #/definitions), so it follows any
# change to spec/deploy.schema.json that stays within those keywords.
schema_errors() {
  jq -r --slurpfile schema "$SCHEMA" '
    def errs($s; $root; $p):
      (if ($s | has("$ref")) then $root.definitions[$s["$ref"] | ltrimstr("#/definitions/")] else $s end) as $s
      | . as $x
      | (if   $s.type == "object"  then (if ($x | type) == "object" then null else "must be an object" end)
         elif $s.type == "string"  then (if ($x | type) == "string" then null else "must be a string" end)
         elif $s.type == "integer" then (if ($x | type) == "number" and ($x | floor) == $x then null else "must be an integer" end)
         else null end) as $te
      | if $te then "\($p): \($te)"
        else
          (if $s.enum and ([$s.enum[] == $x] | any | not) then "\($p): must be one of \($s.enum | map(tojson) | join(", "))" else empty end),
          (if $s.pattern and ($x | type) == "string" and ($x | test($s.pattern) | not) then "\($p): \($x | tojson) does not match \($s.pattern)" else empty end),
          (if $s.minimum != null and ($x | type) == "number" and $x < $s.minimum then "\($p): must be at least \($s.minimum)" else empty end),
          (if ($x | type) == "object" then
             (($s.required // [])[] as $k | select($x | has($k) | not) | "\($p).\($k): is required"),
             (if $s.additionalProperties == false then
                ($x | keys[]) as $k | select(($s.properties // {}) | has($k) | not) | "\($p).\($k): is not allowed"
              else empty end),
             (($s.properties // {}) | to_entries[] | select(.key as $k | $x | has($k))
               | .key as $k | .value as $ps | $x[$k] | errs($ps; $root; "\($p).\($k)"))
           else empty end)
        end;
    errs($schema[0]; $schema[0]; "$")' "$DEPLOY_JSON_FILE"
}

if [ -z "$DEPLOY_JSON_FILE" ]; then
  report fail 1 "deploy.json" "none found: copy deploy/deploy.example.json to deploy/deploy.json, or set DEPLOY_JSON"
  for n in 2 3 4 5 6 7; do report skip "$n" "check" "needs deploy.json"; done
  exit 1
fi

if ! jq empty "$DEPLOY_JSON_FILE" 2>/dev/null; then
  report fail 1 "deploy.json" "$DEPLOY_JSON_FILE is not valid JSON"
else
  problems=()
  while IFS= read -r line; do [ -n "$line" ] && problems+=("$line"); done < <(schema_errors)
  f_region="$(jq -r '.gcp.region // ""' "$DEPLOY_JSON_FILE")"
  f_zone="$(jq -r '.gcp.zone // ""' "$DEPLOY_JSON_FILE")"
  case "$f_zone" in "$f_region"-*) ;; *) problems+=("gcp.zone ($f_zone) is not in gcp.region ($f_region)") ;; esac
  f_chain="$(jq -r '.chain.chainId // ""' "$DEPLOY_JSON_FILE")"
  c_chain="$(jq -r '.chain.chainId' "$CONSTANTS")"
  [ "$f_chain" = "$c_chain" ] || problems+=("chain.chainId ($f_chain) is not chain.chainId in spec/constants.json ($c_chain)")
  [ "$(jq -r '.ingress.kind // ""' "$DEPLOY_JSON_FILE")" != gcp-lb ] \
    || problems+=("ingress.kind \"gcp-lb\" is not implemented, use \"cloudflare\"")
  if [ ${#problems[@]} = 0 ]; then
    report ok 1 "deploy.json" "$DEPLOY_JSON_FILE matches the schema, zone $f_zone is in $f_region"
  else
    report fail 1 "deploy.json" "$(IFS=';'; printf '%s' "${problems[*]}" | sed 's/;/; /g')"
  fi
fi

# --- 2. The image is public: an anonymous pull of its manifest works --------
image_check() {
  local repo="${IMAGE_REPO:-}" name token code digest="${IMAGE_DIGEST:-}" json ref
  [[ "$repo" =~ ^ghcr\.io/([a-z0-9-]+/[a-z0-9._-]+)$ ]] || { report fail 2 "image" "image.repo ($repo) is not ghcr.io/<owner>/<name>"; return; }
  name="${BASH_REMATCH[1]}"
  if [ -z "$digest" ] && [ -n "$exam" ]; then
    if ! command -v cast >/dev/null; then
      report fail 2 "image" "cast is needed to read exam $exam's image digest"; return
    fi
    json="$(cast call --json --rpc-url "${RPC_URL:-}" "${REGISTRY:-}" \
      'getExam(bytes32)((bytes20,bytes32,uint64,uint64,(bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,string)))' \
      "$exam" 2>&1)" || { report fail 2 "image" "getExam($exam) failed: $json"; return; }
    [ "$(jq -r '.[0][2]' <<<"$json")" != 0 ] || { report fail 2 "image" "exam $exam is not on-chain at ${REGISTRY:-}"; return; }
    digest="sha256:$(jq -r '.[0][1]' <<<"$json" | sed 's/^0x//')"
  fi
  token="$("${CURL[@]}" "https://ghcr.io/token?scope=repository:$name:pull" | jq -r '.token // empty' 2>/dev/null)"
  [ -n "$token" ] || { report fail 2 "image" "ghcr.io refused an anonymous pull token for $name: the package is private or missing"; return; }
  if [ -n "$digest" ]; then
    ref="$digest"
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -I -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
      "https://ghcr.io/v2/$name/manifests/$ref")"
  else
    ref="tags/list"
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "https://ghcr.io/v2/$name/tags/list")"
  fi
  if [ "$code" = 200 ]; then
    if [ -n "$digest" ]; then report ok 2 "image" "anonymous pull of $repo@$digest works"
    else report ok 2 "image" "$repo is public (no digest given: pass --exam to pull that exam's manifest)"; fi
  else
    report fail 2 "image" "anonymous request for $repo $ref answered HTTP $code"
  fi
}
image_check

# --- 3. The bucket answers a public read, and CORS allows the web hosts -----
bucket_check() {
  local code origin allow bad=()
  [ -n "${BUCKET:-}" ] || BUCKET="${PROJECT_ID:-}-paperseal-exams"
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://storage.googleapis.com/storage/v1/b/$BUCKET/o?maxResults=1&fields=items(name)")"
  [ "$code" = 200 ] || { report fail 3 "bucket" "anonymous list of gs://$BUCKET answered HTTP $code (want 200: allUsers needs storage.objectViewer)"; return; }
  for h in "${APP_HOST:-}" "${VERIFIER_HOST:-}"; do
    [ -n "$h" ] || { bad+=("a web host is unset"); continue; }
    origin="https://$h"
    allow="$("${CURL[@]}" -o /dev/null -D - -X OPTIONS -H "Origin: $origin" -H 'Access-Control-Request-Method: GET' \
      "https://storage.googleapis.com/$BUCKET/paperseal-doctor-cors-probe" \
      | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
    [ "$allow" = "*" ] || [ "$allow" = "$origin" ] || bad+=("CORS does not allow GET from $origin")
  done
  if [ ${#bad[@]} = 0 ]; then
    report ok 3 "bucket" "gs://$BUCKET is publicly readable, CORS allows https://${APP_HOST} and https://${VERIFIER_HOST}"
  else
    report fail 3 "bucket" "gs://$BUCKET: $(IFS=';'; printf '%s' "${bad[*]}" | sed 's/;/; /g')"
  fi
}
bucket_check

# --- 4. ingress.teeHost resolves in DNS ------------------------------------
resolve() {
  if command -v dig >/dev/null; then
    dig +short +time=5 +tries=1 "$1" A "$1" AAAA 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$'
  else
    host "$1" 2>/dev/null | awk '/has (IPv6 )?address/{print $NF}'
  fi
}
if [ -z "${TEE_HOST:-}" ]; then
  report fail 4 "DNS" "ingress.teeHost is unset"
elif addrs="$(resolve "$TEE_HOST" | sort -u | tr '\n' ' ')" && [ -n "$addrs" ]; then
  report ok 4 "DNS" "$TEE_HOST resolves to ${addrs% }"
else
  report fail 4 "DNS" "$TEE_HOST does not resolve"
fi

# --- 5. rpcUrl and https://<rpcHost>/ answer eth_chainId with chainId -------
chain_id_of() { # prints the decimal chain ID, or an error on stderr
  local out hex
  out="$("${CURL[@]}" -f -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" 2>&1)" || { echo "$out" >&2; return 1; }
  hex="$(jq -r '.result // empty' <<<"$out" 2>/dev/null)"
  [[ "$hex" =~ ^0x[0-9a-fA-F]+$ ]] || { echo "no eth_chainId result: $(head -c 200 <<<"$out")" >&2; return 1; }
  printf '%d' "$hex"
}
rpc_bad=()
for url in "${RPC_URL:-}" "https://${RPC_HOST:-}/"; do
  if [ "$url" = "" ] || [ "$url" = "https:///" ]; then rpc_bad+=("an RPC value is unset"); continue; fi
  if got="$(chain_id_of "$url" 2>"${TMPDIR:-/tmp}/doctor-rpc.$$")"; then
    [ "$got" = "${CHAIN_ID:-}" ] || rpc_bad+=("$url is on chain $got, not ${CHAIN_ID:-}")
  else
    rpc_bad+=("$url: $(head -c 200 "${TMPDIR:-/tmp}/doctor-rpc.$$" | tr '\n' ' ')")
  fi
done
rm -f "${TMPDIR:-/tmp}/doctor-rpc.$$"
if [ ${#rpc_bad[@]} = 0 ]; then
  report ok 5 "RPC" "$RPC_URL and https://$RPC_HOST/ both answer chain ${CHAIN_ID}"
else
  report fail 5 "RPC" "$(IFS=';'; printf '%s' "${rpc_bad[*]}" | sed 's/;/; /g')"
fi

# --- 6. chain.registry has code ---------------------------------------------
if ! command -v cast >/dev/null; then
  report fail 6 "registry" "cast (Foundry) is not installed"
elif [ -z "${REGISTRY:-}" ] || [ -z "${RPC_URL:-}" ]; then
  report fail 6 "registry" "chain.registry or chain.rpcUrl is unset"
elif code="$(cast code --rpc-url "$RPC_URL" "$REGISTRY" 2>&1)"; then
  if [ "$code" = 0x ] || [ -z "$code" ]; then
    report fail 6 "registry" "$REGISTRY has no code on chain ${CHAIN_ID:-}"
  else
    report ok 6 "registry" "$REGISTRY has $(( (${#code} - 2) / 2 )) bytes of code (for the pinned code hash, run e2e/live/cli.mjs registry-check)"
  fi
else
  report fail 6 "registry" "could not read code: $(head -c 200 <<<"$code")"
fi

# --- 7. A running TEE answers /v1/status, and its token decodes -------------
b64url_json() { # decodes one base64url JWT segment and checks it is a JSON object
  local s="${1//-/+}"; s="${s//_//}"
  case $(( ${#s} % 4 )) in 2) s+="==" ;; 3) s+="=" ;; esac
  printf '%s' "$s" | base64 --decode 2>/dev/null | jq -ce 'select(type == "object")' 2>/dev/null
}
tee_check() {
  local status att token header payload stage
  [ -n "${TEE_HOST:-}" ] || { report skip 7 "TEE" "ingress.teeHost is unset"; return; }
  if ! status="$("${CURL[@]}" -f "https://$TEE_HOST/v1/status" 2>&1)"; then
    report skip 7 "TEE" "no TEE answers at https://$TEE_HOST/v1/status ($(head -c 120 <<<"$status" | tr '\n' ' '))"; return
  fi
  stage="$(jq -er '.stage | strings' <<<"$status" 2>/dev/null)" \
    || { report fail 7 "TEE" "https://$TEE_HOST/v1/status answered without a stage: $(head -c 120 <<<"$status")"; return; }
  att="$("${CURL[@]}" -f "https://$TEE_HOST/v1/attestation" 2>&1)" \
    || { report fail 7 "TEE" "stage $stage, but /v1/attestation failed: $(head -c 120 <<<"$att")"; return; }
  token="$(jq -er '.token | strings' <<<"$att" 2>/dev/null)" \
    || { report fail 7 "TEE" "stage $stage, but /v1/attestation has no token"; return; }
  IFS=. read -r header payload _ <<<"$token"
  if ! header="$(b64url_json "$header")" || ! payload="$(b64url_json "$payload")"; then
    report fail 7 "TEE" "stage $stage, but the attestation token does not decode as a JWT"; return
  fi
  report ok 7 "TEE" "stage $stage, exam $(jq -r '.examId // "not reported"' <<<"$status"), token $(jq -r '.alg // "?"' <<<"$header") from $(jq -r '.iss // "?"' <<<"$payload") decodes (not verified here: the apps verify it)"
}
tee_check

echo "warn passkeys are bound to web.appHost (${APP_HOST:-unset}). Changing it after anyone enrols locks out every passkey."
exit "$failed"
