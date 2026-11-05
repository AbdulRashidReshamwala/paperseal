#!/usr/bin/env bash
# Stops the TEE VM. Stopping ends the instance: its in-memory question bank and
# keys are gone, and the VM is billed only for its disk and the static IP.
# Usage: PROJECT_ID=... REGION=... ZONE=... [DRY_RUN=1] ./stop-tee.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common
if [ "$DRY_RUN" != 1 ] && ! exists gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"; then
  echo "VM $VM_NAME does not exist, nothing to stop"; exit 0
fi
run gcloud compute instances stop "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
