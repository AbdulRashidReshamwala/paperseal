#!/usr/bin/env bash
# Creates the public-read bucket for exam files: uniform bucket-level access,
# allUsers can read objects, CORS allows GET from any origin. Safe to run again.
# Everything in it is public by design: the files are encrypted and hashed.
# Usage: PROJECT_ID=... REGION=... ZONE=... [BUCKET=...] [DRY_RUN=1] ./create-bucket.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

if exists gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID"; then
  echo "bucket gs://$BUCKET exists"
else
  run gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT_ID" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention=inherited
fi

# If an organization policy enforces public access prevention, this fails and
# you must allow public buckets for this project first.
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member=allUsers --role=roles/storage.objectViewer

cors="$(mktemp)"
trap 'rm -f "$cors"' EXIT
cat > "$cors" <<'JSON'
[{"origin": ["*"], "method": ["GET"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600}]
JSON
if [ "$DRY_RUN" = 1 ]; then echo "CORS file would hold: $(cat "$cors")"; fi
run gcloud storage buckets update "gs://$BUCKET" --cors-file="$cors"
echo "bucket: gs://$BUCKET (public base URL https://storage.googleapis.com/$BUCKET)"
