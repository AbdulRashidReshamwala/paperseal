#!/usr/bin/env bash
# Installs or updates the Arkiv relay on a Debian VM, next to the Bee node it
# backs up through. Run it from the repository root on the machine that holds
# the board keystore. It copies the keystore and its password file to the VM
# and never prints or reads them.
#
# Usage: VM=paperseal-swarm PROJECT_ID=... ZONE=... [ACCOUNT=...] [REF=main] \
#          [KEYSTORE=~/.foundry/keystores/paperseal-board] \
#          [PASSWORD_FILE=~/.paperseal/board-keystore-password] deploy/relay/install.sh
# Re-running it pulls REF again and restarts the index. It keeps /etc/paperseal-relay.env.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
: "${VM:=paperseal-swarm}"
: "${REF:=main}"
: "${KEYSTORE:=$HOME/.foundry/keystores/paperseal-board}"
: "${PASSWORD_FILE:=$HOME/.paperseal/board-keystore-password}"
[ -n "${PROJECT_ID:-}" ] || die "set PROJECT_ID"
[ -n "${ZONE:-}" ] || die "set ZONE"
[ -f "$KEYSTORE" ] || die "no keystore at $KEYSTORE"
[ -f "$PASSWORD_FILE" ] || die "no password file at $PASSWORD_FILE"

here=$(dirname "${BASH_SOURCE[0]}")
gc=(--project="$PROJECT_ID" --zone="$ZONE" --quiet)
[ -n "${ACCOUNT:-}" ] && gc+=(--account="$ACCOUNT")
upload=/tmp/paperseal-relay-upload

gcloud compute ssh "$VM" "${gc[@]}" --command="rm -rf $upload && mkdir -m 700 $upload"
gcloud compute scp "${gc[@]}" "$here/remote-setup.sh" "$here/relay.env" "$here"/paperseal-relay-*.service "$VM:$upload/"
gcloud compute scp "${gc[@]}" "$KEYSTORE" "$VM:$upload/paperseal-board"
gcloud compute scp "${gc[@]}" "$PASSWORD_FILE" "$VM:$upload/board-keystore-password"
gcloud compute ssh "$VM" "${gc[@]}" --command="sudo UPLOAD=$upload REF=$REF bash $upload/remote-setup.sh && sudo rm -rf $upload"
