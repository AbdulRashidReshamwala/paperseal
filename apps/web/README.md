# Paper Seal web app

The board-hosted app, on port 5171. `/board`, `/setter`, `/centre` and `/keyholder` are lazy route areas, so each role downloads only its own code. Set `VITE_TEE_URL`, `VITE_RPC_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` at build time.

The release flow in `src/release` is shared by `/centre` and `/keyholder`, so it must stay free of paper and `K_priv` handling. That code lives in `src/areas/centre`. ESLint rules in `apps/eslint.config.mjs` and `src/boundaries.test.ts` enforce this.

## Board: create and publish an exam

`/board/blueprint`, `/board/schedule` and `/board/publish` hold one form in the board route area, so it survives moving between screens. Publishing sends `createExam` from the connected browser wallet (`window.ethereum`, through viem's custom transport) on Sepolia. The app holds no private key. Before sending it checks that the wallet is on chain 11155111 and that its account equals `registry.board()`, dry-runs the call so reverts are explained in words, and after mining reads `getExam` and `getCriteria` back and compares them with what was entered. The published exam ID is kept in this browser's localStorage, so the overview shows it without a rebuild. `VITE_EXAM_ID` is the fallback.

Tests: `pnpm test` runs everything except the anvil test. `pnpm test:integration` starts `anvil --chain-id 11155111`, deploys `contracts/out/ExamRegistry.sol/ExamRegistry.json` (run `forge build` in `contracts/` first) and publishes through `packages/chain`. It uses anvil's public dev key, only in `src/integration/anvil.integration.ts`.

To try it by hand against anvil, deploy with `BOARD_ADDRESS=<anvil account 0> forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545` from `contracts/`, add anvil's account to a wallet on a chain with ID 11155111 and RPC `http://127.0.0.1:8545`, and run the app with `VITE_RPC_URL=http://127.0.0.1:8545 VITE_REGISTRY_ADDRESS=<deployed address> pnpm dev`. For Sepolia, use the board's deployed `ExamRegistry` address and a Sepolia RPC URL.
