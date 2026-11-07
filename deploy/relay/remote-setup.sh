#!/usr/bin/env bash
# Runs on the VM as root, from install.sh. Installs Node, pnpm, cast and the
# repository, a `relay` user that holds the board keystore, and the relay's
# systemd units, then starts the exam index.
#
# The keystore and its password file arrive in $UPLOAD and are moved into the
# relay user's home with mode 600. This script never prints or reads them.
set -euo pipefail

UPLOAD=${UPLOAD:?}
REF=${REF:-main}
NODE_MAJOR=22
FOUNDRY_VERSION=v1.9.0
REPO_URL=https://github.com/AbdulRashidReshamwala/paperseal.git
APP=/opt/paperseal
HOME_DIR=/var/lib/paperseal-relay

apt-get update -qq
apt-get install -y -qq git xz-utils ca-certificates curl >/dev/null

# Node: the newest $NODE_MAJOR release, checked against nodejs.org's SHASUMS256.
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $2}')
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /opt/node/bin/corepack /usr/local/bin/
  rm -rf "$tmp"
fi
corepack enable --install-directory /usr/local/bin pnpm

# cast, pinned to the version the board keystore was made with. Only cast is kept.
if ! cast --version 2>/dev/null | grep -q "${FOUNDRY_VERSION#v}"; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/foundry.tar.gz" "https://github.com/foundry-rs/foundry/releases/download/$FOUNDRY_VERSION/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
  tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast
  install -m 755 "$tmp/cast" /usr/local/bin/cast
  rm -rf "$tmp"
fi

id relay >/dev/null 2>&1 || useradd --system --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin relay
install -d -o relay -g relay -m 700 "$HOME_DIR/.foundry" "$HOME_DIR/.foundry/keystores" "$HOME_DIR/.paperseal"
if [ -f "$UPLOAD/paperseal-board" ]; then
  install -o relay -g relay -m 600 "$UPLOAD/paperseal-board" "$HOME_DIR/.foundry/keystores/paperseal-board"
  install -o relay -g relay -m 600 "$UPLOAD/board-keystore-password" "$HOME_DIR/.paperseal/board-keystore-password"
  shred -u "$UPLOAD/paperseal-board" "$UPLOAD/board-keystore-password"
fi

# The repository, as the relay user, so Vite's cache under node_modules is writable.
install -d -o relay -g relay "$APP"
if [ ! -d "$APP/.git" ]; then
  sudo -u relay git clone --quiet "$REPO_URL" "$APP"
fi
sudo -u relay git -C "$APP" fetch --quiet origin
sudo -u relay git -C "$APP" checkout --quiet --detach "origin/$REF"
sudo -u relay -H bash -c "cd $APP && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --filter '@paperseal/relay...' >/dev/null"

[ -f /etc/paperseal-relay.env ] || install -m 644 "$UPLOAD/relay.env" /etc/paperseal-relay.env
install -m 644 "$UPLOAD"/paperseal-relay-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now paperseal-relay-index.service
systemctl restart paperseal-relay-index.service

sudo -u relay -H bash -c "cd $APP && node relay/cli.mjs dry-check" | tail -n 3
echo "relay writer: $(sudo -u relay -H cast wallet address --account paperseal-board --password-file $HOME_DIR/.paperseal/board-keystore-password)"
