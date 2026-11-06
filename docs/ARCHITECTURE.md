# Paper Seal Architecture Map

How the design in the [README](../README.md) maps onto this repository. The README is the source of truth for behaviour. This file says where each piece lives and who owns it.

## Repository Layout

| Path | Language | What it is |
| --- | --- | --- |
| `spec/` | JSON, Markdown | Values and wire formats shared by every language |
| `contracts/` | Solidity, Foundry | `ExamRegistry` |
| `tee/` | Go | The Confidential Space workload and its reproducible image |
| `packages/protocol` | TypeScript | Types and constants from `spec/`, including domain tags, hash encoding through ABI encoding with viem, and the exam-name rule (`examNameProblem`, `spec/ens.json`) |
| `packages/crypto` | TypeScript | HPKE, AES-256-GCM, XOR and timelock decrypt |
| `packages/keys` | TypeScript | The key interface over WebAuthn PRF |
| `packages/attestation` | TypeScript | Confidential Space token checks |
| `packages/chain` | TypeScript | `ExamRegistry` reads and writes through viem, the code pin check (`checkRegistryCode`, `spec/registry.json`), and the on-chain ENS name check (`resolveExamName`) |
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

`apps/verifier` covers the public checks, live unlock status and the post-exam proof, with no sign-in. It exists to check the board, so the board must not be the only party serving it. It is a static build with relative paths that anyone can host, it uses no passkeys, and viewers can set their own RPC and TEE URLs. The TEE must allow cross-origin reads on its public routes for this to work. `#/name/<ENS name>` checks an exam by name first ("Exam Names" in `spec/api.md`): it reads ENS through the viewer's RPC, with CCIP-Read off, and saves nothing it resolves. In the people step it also reads each key holder's and centre's ENS name the same way ("Party Names" in `spec/api.md`), as a label and a proof of who holds a key. That never decides a check.

## Dependency Rules

- Everything that crosses a language boundary is defined in `spec/` first, then implemented in Go, Solidity and TypeScript.
- Apps depend on packages. Packages never depend on apps.
- `packages/protocol` depends on nothing internal. All other packages may depend on it.
- `packages/crypto` holds no key state. `packages/keys` is the only code that touches WebAuthn.
- Shamir splitting and rebuilding exist only in `tee/`. No browser code handles `K_priv` shares beyond decrypting and forwarding its own.
- The `ExamRegistry` ABI and runtime bytecode are generated from `contracts/` and copied into `packages/chain` by `make abi`. They are never edited by hand.
- Only `packages/chain` reads ENS, and only the verifier uses it. `tee/` and `contracts/` never read ENS.

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

## Invites

Invites keep a name from being enough to register. The board makes one per person, holding a random 32-byte `inviteSecret`, a role and, for key holders and centres, the `owner` name. It goes out as a link whose URL fragment holds all of it (`#/join?exam=..&role=..&owner=..&secret=..`), so no server sees it. The invite code is in `packages/protocol/src/invite.ts`, which both the board and the e2e driver use.

| Where | What it does |
| --- | --- |
| `packages/protocol` | `inviteTag` (HMAC-SHA-256 of the secret over the passkey public key), strict link encoding and decoding, `matchInvites`, `listRolesFor` and `entriesFor`. The `registration` message ends with `bytes32 inviteTag` |
| `packages/keys` | `register` takes the `inviteSecret`, makes the tag after the passkey exists and signs it into `registration`. The secret never leaves the device |
| `packages/tee-client` | `inviteTag` on `RegisterRequest` and on each `RegistrationEntry` |
| `tee/` | Stores and returns the tag. It can't check it, because it never sees the secret |
| `apps/web` board | Creates the secrets and links, keeps them in the board's browser, recomputes every tag and lists only matches. Two passkeys on one invite are both left off until the board reissues it |
| `apps/web` Register | Reads the invite from the fragment at `/join`, clears the address bar and keeps the invite in memory. Role and name come from the link, so nothing is typed. No valid link means an explanation and no form |

The invite secrets and setters' notes stay in the board's browser and are never published, so the list still shows a setter only as its `setterOwner` hash.

## TEE HTTP API

The TEE has no long-term state, and clients treat it as untrusted until the attestation check passes. It runs each stage by itself, so it has no board login. Request and response bodies are in `spec/api.md`.

| Route | Purpose |
| --- | --- |
| `GET /v1/attestation` | Fresh token and the instance public key |
| `GET /v1/status` | Current stage and release progress |
| `POST /v1/register/challenge` | Fresh registration challenge |
| `POST /v1/register` | Passkey registration with attestation, signing the invite tag |
| `GET /v1/registrations` | Registrations, each with its `inviteTag`, for the board to build the approved list |
| `POST /v1/questions/challenge` | Fresh question submission challenge |
| `POST /v1/questions` | Encrypted, padded question upload |
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

- Which approved authenticator AAGUIDs does the attestation check accept?
- Where are published artefacts found? The verifier needs a PKI token per instance key, and the TEE keeps no state to serve them later. The default is to list them in a storage manifest.
- Which RPC operator does the exam use, and how is its API key handled? Attested settings are public, so a key in `rpcHost` or the startup arguments would be exposed.

## Not Set Up Yet

- CI for tests. `.github/workflows/repro.yml` covers the image rebuild only
- Google Cloud project, Confidential Space deployment and the storage bucket
- Sepolia deployment and funded board wallet
