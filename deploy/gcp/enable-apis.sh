#!/usr/bin/env bash
# Enables the APIs Paper Seal needs. Safe to run again.
# Usage: PROJECT_ID=... REGION=... ZONE=... [DRY_RUN=1] ./enable-apis.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
init_common

# artifactregistry is not needed: the image is public on ghcr.io.
# storage and logging are on by default in new projects, listed so the
# bucket and the TEE's logs work in a bare one.
run gcloud services enable \
  compute.googleapis.com \
  confidentialcomputing.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  storage.googleapis.com \
  logging.googleapis.com \
  --project="$PROJECT_ID"
