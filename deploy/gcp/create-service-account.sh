#!/usr/bin/env bash
# Creates the TEE's dedicated service account with only:
#   roles/confidentialcomputing.workloadUser (project)
#   roles/logging.logWriter                  (project)
#   roles/storage.objectCreator              (the bucket only)
# Run create-bucket.sh first. Safe to run again.
# Usage: PROJECT_ID=... REGION=... ZONE=... [DRY_RUN=1] ./create-service-account.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

if exists gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID"; then
  echo "service account $SA_EMAIL exists"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Paper Seal TEE" --project="$PROJECT_ID"
fi

# add-iam-policy-binding is idempotent.
for role in roles/confidentialcomputing.workloadUser roles/logging.logWriter; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" --role="$role" \
    --condition=None --quiet
done

run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA_EMAIL" --role=roles/storage.objectCreator
echo "service account: $SA_EMAIL"
