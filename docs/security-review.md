# Security Issues and Bugs

A working list for the team at ETHGlobal Mumbai, from a read of the whole repository and a review of the ENS work, on 2026-11-06. It isn't an audit. The [README](../README.md#trust-assumptions) already lists the design's trust assumptions; this file covers the code and the demo.

**Status:** *Fixed* means fixed on `main`. *Open* means nobody has picked it up. *Accepted* means it is fine for the hackathon, but not for a real exam.

**Severity:**
- **High:** it could let an exam be faked, or leak a paper.
- **Medium:** it weakens a check or a guarantee.
- **Low:** it's a correctness or hygiene issue.

## Fixed

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| F1 | Medium | `Register` in the TEE and the invite check allowed owner names up to 256 bytes, but the approved list allows 128. A 129–256 byte name registered fine, then failed the whole exam at Onboard. | Both now use `limits.ownerBytes` ([handlers.go](../tee/internal/lifecycle/handlers.go), [invite.ts](../packages/protocol/src/invite.ts)). Changing the TEE changes the image digest, so it needs a new TEE release. |
| F2 | High | The ENS name check's step 2 only asked `board()`. Any contract that returns the real board's address passed every name check, so a subname pointed at an attacker's contract could front a fake exam. | The code at the name's address must now be exactly `ExamRegistry`'s runtime bytecode with its `board` filled in (`spec/api.md`, "Exam Names", check 2). A real `ExamRegistry` only accepts writes from its board after deployment. Code can't show how storage was set at deployment, so see S5. |
| F3 | Medium | On a name route, the later `ExamRegistry` reads still allowed CCIP-Read. An address taken from ENS could make the viewer's browser fetch any URL. | The verifier turns CCIP-Read off for every registry read. |
| F4 | Low | A name that needed an offchain gateway was shown as "Can't read ENS" and retried forever. | It now fails at its check. Only network errors are retried. |
| F5 | Medium | Audit M1: nothing proved the registry address was `ExamRegistry`. The TEE called whatever `--registry` named, and apps only compared it with their configured address. | `spec/registry.json` pins the runtime code, with the metadata left out and the `board` words zeroed, and `make abi` writes it. The ENS name check, the TEE and the verifier all use it ("Registry Code" in `spec/api.md`). Other code fails the exam in the TEE, and no code or an RPC error is retried. The verifier fails its first step and shows the board. `node e2e/live/cli.mjs registry-check` compares a deployed contract with the pin. Needs a new TEE release. |
| F6 | Medium | Audit M3: a list at `limits.entriesBytes` (327,680 bytes) was too large for geth's 131,072-byte mempool, so a valid list might never reach a block. | `limits.entriesBytes` is 130,000 and `limits.entries` is 225, which fit 128-byte owners. The board app refuses a longer list before the wallet is asked. The contract was redeployed with the same 130,000-byte cap. Needs a new TEE release for the TEE to apply it. |
| F7 | Low | Audit L1: a Build posted after the unlock time passed unnoticed, because the contract doesn't compare it with time. | The verifier warns about it on the main view, without failing the exam. |
| F8 | Low | Audit L2: nothing bounded `Δ` or the end round, so an end round that never comes meant the proof never happens. | `schedule` in `constants.json` sets 24 hours and 7 days. The TEE refuses to start outside them, the board form refuses them, and the verifier fails its first step. The contract doesn't change. Needs a new TEE release for the TEE to apply them. |
| F9 | Low | Audit L3: the README said each write after the list is signed by the TEE, and the spec said the verifier shows the read mode. The contract only checks format, and the verifier didn't show it. | The README now says apps and fresh instances verify the signature. The verifier shows `chain.readBlock` in its evidence. |
| F10 | Medium | A name could lead to a different registry from the one the verifier was set up to read, with nothing to say so. | The verifier warns on the main view, in plain words, as soon as the name is read. The Sepolia line stays. |
| F11 | Low | The TypeScript chain client took the first log for a record even if a reorg had marked it `removed`. | It skips removed logs, as the TEE already did. Both have tests. |
| F12 | Low | A huge `endRound` or `examStart` on the record is past what a JavaScript date can hold, which threw while the verifier page drew. | Those times now read as too far away to show, and the schedule check fails. |

## Open: Security

| # | Severity | Issue | Where | Hackathon |
| --- | --- | --- | --- | --- |
| S1 | High | Demo-only settings are compiled into every image: `chain.readBlock` is `latest`, not `finalized`, and `webauthn.requireSecurityKeyAttestation` is `false`. No published image is suitable for a real exam. | [constants.json](../spec/constants.json) | Accepted. The [self-hosting proposal](proposals/self-hosting.md) step 6 adds dev and production image profiles. |
| S2 | High | The security key attestation chain check isn't implemented. It returns not-implemented and is skipped while S1's flag is off. The list of approved authenticators (AAGUIDs) is undecided. | [webauthn.go](../tee/internal/webauthn/webauthn.go), [ARCHITECTURE](ARCHITECTURE.md#open-questions) | Accepted, because the demo uses Chrome's virtual authenticator |
| S3 | High | The board serves the web app, so it could swap in its own derived keys at registration and later read shares and `K_priv`. Only the time seal still holds. | README, "Keys and Web App" | Accepted, a known design limit |
| S4 | Medium | ENS on Sepolia: anyone can register a look-alike parent such as `paperseal-mumbal.eth` with its own board and registry, and it passes. The check proves "this name belongs to this board", not "this is the board you meant". The reader also only supports Sepolia. | [chain/src/ens.ts](../packages/chain/src/ens.ts) | Accepted for the demo. Real use needs mainnet names |
| S5 | Medium | With ENS v2, anyone the board grants a resolver role can change records for every name on that resolver, including the exam names. They could also deploy `ExamRegistry`'s exact code with the real board's address and storage already filled in by a custom constructor, which passes the code check. | ENS v2 Permissioned Resolver | Open. Keep the roles with the board wallet only |
| S6 | Medium | The TEE trusts its RPC operator for chain reads, and `rpcHost` is attested and public, so it can't carry an API key. | README "TEE and Google Cloud", [ARCHITECTURE](ARCHITECTURE.md#open-questions) | Accepted. Use a public RPC |
| S7 | Low | `lockRound` has no time check on-chain, only ordering: it could fall before Onboard, or before drand's genesis. | [ExamRegistry.sol](../contracts/src/ExamRegistry.sol) `_checkSchedule` | Open |
| S8 | Low | `timelockDecrypt` doesn't check that a ciphertext is for the expected round, so each caller must check it. | [timelock.ts](../packages/crypto/src/timelock.ts) | Open. Check the callers |
| S9 | Low | `POST /v1/questions/challenge` works in every stage. The register and release challenges are stage-gated. | [handlers.go](../tee/internal/lifecycle/handlers.go) `QuestionChallenge` | Open |
| S10 | Low | `checkToken` throws on a malformed token instead of returning a failed verdict. | [token.ts](../packages/attestation/src/token.ts) `checkToken` | Open |
| S11 | Low | Only PKI attestation tokens are verified. OIDC (`kid` and JWKS) tokens return not-implemented. The TEE only issues PKI tokens. | [token.ts](../packages/attestation/src/token.ts) | Accepted |
| S13 | Medium | In the demo, the Arkiv relay signs with the board wallet, so the board's key decrypts into the relay's memory on every run. A leak would also expose the wallet that controls `ExamRegistry` and the ENS name. | [relay/](../relay) | Accepted for the prototype. Use a separate relay wallet for a real exam |
| S14 | Low | Arkiv readers trust writers by `$creator` only for spam control. Every row is checked anyway, but a writer can stay silent. Heartbeats only show whether a writer is alive and are not signed evidence. Writers come from the exam's ENS name or the build, so a board can leave out a neutral relay that viewers would want. | [spec/arkiv.md](../spec/arkiv.md) | Accepted. Viewers can add relays they trust |
| S15 | Low | Swarm backups are on the Sepolia testnet, so reading one needs a testnet Bee node. The demo batch lasts 3 days, after which the files can disappear unless it is topped up. | [arkiv/swarm.md](../arkiv/swarm.md) | Accepted for the demo. Production uses mainnet and a batch for the exam season |
| S16 | Low | Nothing on-chain hashes `key-priv.tlock` or `key-priv/*`, so a backup gives them availability only. A changed copy fails to decrypt, and the paper's salted hash catches a wrong key. | [spec/arkiv.md](../spec/arkiv.md), "Backups" | Accepted |
| S12 | Low | The keyholder boundary lint rule bans fewer names than its test, and doesn't cover `apps/web/src/shared/`, which keyholder pages import. | [apps/eslint.config.mjs](../apps/eslint.config.mjs), [boundaries.test.ts](../apps/web/src/boundaries.test.ts) | Open |
| S18 | Medium | The directory owner decides which key belongs to a name. In the demo that is the board, so a neutral's name proves nothing about independence, and the board could swap a record to point at its own key before posting the list. The swap is public, and the verifier compares the list with the record, but the TEE doesn't. | [README](../README.md#board), [ens-setup.md](ens-setup.md) |
| S19 | Medium | Nothing gates `POST /v1/register` beyond a challenge and a signature, and the registration store has no cap, so a sustained flood from software keys costs memory during Onboard and slows `GET /v1/registrations`. It can't change who is listed. This was already true with invites, because the TEE never saw a secret. | [Registration Flooding](../spec/api.md#registration-flooding), [registration.go](../tee/internal/registration/registration.go) |
| S20 | Medium | A key card travels by any message. A directory owner who doesn't check where a card came from can publish an attacker's key on someone's name, and that person's own key then won't match. | [ens-setup.md](ens-setup.md) |
| S21 | Low | Enrolling twice with one key in two browsers before the directory lists it makes two passkeys, because neither browser knows the other's. Only the card the directory owner publishes counts, and the other is unused. | [Enrol.tsx](../apps/web/src/shared/Enrol.tsx) |
| S17 | Low | A browser that didn't enrol has no attestation object to resend, so with security key attestation on it would be refused. Nothing publishes the object. S2 has to settle this: a third record, or pasting the card. | [RegisterByName.tsx](../apps/web/src/shared/RegisterByName.tsx) |

## Open: Bugs and Spec Mismatches

| # | Issue | Where |
| --- | --- | --- |
| B1 | The spec says the outbox `selected` and `bankSize` are decimal strings, but the TEE sends JSON numbers. The board app accepts both, so nothing breaks yet. | [api.md](../spec/api.md) TEE API, [types.go](../tee/internal/api/types.go) |
| B2 | `GET /v1/attestation` returns an `attested` field that the spec doesn't list. | [types.go](../tee/internal/api/types.go) |
| B3 | **Fixed.** `tee/README.md` named Go 1.24.6 and go-ethereum v1.17.5, but `go.mod` and the Dockerfile use Go 1.25.14 and v1.17.10. It now names the versions in use. | [tee/README.md](../tee/README.md) |
| B4 | **Fixed.** The README status line said the code was a scaffold that didn't implement the design. The README rewrite replaced it, and it now says a working prototype on test networks. | [README.md](../README.md) |
| B5 | Three TEE tests read files outside `tee/` (`spec/constants.json`, `spec/registry.json` and `spec/fixtures`), so `go test` fails in a `tee/`-only checkout. The image build is unaffected. | `tee/internal/spec`, `tee/internal/attestation`, `tee/internal/chainread` |
| B6 | `e2e/tests/chain-flow.e2e.ts` fetches upstream's real `v0.1.0` GitHub release over the network, so it breaks if that release goes away. | [chain-flow.e2e.ts](../e2e/tests/chain-flow.e2e.ts) |

## Demo and Operations Risks

| # | Risk | What to do |
| --- | --- | --- |
| D1 | If `VITE_TEE_STORAGE_BUCKET` isn't set at build time, every real attestation token fails, which blocks posting the list and the Build. | Set it for both apps. An exam's ENS name can supply it to the verifier |
| D2 | The board app doesn't listen for account or chain changes, so its status goes stale after a wallet switch. | Reload the page after switching |
| D3 | Setter invites and notes, and the chosen names, live in the board's browser storage. Another browser, or cleared storage, loses them unless the board saved a backup, which covers invites. | Use one browser profile for the board, and save a backup |
| D4 | Public Sepolia RPCs time out and rate-limit (HTTP 429), and the verifier polls them. A `cast send` can fail before or after the transaction goes out. | Use a keyed RPC for the apps when demoing, and check `cast nonce <address> --block pending` before sending again |
| D5 | `stop-tee.sh` and `teardown.sh` read `GET /v1/status` first and refuse mid-exam, or when the status can't be read. `--force` skips that check, and stopping mid-exam destroys the question bank and keys. | Use `--force` only when the exam no longer matters |
| D6 | The board's review step reads GitHub releases without a token, which allows 60 requests an hour, and has no manual fallback. A fork needs its own release with `VITE_RELEASES_REPO` set. | Avoid reload loops while demoing |
| D7 | Port 8080 is open only to Cloudflare's IP ranges, so the TEE can't be reached directly. | Follow `deploy/README.md` step 4 |
| D8 | The web app is Chromium only, and passkeys are tied to its domain. Changing the app's host after onboarding locks out every key. | Choose the domain before onboarding |
| D10 | Arkiv's public RPC is rate limited, and the relay and verifier poll it during unlock. | Set `ARKIV_ACCESS_KEY` for the relay |
| D11 | The Bee node's first sync on testnet takes about an hour, and needs an RPC that keeps old logs (ethpandaops or Tenderly, not publicnode). | Keep the node's data folder, and it resumes in seconds |
| D9 | The verifier's main bundle is about 1 MB. | Code-split later |

## How to Use This List

Pick a row, open an issue or a branch named after its number (for example `fix/s9-question-challenge`), and link back here. Per `CLAUDE.md`, change `spec/` first for anything that crosses a language boundary. A fix in `tee/` changes the image digest, so it needs a new TEE release before it reaches a live exam.
