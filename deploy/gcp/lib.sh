# Shared helpers. Sourced by the other scripts, not run directly.
# Never put a secret in these files. Nothing here needs one: gcloud uses your
# own login (`gcloud auth login`).

: "${DRY_RUN:=0}"

die() { echo "error: $*" >&2; exit 1; }

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
