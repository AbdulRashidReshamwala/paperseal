# Paper Seal web app

The board-hosted app, on port 5171. `/board`, `/setter`, `/centre` and `/keyholder` are lazy route areas, so each role downloads only its own code. Set `VITE_TEE_URL`, `VITE_RPC_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` at build time.

The release flow in `src/release` is shared by `/centre` and `/keyholder`, so it must stay free of paper and `K_priv` handling. That code lives in `src/areas/centre`. ESLint rules in `apps/eslint.config.mjs` and `src/boundaries.test.ts` enforce this.

## Board: create and publish an exam

`/board/blueprint`, `/board/schedule` and `/board/publish` hold one form in the board route area, so it survives moving between screens. Publishing sends `createExam` from the connected browser wallet (`window.ethereum`, through viem's custom transport) on Sepolia. The app holds no private key. Before sending it checks that the wallet is on chain 11155111 and that its account equals `registry.board()`, dry-runs the call so reverts are explained in words, and after mining reads `getExam` and `getCriteria` back and compares them with what was entered. The published exam ID is kept in this browser's localStorage, only when the read-back matches, so the overview shows it without a rebuild. `VITE_EXAM_ID` is the fallback. Every area (Register, key holder, centre, setter, release and the board) reads the one current exam from `src/shared/currentExam.ts`, and a key holder and a centre keep separate stored credentials.

Tests: `pnpm test` runs everything except the anvil test. `pnpm test:integration` starts `anvil --chain-id 11155111`, deploys `contracts/out/ExamRegistry.sol/ExamRegistry.json` (run `forge build` in `contracts/` first) and publishes through `packages/chain`. It uses anvil's public dev key, only in `src/integration/anvil.integration.ts`.

To try it by hand against anvil, deploy with `BOARD_ADDRESS=<anvil account 0> forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545` from `contracts/`, add anvil's account to a wallet on a chain with ID 11155111 and RPC `http://127.0.0.1:8545`, and run the app with `VITE_RPC_URL=http://127.0.0.1:8545 VITE_REGISTRY_ADDRESS=<deployed address> pnpm dev`. For Sepolia, use the board's deployed `ExamRegistry` address and a Sepolia RPC URL.

## Key holder and centre

`VITE_STORAGE_URL` is the public storage base (files are read from `<base>/<examId>/<name>`), and `VITE_TEE_STORAGE_BUCKET` is the only environment variable the attestation check allows in the token. The release flow checks the TEE with `checkToken` and seals the share to `encryptionPublicKey` only when `trusted` is true. The share is HPKE-encrypted to its holder alone, so there is no time seal on it: the file is checked against the manifest, and the manifest against the Build. Centres download and check `paper.bin`, `key-pub.tlock` and the manifest ahead of time, and at unlock fetch K_pub from drand, open `key-priv/<derivedPublicKey>.bin`, and show the paper only if its salted hash equals the Build's. Both roles take their passkey from `shared/Register.tsx` and their derived key from the on-chain approved list.

## Board: onboarding and outbox

`/board/onboarding` reads the registrations the TEE verified from `GET /v1/registrations`, composes the list with `encodeApprovedList` after `checkApprovedList`, and posts it with `postApprovedList` from the wallet. The list slot is write-once, so posting stays blocked until the TEE passes attestation for the current exam against the chain and is at the `onboard` stage. The screen shows the exam being written, and the check runs again right before the wallet is asked. Setters register with no name. Their `owner` is the `setterOwner` hash of their own passkey public key, and `checkApprovedList` rejects any other value. `/board/outbox` verifies the Build's TEE signature against an attested instance key before `postBuild`.

## Setter

A setter confirms the TEE (attestation and the on-chain list hash), and the confirmation lasts 5 minutes. Before each question is sealed, the app reads a fresh attestation and requires the same keys. A question is sealed with `examId || passkeyPublicKey` as the HPKE aad. If a send is ambiguous, the sealed question is kept in memory, so a retry sends the same ciphertext instead of a second copy. The question text is dropped once its receipt is verified.
