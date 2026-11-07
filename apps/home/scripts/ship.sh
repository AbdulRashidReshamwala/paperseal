#!/usr/bin/env bash
# Builds the homepage and deploys it to the paperseal-home Pages project, and nothing else.
# Run it after recording a new video: pnpm --filter @paperseal/home run ship
set -euo pipefail

project=paperseal-home
cd "$(dirname "$0")/.."

node scripts/build.mjs

if ! wrangler pages project list </dev/null | grep -q "$project"; then
  wrangler pages project create "$project" --production-branch main </dev/null
fi

wrangler pages deploy dist \
  --project-name "$project" \
  --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-dirty=true </dev/null
