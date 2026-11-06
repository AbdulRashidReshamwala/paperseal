#!/usr/bin/env bash
# Verify ExamRegistry on Sepolia Etherscan (V2 API, chain id 11155111).
# Usage: script/verify.sh [registry-address]   (defaults to REGISTRY_ADDRESS in contracts/.env)
# Run from a checkout of the commit that was deployed. The key is read from the
# environment (ETHERSCAN_API_KEY) and is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi

ADDRESS="${1:-${REGISTRY_ADDRESS:-}}"
: "${ADDRESS:?pass the registry address or set REGISTRY_ADDRESS in contracts/.env}"
: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY in contracts/.env}"
: "${BOARD_ADDRESS:?set BOARD_ADDRESS in contracts/.env (the constructor argument)}"
CHAIN_ID="${CHAIN_ID:-11155111}"

# Constructor argument: the board address. Settings below mirror foundry.toml.
ARGS="$(cast abi-encode 'constructor(address)' "$BOARD_ADDRESS")"

# --guess-constructor-args is not used; the board address is known.
forge verify-contract "$ADDRESS" src/ExamRegistry.sol:ExamRegistry \
  --chain "$CHAIN_ID" --verifier etherscan \
  --compiler-version 0.8.30 --num-of-optimizations 200 --evm-version prague \
  --constructor-args "$ARGS" --watch 2>&1 | sed "s/${ETHERSCAN_API_KEY}/<redacted>/g"
