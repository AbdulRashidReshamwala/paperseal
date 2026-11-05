#!/usr/bin/env bash
# Removes everything these scripts created: the VM, firewall rule, static IP,
# bucket WITH ALL ITS OBJECTS, and the service account with its role bindings.
# It prints the list first and needs you to type the project ID to continue.
# APIs stay enabled.
# Usage: PROJECT_ID=... REGION=... ZONE=... [BUCKET=...] [DRY_RUN=1] ./teardown.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

cat <<LIST
This will delete, in project $PROJECT_ID:
  - VM                $VM_NAME (zone $ZONE)
  - firewall rule     $FIREWALL_NAME
  - static IP         $ADDRESS_NAME (region $REGION)
  - bucket            gs://$BUCKET and every object in it
  - service account   $SA_EMAIL and its role bindings
LIST

if [ "$DRY_RUN" != 1 ]; then
  [ -t 0 ] || die "needs an interactive terminal to confirm"
  read -r -p "Type the project ID ($PROJECT_ID) to confirm: " answer
  [ "$answer" = "$PROJECT_ID" ] || die "not confirmed, nothing deleted"
fi

del() { # del <describe cmd...> -- <delete cmd...>
  local d=() x=()
  while [ "$1" != "--" ]; do d+=("$1"); shift; done; shift; x=("$@")
  if [ "$DRY_RUN" = 1 ] || "${d[@]}" >/dev/null 2>&1; then run "${x[@]}"; else echo "already gone: ${x[*]:0:5}"; fi
}

del gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" -- \
  gcloud compute instances delete "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --quiet
del gcloud compute firewall-rules describe "$FIREWALL_NAME" --project="$PROJECT_ID" -- \
  gcloud compute firewall-rules delete "$FIREWALL_NAME" --project="$PROJECT_ID" --quiet
del gcloud compute addresses describe "$ADDRESS_NAME" --region="$REGION" --project="$PROJECT_ID" -- \
  gcloud compute addresses delete "$ADDRESS_NAME" --region="$REGION" --project="$PROJECT_ID" --quiet
del gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" -- \
  gcloud storage rm --recursive "gs://$BUCKET" --project="$PROJECT_ID"
for role in roles/confidentialcomputing.workloadUser roles/logging.logWriter; do
  del gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" -- \
    gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_EMAIL" --role="$role" --condition=None --quiet
done
del gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" -- \
  gcloud iam service-accounts delete "$SA_EMAIL" --project="$PROJECT_ID" --quiet
