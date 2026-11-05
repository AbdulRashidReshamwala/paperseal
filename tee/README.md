# Paper Seal TEE

The Go workload that runs on Google Confidential Space. See the [root README](../README.md) for what it does and why.

> **Status:** the lifecycle is implemented end to end. The one thing that returns a not-implemented error is the hardware attestation chain check, which only runs if `webauthn.requireHardwareAttestation` is `true` (it is `false` in the demo). Outside Confidential Space the instance is unattested and cannot commit a Build.

## Layout

| Path | What it is |
| --- | --- |
| `cmd/tee` | Parses the exam settings, wires the real collaborators, runs the lifecycle and serves HTTP |
| `internal/spec` | Embedded copy of `spec/constants.json`, with a test that fails on drift |
| `internal/settings` | Strict parsing of the attested arguments, with the `createExam` checks, and `Args()` for the exact list |
| `internal/hashing` | Domain-tagged hash encoding for every message |
| `internal/encryption` | HPKE (circl, RFC 9180), AES-256-GCM and padding |
| `internal/attestation` | `eat_nonce`, the two instance keys, the launcher token client and published-token verification |
| `internal/timelock` | drand timelock sealing (tlock) and a Beacon that verifies every round against `drand.publicKey` |
| `internal/chainread` | JSON-RPC over TLS to `rpcHost` at `chain.readBlock`: `getExam`, `getApprovedList`, `getBuild` and their logs |
| `internal/webauthn` | Passkey signature check, and the attestation policy |
| `internal/challenge`, `registration` | Single-use challenges and verified registrations |
| `internal/approvedlist`, `criteria` | Strict encode and decode, and `CheckRegistered` |
| `internal/bank`, `lock`, `build` | Question parsing and the in-memory bank, the criteria checks, and seeded selection and paper assembly |
| `internal/split` | XOR split of `K`, Shamir 8 of 10 for `K_priv` |
| `internal/storage` | Local folder (`STORAGE_DIR`) and Google Cloud Storage over the JSON API (`STORAGE_BUCKET`), and the manifest |
| `internal/outbox` | The signed Build for the board to post |
| `internal/release` | Share collection, `K_priv` rebuild and delivery, the signed log |
| `internal/lifecycle` | The state machine and the `api.Backend` |
| `internal/api` | Routes, request and response types, CORS and the error shape |
| `internal/vectors` | Builds `testdata/vectors.json` |
| `internal/*/*test` | Test doubles: `timelocktest` (a drand chain with a known key), `webauthntest` (a software passkey with real ES256), `attestationtest` (a stand-in token chain). Never imported by the TEE |

The TEE has no wallet and writes nothing to the chain. Its chain reads are the exam record, the criteria, the approved list and, on a fresh Unlock instance, the Build. The Build is the only TEE message that goes on-chain: it waits in `outbox`, and the board posts it.

## Lifecycle

`lifecycle.Machine` runs by itself, stepping every two seconds, with no board calls:

1. **Onboard:** read the criteria and check them against `criteriaHash`, accept registrations, then read the approved list at the `chain.readBlock` block, check it and each entry's registration. A list that fails ends the exam (`failed`). If the chain already holds a Build, this is a fresh Unlock instance and it starts "Unlock Instance" instead. An instance with no registrations can't have run Onboard, so it closes registration, skips the list check and keeps polling for the Build.
2. **Submit:** accept questions from setters on the list until drand publishes the lock round.
3. **Lock:** check the bank against the criteria. On failure the stage is `failed`.
4. **Build and Distribute:** draw a seed, pick the questions per topic, encrypt the paper, split `K`, timelock `K_pub`, encrypt shares, write the files, then the manifest last, then queue the signed Build. `K`, `K_pub`, `K_priv`, the shares and the seed are zeroed before anything waits on storage.
5. **Unlock:** accept shares once drand publishes the unlock round, check each against the manifest's `shareHash`, rebuild `K_priv` at 8, then write `key-priv/*`, `key-priv.tlock`, `release-token.jwt` and `release-log.json`. Shares are refused once the end round is published.

`chain.readBlock` is `latest` during development and must be `finalized` for a real exam (see "Dev Mode" in `spec/api.md`). The TEE panics at startup on any other value and logs the value once. At `latest` a reorg can remove a list the TEE already accepted. The TEE doesn't read it again, so a different list then fails at `postBuild`, which checks the list hash.

Errors that a retry can fix (RPC, storage, drand) leave the stage unchanged. Errors that cannot (a bad list, failed criteria, a Build that does not verify) move to `failed`.

## Attestation

`GET /v1/attestation` asks the launcher for an OIDC token over `/run/container_launcher/teeserver.sock` (`POST /v1/token` with the custom audience and `eat_nonce` as the nonce). Without the socket the instance is **unattested**: the response has an empty `token` and `"attested": false`, the Build cannot be committed (it needs `token.jwt` in the manifest), and no token is ever made up. Published tokens use the PKI type. `attestation.Verifier` checks them against Google's root in `internal/attestation/confidential_space_root.pem`, which is the `root_ca_uri` of `https://confidentialcomputing.googleapis.com/.well-known/attestation-pki-root` (SHA-1 `B9:51:20:74:2C:24:E3:AA:34:04:2E:1C:3B:A3:AA:D2:8B:21:23:21`, as Google documents). A copy lives in `packages/attestation` and the two must stay identical.

## Run

```sh
go build ./... && go vet ./... && go test -count=1 ./...
```

Live drand, on demand and not part of `go test ./...`:

```sh
go test -tags drandlive -run Live -v ./internal/timelock
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

Environment: set `STORAGE_BUCKET` to a public Google Cloud Storage bucket (writes use the workload service account's token from the metadata server), or `STORAGE_DIR` for a local folder. The TLS roots for chain reads and drand are loaded only from `/etc/paperseal/roots.pem` in the image, never from the host.

## Test Vectors

`testdata/vectors.json` holds fixed inputs and expected bytes for other languages to check against: every message hash (including `instanceKey`), the selection criteria, the approved list, the attestation nonce, HPKE messages sealed in Go for each purpose and AES-256-GCM (to open in TypeScript from the recipient's input keying material), padding, the `release` plaintext, `entriesHash` and the manifest hash. A test fails if the Go output drifts from the file. After a deliberate format change, change `spec/` first, then run:

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

The script builds for `linux/amd64` with a pinned BuildKit, sets `SOURCE_DATE_EPOCH` from the commit time, rewrites timestamps, leaves out provenance and SBOM attestations, and prints the digest. The Go and distroless base images are pinned to their `linux/amd64` digests, and the TLS roots are copied from the pinned Go image. Build from a clean checkout of the tagged commit, because that is what anyone comparing digests will do.

`ExamRegistry` stores the digest as `bytes32`, without the `sha256:` prefix.

## Libraries

| Library | Version | Why |
| --- | --- | --- |
| `github.com/ethereum/go-ethereum/accounts/abi` | v1.17.5 | Solidity ABI encoding for every hashed message, the approved list and the `ExamRegistry` reads |
| `github.com/cloudflare/circl/hpke` | v1.6.4 | HPKE with the DHKEM(P-256) suite, because Go 1.24 has no `crypto/hpke` |
| `github.com/drand/tlock` | v1.2.0 | drand timelock, the same armoured age format `tlock-js` opens |
| `github.com/drand/drand/v2`, `drand/kyber`, `filippo.io/age` | via tlock | BLS verification of rounds, and the age armour |
| `github.com/hashicorp/vault/shamir` | vault v1.14.0 | Shamir over GF(256), widely used and reviewed |

- Versions are the newest that build with Go 1.24.6 and `GOTOOLCHAIN=local`. circl v1.6.5 needs Go 1.25, go-ethereum v1.17.6 needs Go 1.25, and go-clients v0.3.0 needs Go 1.26. Newer `google.golang.org/genproto` versions need Go 1.26, so `go.mod` pins the one before.
- go-clients is not used: `internal/timelock` reads the drand HTTP API itself and verifies each round with `drand/v2/crypto`.
- Shamir is pinned to vault v1.14.0 because the whole module is MPL-2.0 at that tag. Later tags put the module under BUSL, with the same `shamir.go` under MPL-2.0. The file is byte-identical through v1.20.4. No smaller library with comparable review turned up, so it stays. `shamir.Combine` has no threshold of its own and returns wrong bytes for too few or tampered shares. `split.CombineShares` enforces the threshold, and `release` checks each share's hash first.
- Google Cloud Storage is reached through its JSON API over HTTP, not `cloud.google.com/go/storage`, which would pull in gRPC and OpenTelemetry for two calls.
