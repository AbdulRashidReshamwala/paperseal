.PHONY: all build test abi contracts-build contracts-test tee-build tee-test web-build web-test

all: build test

build: contracts-build tee-build web-build
test: contracts-test tee-test web-test

contracts-build:
	cd contracts && forge build
contracts-test:
	cd contracts && forge test

tee-build:
	cd tee && go build ./...
tee-test:
	cd tee && go test ./...

web-build:
	pnpm build
web-test:
	pnpm test

abi: contracts-build
	node packages/chain/scripts/sync-abi.mjs
