# Shared helpers. Sourced by the other scripts, not run directly.
# Never put a secret in these files. Nothing here needs one: gcloud uses your
# own login (`gcloud auth login`).

: "${DRY_RUN:=0}"

die() { echo "error: $*" >&2; exit 1; }

# deploy.json, when there is one, fills in any variable not already set.
. "$(dirname "${BASH_SOURCE[0]}")/../config.sh"

need_env() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || die "set $v (export PROJECT_ID=... REGION=... ZONE=...)"
  done
}

# Names. Override by exporting them before running a script.
: "${SA_NAME:=paperseal-tee}"
: "${VM_NAME:=paperseal-tee}"
: "${ADDRESS_NAME:=paperseal-tee-ip}"
: "${FIREWALL_NAME:=paperseal-tee-cloudflare-8080}"
: "${NETWORK_TAG:=paperseal-tee}"
: "${NETWORK:=default}"
: "${MACHINE_TYPE:=n2d-standard-2}"

# origin_owner prints the GitHub owner of this checkout's origin remote,
# lowercased, from git@github.com:Owner/repo.git or https://github.com/Owner/repo.
# It reads local git config only and fails if origin is not on GitHub.
origin_owner() {
  local url owner
  url="$(git -C "$(dirname "${BASH_SOURCE[0]}")" remote get-url origin 2>/dev/null)" || return 1
  case "$url" in
    git@github.com:*) url="${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="${url#ssh://git@github.com/}" ;;
    https://github.com/*|https://*@github.com/*) url="${url#*github.com/}" ;;
    *) return 1 ;;
  esac
  owner="$(printf '%s' "${url%%/*}" | tr '[:upper:]' '[:lower:]')"
  case "$owner" in ''|*[!a-z0-9-]*) return 1 ;; esac
  printf '%s' "$owner"
}

# The image a fork's repro.yml publishes: ghcr.io/<origin owner>/paperseal-tee,
# or upstream's if origin can't be read.
: "${IMAGE_REPO:=ghcr.io/$(origin_owner || echo abdulrashidreshamwala)/paperseal-tee}"

init_common() {
  need_env PROJECT_ID REGION ZONE
  case "$ZONE" in "$REGION"-*) ;; *) die "ZONE ($ZONE) is not in REGION ($REGION)" ;; esac
  case "$INGRESS_KIND" in
    cloudflare) ;;
    gcp-lb) die "ingress.kind \"gcp-lb\" is not implemented (spec/deploy.md). Use \"cloudflare\"." ;;
    *) die "unknown ingress kind: $INGRESS_KIND" ;;
  esac
  : "${BUCKET:=${PROJECT_ID}-paperseal-exams}"
  SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY RUN: commands are printed, none are run, and existence checks assume nothing exists." >&2
  else
    command -v gcloud >/dev/null || die "gcloud is not installed"
  fi
}

# run prints the command in dry-run mode and runs it otherwise.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# exists runs a read-only describe. In dry-run it reports "absent" without
# calling gcloud, so a dry run needs no login and touches nothing.
exists() {
  [ "$DRY_RUN" = 1 ] && return 1
  "$@" >/dev/null 2>&1
}

# stage_guard <force> refuses, unless force is 1, to go on while the TEE at
# https://$TEE_HOST holds an exam: from the first registration until the exam
# is released. Stopping it then destroys the in-memory question bank and keys
# (spec/deploy.md, "One Command per Exam"). Stages are those of spec/api.md,
# "TEE API". If the status can't be read, it refuses too, and says why.
stage_guard() {
  local force="$1" status stage regs n why=""
  command -v jq >/dev/null || die "jq is needed to read the TEE's status"
  if [ -z "${TEE_HOST:-}" ]; then
    why="the TEE host is unknown: set TEE_HOST or ingress.teeHost in deploy.json"
  elif ! status="$(curl -fsS --max-time 15 "https://$TEE_HOST/v1/status" 2>&1)"; then
    why="could not read https://$TEE_HOST/v1/status: $status"
  elif ! stage="$(jq -er '.stage | strings' <<<"$status" 2>/dev/null)"; then
    why="https://$TEE_HOST/v1/status did not return a stage"
  else
    case "$stage" in
      released|failed)
        echo "TEE at $TEE_HOST is in stage $stage, safe to stop."; return 0 ;;
      onboard)
        # Safe only before anyone registered and before any list exists.
        if jq -e '.approvedList' <<<"$status" >/dev/null 2>&1; then
          why="stage onboard with an approved list"
        elif ! regs="$(curl -fsS --max-time 15 "https://$TEE_HOST/v1/registrations" 2>&1)" \
          || ! n="$(jq -er '.registrations | length' <<<"$regs" 2>/dev/null)"; then
          why="stage onboard, and https://$TEE_HOST/v1/registrations could not be read"
        elif [ "$n" = 0 ]; then
          echo "TEE at $TEE_HOST is in stage onboard with no registrations, safe to stop."; return 0
        else
          why="stage onboard with $n registration(s)"
        fi ;;
      submit|lock|build|distribute|unlock)
        why="stage $stage: the exam is under way" ;;
      *)
        why="unknown stage \"$stage\"" ;;
    esac
    why="TEE at $TEE_HOST: $why"
  fi
  if [ "$force" = 1 ]; then
    echo "warning: $why. Going on because of --force." >&2
    return 0
  fi
  die "$why. Stopping the TEE mid-exam destroys the exam, its question bank and keys. Pass --force to stop it anyway."
}
