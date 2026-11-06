# Paper Seal Contracts

`ExamRegistry`, the public on-chain record of each exam. The [root README](../README.md) is the source of truth for behaviour, and [`spec/api.md`](../spec/api.md) defines the fields.

## What It Does

| Function | Stage | Needs |
| --- | --- | --- |
| `createExam` | Publish | Nothing |
| `postApprovedList` | Onboard | The exam |
| `postBuild` | Distribute | The approved list |

- Only the board's address can write. It is set once at deployment, for every exam in that deployment.
- Each record can be written once. The commit hash, image digest and exam settings, including the rounds that set the exam date, can never change.
- `postApprovedList` stores `sha256(abi.encode(tag, examId, entries))` and emits the full bytes, where `entries` is `abi.encode(Entry[])`. The contract doesn't decode the entries, because the TEE checks their content.
- `postApprovedList` reverts with `EntriesTooLarge` if `entries` is over 327680 bytes, and `createExam` reverts with `CriteriaTooLarge` if `criteria` is over 16384 bytes (`limits.criteriaBytes`). Both checks are by length alone and come before any hashing, with no decoding. The entries cap is an upper bound: `limits.entriesBytes` is lower, so a list fits in one transaction, and every reader and the board app apply that. See "Size Limits" in `spec/api.md`. A test reads both limits from `spec/constants.json`, so neither can pass the contract's.
- The Build stores the TEE's signature and instance public key. The contract doesn't verify the signature, because the attested key only exists off-chain. Apps verify it against the attestation token.
- The contract checks formats and consistency only, so that a mistyped value can't fill a write-once slot. A Build must carry the posted approved list hash and the exam's criteria hash.
- `createExam` takes the encoded selection criteria and reverts unless `sha256(abi.encode(tag, criteria))` equals `settings.criteriaHash`. It emits the bytes in `ExamCreated` so anyone can read them and recompute the hash, but doesn't store or decode them.
- `createExam` checks the rounds against `examStart`, `delta` and quicknet's timing. The contract doesn't read drand or compare rounds with block time, because drand is the only clock. The verifier page checks timing.

Each write emits an event with `examId` indexed and every stored field in its data. `getExam`, `getApprovedList` and `getBuild` read the records. A record that isn't written yet returns empty, with `createdAt` or `postedAt` set to zero.

`entries` and `criteria` are only in events. `getExam` returns `createdBlock` and `getApprovedList` returns `postedBlock`, so a client can read each one with `eth_getLogs` over that single block. Public RPC operators reject wide block ranges, so clients never search from an earlier block.

## Commands

Run these from `contracts/`.

```sh
forge build
forge test
forge fmt --check
```

`forge-std` v1.17.0 is vendored in `lib/`, with no submodule. To change it, replace the folder with `forge install --no-git foundry-rs/forge-std@<tag>`.

## Deploy

Copy `.env.example` to `.env` and fill it in, then deploy from any funded wallet. Forge loads `.env` itself, and the deployer doesn't need to be the board.

```sh
forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --account <keystore-name>
```

A new board address needs a new deployment.
