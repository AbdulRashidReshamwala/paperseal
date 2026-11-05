#!/usr/bin/env bash
# Builds the TEE image reproducibly and prints its digest. Rebuilding the same
# commit gives the same digest. Writes nothing outside a temporary directory,
# apart from the BuildKit builder it creates once.
set -euo pipefail

# BuildKit is part of the toolchain, so it is pinned too.
buildkit_image="moby/buildkit:v0.34.2@sha256:97719ccb2ac86fb44fd36f330a6d302f63dddd5326f3ada24f9c05ccac0d9098"
builder="paperseal-repro"

tee_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "build-image: the Docker daemon is not running" >&2
  exit 1
fi

SOURCE_DATE_EPOCH="$(git -C "$tee_dir" log -1 --format=%ct)"
export SOURCE_DATE_EPOCH

if [ -n "$(git -C "$tee_dir" status --porcelain -- .)" ]; then
  echo "build-image: warning: tee/ has uncommitted changes, so this digest won't match any commit" >&2
fi

if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container \
    --driver-opt "image=$buildkit_image" >/dev/null
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

docker buildx build \
  --builder "$builder" \
  --no-cache \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --build-arg SOURCE_DATE_EPOCH \
  --metadata-file "$out/metadata.json" \
  --output "type=oci,dest=$out/image.tar,rewrite-timestamp=true" \
  "$tee_dir" >&2

digest="$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$out/metadata.json")"
if [ -z "$digest" ]; then
  echo "build-image: no digest in the build metadata" >&2
  exit 1
fi
echo "$digest"
