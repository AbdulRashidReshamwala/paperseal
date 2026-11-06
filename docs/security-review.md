# Security Issues and Bugs

A working list for the team at ETHGlobal Mumbai, from a read of the whole repository and a review of the ENS work, on 2026-11-06. It isn't an audit. The [README](../README.md#trust-assumptions) already lists the design's trust assumptions; this file covers the code and the demo.

**Status:** *Fixed* means fixed on the `ens-verify-by-name` branch. *Open* means nobody has picked it up. *Accepted* means it is fine for the hackathon, but not for a real exam.

**Severity:**
- **High:** it could let an exam be faked, or leak a paper.
- **Medium:** it weakens a check or a guarantee.
- **Low:** it's a correctness or hygiene issue.

## Fixed

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| F1 | Medium | `Register` in the TEE and the invite check allowed owner names up to 256 bytes, but the approved list allows 128. A 129–256 byte name registered fine, then failed the whole exam at Onboard. | Both now use `limits.ownerBytes` ([handlers.go](../tee/internal/lifecycle/handlers.go), [invite.ts](../packages/protocol/src/invite.ts)). Changing the TEE changes the image digest, so it needs a new TEE release. |
| F2 | High | The ENS name check's step 2 only asked `board()`. Any contract that returns the real board's address passed every name check, so a subname pointed at an attacker's contract could front a fake exam. | The code at the name's address must now be exactly `ExamRegistry`'s runtime bytecode with its `board` filled in (`spec/api.md`, "Exam Names", check 2). A real `ExamRegistry` only accepts writes from its board. |
| F3 | Medium | On a name route, the later `ExamRegistry` reads still allowed CCIP-Read. An address taken from ENS could make the viewer's browser fetch any URL. | The verifier turns CCIP-Read off for every registry read. |
| F4 | Low | A name that needed an offchain gateway was shown as "Can't read ENS" and retried forever. | It now fails at its check. Only network errors are retried. |

## Open: Security

| # | Severity | Issue | Where | Hackathon |
| --- | --- | --- | --- | --- |
| S1 | High | Demo-only settings are compiled into every image: `chain.readBlock` is `latest`, not `finalized`, and `webauthn.requireHardwareAttestation` is `false`. No published image is suitable for a real exam. | [constants.json](../spec/constants.json) | Accepted. The [self-hosting proposal](proposals/self-hosting.md) step 6 adds dev and production image profiles. |
| S2 | High | The hardware attestation chain check isn't implemented. It returns not-implemented and is skipped while S1's flag is off. The list of approved authenticators (AAGUIDs) is undecided. | [webauthn.go](../tee/internal/webauthn/webauthn.go), [ARCHITECTURE](ARCHITECTURE.md#open-questions) | Accepted, because the demo uses Chrome's virtual authenticator |
| S3 | High | The board serves the web app, so it could swap in its own derived keys at registration and later read shares and `K_priv`. Only the time seal still holds. | README, "Keys and Web App" | Accepted, a known design limit |
| S4 | Medium | ENS on Sepolia: anyone can register a look-alike parent such as `paperseal-mumbal.eth` with its own board and registry, and it passes. The check proves "this name belongs to this board", not "this is the board you meant". The reader also only supports Sepolia. | [chain/src/ens.ts](../packages/chain/src/ens.ts) | Accepted for the demo. Real use needs mainnet names |
| S5 | Medium | With ENS v2, anyone the board grants a resolver role can change records for every name on that resolver, including the exam names. | ENS v2 Permissioned Resolver | Open. Keep the roles with the board wallet only |
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

## Open: Bugs and Spec Mismatches

| # | Issue | Where |
| --- | --- | --- |
| B1 | The spec says the outbox `selected` and `bankSize` are decimal strings, but the TEE sends JSON numbers. The board app accepts both, so nothing breaks yet. | [api.md](../spec/api.md) TEE API, [types.go](../tee/internal/api/types.go) |
| B2 | `GET /v1/attestation` returns an `attested` field that the spec doesn't list. | [types.go](../tee/internal/api/types.go) |
| B3 | `tee/README.md` still names Go 1.24.6 and go-ethereum v1.17.5, but `go.mod` and the Dockerfile use Go 1.25.14 and v1.17.10. | [tee/README.md](../tee/README.md) |
| B4 | The README status line says the code is a scaffold that doesn't implement the design, but it does, end to end. | [README.md](../README.md) |
| B5 | Two TEE tests read files outside `tee/` (`spec/constants.json` and `spec/fixtures`), so `go test` fails in a `tee/`-only checkout. The image build is unaffected. | `tee/internal/spec`, `tee/internal/attestation` |
| B6 | `e2e/tests/chain-flow.e2e.ts` fetches upstream's real `v0.1.0` GitHub release over the network, so it breaks if that release goes away. | [chain-flow.e2e.ts](../e2e/tests/chain-flow.e2e.ts) |

## Demo and Operations Risks

| # | Risk | What to do |
| --- | --- | --- |
| D1 | If `VITE_TEE_STORAGE_BUCKET` isn't set at build time, every real attestation token fails, which blocks posting the list and the Build. | Set it for both apps. An exam's ENS name can supply it to the verifier |
| D2 | The board app doesn't switch the wallet to Sepolia, and doesn't listen for account or chain changes, so its status goes stale after a switch. | Switch to Sepolia by hand before posting |
| D3 | Invites and setters' notes live only in the board's browser storage. Another browser, or cleared storage, loses them. | Use one browser profile for the board |
| D4 | Public Sepolia RPCs time out and rate-limit (HTTP 429), and the verifier polls them. A `cast send` can fail before or after the transaction goes out. | Use a keyed RPC for the apps when demoing, and check `cast nonce <address> --block pending` before sending again |
| D5 | `stop-tee.sh` and `teardown.sh` don't check the exam's stage. Stopping mid-exam destroys the question bank and keys. | Check `GET /v1/status` first |
| D6 | The board's version step reads GitHub releases without a token, which allows 60 requests an hour, and has no manual fallback. A fork needs its own release with `VITE_RELEASES_REPO` set. | Avoid reload loops while demoing |
| D7 | Port 8080 is open only to Cloudflare's IP ranges, so the TEE can't be reached directly. | Follow `deploy/README.md` step 4 |
| D8 | The web app is Chromium only, and passkeys are tied to its domain. Changing the app's host after onboarding locks out every key. | Choose the domain before onboarding |
| D10 | Arkiv's public RPC is rate limited, and the relay and verifier poll it during unlock. | Set `ARKIV_ACCESS_KEY` for the relay |
| D11 | The Bee node's first sync on testnet takes about an hour, and needs an RPC that keeps old logs (ethpandaops or Tenderly, not publicnode). | Keep the node's data folder, and it resumes in seconds |
| D9 | The verifier's main bundle is about 1 MB. | Code-split later |

## How to Use This List

Pick a row, open an issue or a branch named after its number (for example `fix/s9-question-challenge`), and link back here. Per `CLAUDE.md`, change `spec/` first for anything that crosses a language boundary. A fix in `tee/` changes the image digest, so it needs a new TEE release before it reaches a live exam.
