#!/usr/bin/env bash
# Stops the TEE VM. Stopping ends the instance: its in-memory question bank and
# keys are gone, and the VM is billed only for its disk and the static IP.
#
# It reads https://$TEE_HOST/v1/status first and refuses while an exam is under
# way (from the first registration until released), or when the status can't
# be read, unless given --force. TEE_HOST comes from ingress.teeHost.
# Usage: PROJECT_ID=... REGION=... ZONE=... [TEE_HOST=...] [DRY_RUN=1] ./stop-tee.sh [--force]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

force=0
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    *) die "unknown argument: $a" ;;
  esac
done
init_common

if [ "$DRY_RUN" != 1 ] && ! exists gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"; then
  echo "VM $VM_NAME does not exist, nothing to stop"; exit 0
fi
stage_guard "$force"
run gcloud compute instances stop "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
