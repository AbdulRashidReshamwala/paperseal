# Paper Seal TEE

The Go workload that runs on Google Confidential Space. See the [root README](../README.md) for what it does and why.

> **Status:** scaffold. The byte-level foundations are real. Everything else returns a not-implemented error, and every HTTP route returns 501.

## Layout

| Path | What it is | State |
| --- | --- | --- |
| `cmd/tee` | Parses the exam settings and starts the HTTP server | Real |
| `internal/spec` | Embedded copy of `spec/constants.json`, with a test that fails on drift | Real |
| `internal/settings` | Strict parsing of the attested arguments, with the `createExam` checks | Real |
| `internal/hashing` | Domain-tagged hash encoding for every message | Real |
| `internal/criteria` | Encode and strict decode of the selection criteria | Real |
| `internal/approvedlist` | Encode and strict decode of the approved list `entries` | Real, except `CheckRegistered`, which checks entries against registrations |
| `internal/chainread` | The criteria and approved list reads over TLS from `rpcHost` at the finalized block | Not implemented |
| `internal/split` | XOR split of `K`, Shamir 8 of 10 for `K_priv` | Real |
| `internal/attestation` | `eat_nonce` | Nonce real. Tokens and the instance key not implemented |
| `internal/api` | Routes and the error shape | Routes and errors real. Every lifecycle call returns 501 |
| `internal/bank`, `lock`, `build`, `timelock`, `release`, `outbox`, `storage` | Interfaces and types for each stage | Not implemented |
| `internal/notimpl` | The typed not-implemented error | Real |
| `internal/vectors` | Builds `testdata/vectors.json` | Real |

The TEE has no wallet and writes nothing to the chain. Its only chain reads are the criteria and the approved list in `chainread`. The Build is the only TEE message that goes on-chain: it waits in `outbox`, and the board posts it. Lock posts nothing.

## Run

```sh
go build ./... && go vet ./... && go test ./...
```

The server listens on port 8080 and takes every setting as an argument:

```sh
go run ./cmd/tee \
  --exam-id=0x<32 bytes> \
  --exam-start=<Unix seconds> \
  --delta=<seconds> \
  --lock-round=<decimal> \
  --unlock-round=<decimal> \
  --end-round=<decimal> \
  --criteria-hash=0x<32 bytes> \
  --rpc-host=<hostname> \
  --registry=0x<20 bytes> \
  --chain-id=<decimal>
```

Parsing is strict because the attestation token exposes these arguments: all ten are required, as one `--name=value` each, in exactly this order, in lowercase hex or canonical decimal. `--rpc-host` is a lowercase hostname with no scheme, port or path. `--chain-id` must equal `chain.chainId` in `spec/constants.json`. Parsing applies the same checks as `ExamRegistry.createExam`, including the exact `unlockRound` formula and the `endRound` rule in `spec/api.md`.

## Test Vectors

`testdata/vectors.json` holds fixed inputs and expected bytes for the hash encoding, the selection criteria, the approved list and the attestation nonce, for other languages to check against. There is one vector per message. The `criteria` sample is valid. The `approvedList` sample has one entry per role to pin the encoding, and the TEE rejects it for its key-holder counts. A test fails if the Go output drifts from the file. After a deliberate format change, change `spec/` first, then run:

```sh
go test ./internal/vectors -update
```

## Constants

`internal/spec/constants.json` is a copy, so the image builds from `tee/` alone. After `spec/constants.json` changes, run:

```sh
go generate ./internal/spec
```

## Reproducible Image

```sh
scripts/build-image.sh
```

The script builds for `linux/amd64` with a pinned BuildKit, sets `SOURCE_DATE_EPOCH` from the commit time, rewrites timestamps, leaves out provenance and SBOM attestations, and prints the digest. The Go and distroless base images are pinned to their `linux/amd64` digests. Build from a clean checkout of the tagged commit, because that is what anyone comparing digests will do.

`ExamRegistry` stores the digest as `bytes32`, without the `sha256:` prefix.

## Libraries

| Library | Version | Why | State |
| --- | --- | --- | --- |
| `github.com/hashicorp/vault/shamir` | vault v1.14.0 | Shamir over GF(256), widely used and reviewed | In `go.mod` |
| `github.com/ethereum/go-ethereum/accounts/abi` | v1.17.5 | Solidity ABI encoding for every hashed message and the approved list | In `go.mod` |
| `github.com/cloudflare/circl/hpke` | v1.6.4 | HPKE with the DHKEM(P-256) suite, because Go 1.24 has no `crypto/hpke` | Planned |
| `github.com/drand/tlock` | v1.2.0 | drand timelock, the same scheme the web apps decrypt | Planned |
| `github.com/drand/go-clients` | v0.2.3 | Reads and verifies drand rounds | Planned |

Dependencies join `go.mod` only when code imports them.

- Each planned version is the newest that supports Go 1.24.6. circl v1.6.5 needs Go 1.25 and go-clients v0.3.0 needs Go 1.26.
- go-ethereum v1.17.5 is the newest release that supports Go 1.24.6. From v1.17.6 it needs Go 1.25.
- Shamir is pinned to vault v1.14.0 because the whole module is MPL-2.0 at that tag. Later tags put the module under BUSL, with the same `shamir.go` under MPL-2.0. The file is byte-identical through v1.20.4.
- `shamir.Combine` has no threshold of its own and returns wrong bytes for too few or tampered shares. `split.CombineShares` enforces the threshold, and callers must check each share's hash first.
