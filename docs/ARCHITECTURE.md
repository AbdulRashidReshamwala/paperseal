# Paper Seal Architecture Map

How the design in the [README](../README.md) maps onto this repository. The README is the source of truth for behaviour. This file says where each piece lives and who owns it.

## Repository Layout

| Path | Language | What it is |
| --- | --- | --- |
| `spec/` | JSON, Markdown | Values and wire formats shared by every language |
| `contracts/` | Solidity, Foundry | `ExamRegistry` |
| `tee/` | Go | The Confidential Space workload and its reproducible image |
| `packages/protocol` | TypeScript | Types and constants from `spec/`, including domain tags and hash encoding through ABI encoding with viem |
| `packages/crypto` | TypeScript | HPKE, AES-256-GCM, XOR and timelock decrypt |
| `packages/keys` | TypeScript | The key interface over WebAuthn PRF |
| `packages/attestation` | TypeScript | Confidential Space token checks |
| `packages/chain` | TypeScript | `ExamRegistry` reads and writes through viem |
| `packages/tee-client` | TypeScript | Typed client for the TEE HTTP API |
| `packages/ui` | React | Shared components, tokens and the Chromium gate |
| `apps/web` | React | The board-hosted app, with a route area per signed-in role |
| `apps/verifier` | React | The public verifier, hosted separately from the board |

Each signed-in role has a code-split route area in `apps/web`:

| Route | Role | What it does |
| --- | --- | --- |
| `/board` | Board admin | Blueprint, schedule, onboarding, list posting and on-chain posting |
| `/setter` | Setter | Sign-in, question upload and the sealed receipt |
| `/centre` | Centre | Download, countdown, share release, unlock and log |
| `/keyholder` | Neutral party | Share release, without paper access |

The README names separate setter and centre apps. One app is simpler to host and keeps one passkey domain. Keyholder routes still never import paper or `K_priv` handling, and a lint rule or test enforces that.

`apps/verifier` covers the public checks, live unlock status and the post-exam proof, with no sign-in. It exists to check the board, so the board must not be the only party serving it. It is a static build with relative paths that anyone can host, it uses no passkeys, and viewers can set their own RPC and TEE URLs. The TEE must allow cross-origin reads on its public routes for this to work.

## Dependency Rules

- Everything that crosses a language boundary is defined in `spec/` first, then implemented in Go, Solidity and TypeScript.
- Apps depend on packages. Packages never depend on apps.
- `packages/protocol` depends on nothing internal. All other packages may depend on it.
- `packages/crypto` holds no key state. `packages/keys` is the only code that touches WebAuthn.
- Shamir splitting and rebuilding exist only in `tee/`. No browser code handles `K_priv` shares beyond decrypting and forwarding its own.
- The `ExamRegistry` ABI is generated from `contracts/` and copied into `packages/chain` by `make abi`. It is never edited by hand.

## Lifecycle Ownership

| Stage | TEE | Contract | Apps |
| --- | --- | --- | --- |
| Publish | Runs with attested settings | `createExam` stores commit, digest and settings | Board |
| Onboard | Registers holders, reads the approved list from chain over TLS and checks it | `postApprovedList`, write-once | Board, centre, keyholder |
| Submit | Validates and stores encrypted questions | None | Setter |
| Lock | Checks criteria | None, no on-chain post | Board, verifier |
| Build | Selects, assembles, pads and encrypts | None until Distribute | None |
| Split | Splits `K`, timelocks `K_pub` and shares | None | None |
| Distribute | Writes to storage, then signs the Build statement | `postBuild` only, once per exam, with the selection fields | Board, centre |
| Unlock | Collects shares, rebuilds and delivers `K_priv` | None | Centre, keyholder, verifier |
| Verify | None | Read only | Verifier |

## TEE HTTP API

The TEE has no long-term state, and clients treat it as untrusted until the attestation check passes. Request and response bodies are not specified yet. Until they are in `spec/api.md`, the types in `packages/tee-client` are provisional and every route returns 501.

| Route | Purpose |
| --- | --- |
| `GET /v1/attestation` | Fresh token and the instance public key |
| `GET /v1/status` | Current stage and release progress |
| `POST /v1/register/challenge` | Fresh registration challenge |
| `POST /v1/register` | Passkey registration with attestation |
| `POST /v1/onboard/list` | Read and check the approved list from chain |
| `POST /v1/questions` | Encrypted, padded question upload |
| `POST /v1/lock` | Run the lock checks |
| `POST /v1/build` | Run Build, Split and Distribute |
| `GET /v1/outbox` | TEE-signed messages waiting for the board to post |
| `POST /v1/release/challenge` | Fresh share release challenge |
| `POST /v1/release/share` | Encrypted share and signature |
| `GET /v1/release/log` | Signed release log |

## Design Decisions Filled In

The README leaves these open. They are defaults for the build and can change.

| Topic | Decision | Why |
| --- | --- | --- |
| Monorepo tooling | pnpm workspaces plus a root Makefile | Three languages, and no task graph worth a build tool yet |
| TEE signature checks | `ExamRegistry` stores TEE signatures but does not verify them | The attested key only exists off-chain. Apps verify against the attestation token |
| Board posting | The board app reads `/v1/outbox` and sends each transaction from its wallet | The README requires the board's address for writes |
| Hash encoding | `abi.encode` through Solidity, viem and go-ethereum's `accounts/abi` | One standard encoding in all three languages, with no custom code |
| Chain reads in the TEE | The TEE reads `ExamRegistry` over TLS from the attested RPC host, with root certificates in the image | The board can block a read but can't change it |
| HPKE suite | DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM | Matches the README's P-256 and AES-256-GCM choice |
| Public storage | A public Google Cloud Storage bucket | The TEE already runs on Google Cloud |
| Padded sizes | 4 KiB per question and 1 MiB per paper | Provisional hackathon values in `spec/constants.json` |

## Open Questions

- How does the TEE authenticate board admin calls such as `/v1/lock` and `/v1/build`? The default is a signature from the board's Ethereum address, checked against `board` in `ExamRegistry`, because the board key is gone.
- Which approved authenticator AAGUIDs does the attestation check accept?
- Where are published artefacts found? The verifier needs a PKI token per instance key, and the TEE keeps no state to serve them later. The default is to list them in a storage manifest.
- Who hosts the official copy of `apps/verifier`? The default is a static host outside the board's control, with a published build digest so people can compare it.
- Which RPC operator does the exam use, and how is its API key handled? Attested settings are public, so a key in `rpcHost` or the startup arguments would be exposed.

## Spec Gaps Before Implementation

Found while scaffolding. Each one blocks real implementation, because Go and TypeScript must agree on the answer.

- Request and response bodies for all 12 TEE routes, including setter sign-in and board admin authentication
- Preimages for `storageManifestHash` and `entriesHash`
- Width of `challenge`, and whether `paper` means the padded form
- How passkey signatures map onto WebAuthn challenges
- One TEE instance key or two. HPKE and ECDSA currently share one, and `eat_nonce` binds only one
- HPKE `info` and AAD, ciphertext framing, AES-GCM framing and AAD, and key derivation from PRF output
- Padding format, and whether the padded sizes apply before or after encryption
- How the settings are encoded as startup arguments, which the attestation check compares, plus approved `hwmodel` values and expected `env`
- TLS for the TEE, which serves plain HTTP on port 8080, so HTTPS-hosted apps can't call it yet, and CORS rules for POST routes

## Not Set Up Yet

- CI for tests. `.github/workflows/repro.yml` covers the image rebuild only
- Google Cloud project, Confidential Space deployment and the storage bucket
- Sepolia deployment and funded board wallet
