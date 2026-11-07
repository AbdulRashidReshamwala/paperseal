# Paper Seal Architecture Map

How the design in the [README](../README.md) maps onto this repository. The README is the source of truth for behaviour. This file says where each piece lives and who owns it.

## Repository Layout

| Path | Language | What it is |
| --- | --- | --- |
| `spec/` | JSON, Markdown | Values and wire formats shared by every language |
| `contracts/` | Solidity, Foundry | `ExamRegistry` |
| `tee/` | Go | The Confidential Space workload and its reproducible image |
| `packages/protocol` | TypeScript | Types and constants from `spec/`, including domain tags, hash encoding through ABI encoding with viem, the exam-name rule (`examNameProblem`, `spec/ens.json`), the per-exam PRF input (`prfInput`), and the directory and key card formats |
| `packages/crypto` | TypeScript | HPKE, AES-256-GCM, XOR, timelock decrypt, and recovering a passkey's public key from a signature with `@noble/curves` |
| `packages/keys` | TypeScript | The key interface over WebAuthn PRF |
| `packages/attestation` | TypeScript | Confidential Space token checks |
| `packages/arkiv` | TypeScript | The Arkiv mirror's schemas, a reader that returns only published writers' rows, and a writer that skips rows it already wrote (`spec/arkiv.md`) |
| `packages/swarm` | TypeScript | A small Bee HTTP client: upload an unencrypted collection, read a file, and manage postage batches (`spec/arkiv.md`, "Backups") |
| `packages/chain` | TypeScript | `ExamRegistry` reads and writes through viem, the code pin check (`checkRegistryCode`, `spec/registry.json`), the on-chain ENS name check (`resolveExamName`), and party and directory reads (`readPartyRecords`, `readDirectory`) |
| `relay/` | TypeScript | CLI that mirrors an exam's signed release log and Unlock token from the TEE or storage to Arkiv, indexes a registry's exams and approved lists from its events, and backs up an exam's files to Swarm |
| `packages/tee-client` | TypeScript | Typed client for the TEE HTTP API |
| `packages/verify` | TypeScript | The verifier's checks and loaders, with no browser, React or build-time settings, so the verifier page and a Node script run the same code (`spec/agent-verification.md`). The test world is at `@paperseal/verify/fixtures` |
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
| `/enrol` | Key holder, centre | Makes the permanent passkey and shows the key card |
| `/exam` | Key holder, centre | The public exam page: register by name, then on to the role's page |

The README names separate setter and centre apps. One app is simpler to host and keeps one passkey domain. Keyholder routes still never import paper or `K_priv` handling, and a lint rule or test enforces that.

`apps/verifier` covers the public checks, live unlock status and the post-exam proof, with no sign-in. It exists to check the board, so the board must not be the only party serving it. It is a static build with relative paths that anyone can host, it uses no passkeys, and viewers can set their own RPC and TEE URLs. The TEE must allow cross-origin reads on its public routes for this to work. `#/name/<ENS name>` checks an exam by name first ("Exam Names" in `spec/api.md`): it reads ENS through the viewer's RPC, with CCIP-Read off, and saves nothing it resolves. In the people step it also reads each key holder's and centre's ENS name the same way ("Party Names" in `spec/api.md`), as a label and a proof of who holds a key. That never decides a check.

## Dependency Rules

- Everything that crosses a language boundary is defined in `spec/` first, then implemented in Go, Solidity and TypeScript.
- Apps depend on packages. Packages never depend on apps.
- `packages/protocol` depends on nothing internal. All other packages may depend on it.
- `packages/crypto` holds no key state. `packages/keys` is the only code that touches WebAuthn.
- Shamir splitting and rebuilding exist only in `tee/`. No browser code handles `K_priv` shares beyond decrypting and forwarding its own.
- The `ExamRegistry` ABI and runtime bytecode are generated from `contracts/` and copied into `packages/chain` by `make abi`. They are never edited by hand.
- Only `packages/chain` reads ENS, and the verifier and `apps/web` use it. `tee/` and `contracts/` never read ENS.
- Only `packages/arkiv` talks to Arkiv. The relay writes, and the verifier reads and checks every row with the same checks it uses on storage. `tee/` and `contracts/` never touch Arkiv.

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

## Invites and names

Setters are invited. Key holders and centres have a permanent ENS name instead. See "Invites" and "Party Names" in `spec/api.md`.

An invite keeps a setter's registration tied to the board's choice. It holds a random 32-byte `inviteSecret` and goes out as a link whose URL fragment holds all of it (`#/join?exam=..&role=setter&secret=..`), so no server sees it. The invite code is in `packages/protocol/src/invite.ts`, which both the board and the e2e driver use.

A party enrols once at `/enrol`, the directory owner writes the records from the key card, and the party registers per exam at `/exam` with no secret. `inviteTag` is 32 zero bytes for these registrations, which keeps the hash layout.

| Where | What it does |
| --- | --- |
| `packages/protocol` | `inviteTag`, `noInviteTag`, `prfInput`, strict link encoding and decoding, `matchInvites`, `setterEntries`, `parseDirectory` and key cards. The `registration` message ends with `bytes32 inviteTag` |
| `packages/keys` | `register` makes a setter's passkey and signs its tag. `generateKey` with `excludeCredentials` enrols, and refuses a key already known. `registerByName` takes two gets: the exam's PRF, then the signature, and recovers the public key from the first when the browser never saw it |
| `packages/chain` | `readPartyRecords` and `readDirectory`, on chain only with the viewer's RPC |
| `packages/tee-client` | `inviteTag` on `RegisterRequest` and on each `RegistrationEntry` |
| `tee/` | Stores and returns the tag, and refuses a zero tag without a derived key. It can't check a tag, because it never sees the secret. A registration is one `webauthn.get` over the `registration` message on both paths |
| `apps/web` board | Picks names and roles (`areas/board/parties.ts`), and lists a registration only if its passkey hash equals the name's record. Keeps setter invites in the board's browser, recomputes every tag and lists only matches. Two passkeys on one invite are both left off until the board reissues it |
| `apps/web` shared | `Enrol.tsx`, `ExamPage.tsx` and `RegisterByName.tsx` for parties. `Join.tsx` and `Register.tsx` for setters |
| `deploy/ens/records.mjs` | Prints the `cast send` commands from a key card, and sends nothing |

The invite secrets and setters' notes stay in the board's browser and are never published, so the list still shows a setter only as its `setterOwner` hash.

## TEE HTTP API

The TEE has no long-term state, and clients treat it as untrusted until the attestation check passes. It runs each stage by itself, so it has no board login. Request and response bodies are in `spec/api.md`.

| Route | Purpose |
| --- | --- |
| `GET /v1/attestation` | Fresh token and the instance public key |
| `GET /v1/status` | Current stage and release progress |
| `POST /v1/register/challenge` | Fresh registration challenge |
| `POST /v1/register` | Passkey registration, by an assertion over the `registration` message |
| `GET /v1/registrations` | Registrations, each with its `inviteTag`, for the board to build the approved list. Anyone can read them |
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

## Not Built Yet

- The hardware attestation check for real security keys. It returns not-implemented, and the demo turns it off (S2 in [security-review.md](security-review.md))
- A production image profile. Every image has the demo settings (S1)
- The `gcp-lb` ingress and the Cloudflare Pages module from the [self-hosting proposal](proposals/self-hosting.md)

## Mock run (test only)

`pnpm --filter @paperseal/e2e ui:mock` runs the real-run script (`e2e/ui/examRun.ts`) in about ten minutes with no VM, Sepolia or bucket, to iterate on screens and recordings. It is not a real run and its videos are named `mock-*`.

- **Real:** the apps, the `ExamRegistry` contract on a local anvil, Chrome with virtual security keys and PRF keys, HPKE, AES-GCM, ECDSA and every message and file of `spec/api.md`, the drand clock and beacons, and the GitHub release list.
- **Replaced:** the Go TEE by a TypeScript machine in `e2e/mock` (random shares stand in for Shamir, it does not check WebAuthn signatures, and it always puts a multiple choice question on the paper when the bank has one), its attestation by a throwaway root, the board's Foundry wallet by anvil's test wallet, and the bucket by a local server.
- **Guard:** the apps trust the throwaway root only when Vite runs in its own `mock` mode (`apps/*/src/mockMode.ts`), which also shows "Mock data" on every screen. `vite.config.ts` refuses to build in that mode and refuses `VITE_MOCK_TRUST_ROOT` in any other, and `mockMode.test.ts` builds each app and checks the output has no trace of the mock path.
