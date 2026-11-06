# @paperseal/relay

The Arkiv writer of [spec/arkiv.md](../spec/arkiv.md) "Writers", which the code calls the relay. It reads one exam's public unlock evidence from storage and/or the TEE and mirrors it to Arkiv's Rabdi testnet through [`@paperseal/arkiv`](../packages/arkiv), with `index` it writes a registry's exam index from its Sepolia events, and with `backup` it copies an exam's checked storage files to Swarm through [`@paperseal/swarm`](../packages/swarm) and records the collection on Arkiv ("Backups"). Arkiv is only a mirror: the relay copies signed evidence and checks no signature, and readers check every row's `body` and only trust rows whose `$creator` is a published writer. A relay can stay silent, but it can't make a check pass.

## Commands

Run from the repo root. `cli.mjs` loads the TypeScript through Vite, like `e2e/live/cli.mjs`, so there is no build step.

```sh
# One pass: the release token first, then the release log.
node relay/cli.mjs mirror --exam <examId> --registry <ExamRegistry> [--storage <url>] [--tee <url>]

# The same pass every N seconds (default 10), writing only new snapshots, until the TEE says
# released or failed, or Ctrl+C. TEE and storage errors are printed and the loop goes on.
# Also writes a heartbeat every heartbeatSeconds (60), unless --no-heartbeat.
node relay/cli.mjs watch --exam <examId> --registry <ExamRegistry> [--storage <url>] [--tee <url>] [--every 10] [--no-heartbeat]

# Read-only: this exam's rows from one writer, newest first, then its heartbeats (the newest 10),
# each with its block and age. Default writer: the relay's keystore address. --registry keeps
# only rows for that ExamRegistry; without it, rows for every registry are shown.
node relay/cli.mjs status --exam <examId> [--registry <ExamRegistry>] [--writer <address>]

# Read-only: the exam-index rows for one ExamRegistry from one writer, by examStart: stage,
# examStart as a date, name and entity key.
node relay/cli.mjs status --index --registry <ExamRegistry> [--writer <address>]

# The exam index (spec/arkiv.md "Exam Index"): scans the registry's events and writes one exam row
# per exam and one participant row per approved-list entry. --every repeats it every N seconds.
node relay/cli.mjs index --registry <ExamRegistry> --from-block <n> [--to-block <n>] [--rpc <sepolia url>] \
  [--names a.board.eth,b.board.eth] [--every <seconds>]

# Swarm backup (spec/arkiv.md "Backups"): checks every storage file, uploads them as one Swarm
# collection stamped with --batch, writes a paperseal.v1.backup row, then reads manifest.json back.
# --dry-run runs every check (storage, Sepolia, the batch on the Bee node) and stops: no upload, no row, no key.
node relay/cli.mjs backup --exam <examId> --registry <ExamRegistry> --storage <url> --batch <batchId> \
  [--phase build|unlock] [--swarm <bee api>] [--rpc <sepolia url>] [--dry-run]

# Read-only: the Bee node's health, address, wallet balances, postage price and batches, and the
# cost of a depth-19 batch for 7 days. Buys nothing.
node relay/cli.mjs swarm-status [--swarm <bee api>]

# Prints the exact cost of a postage batch; buys it, with the node's sBZZ, only with --yes.
node relay/cli.mjs buy-stamp --depth <n> --days <n> [--label <text>] [--swarm <bee api>] [--yes]

# Offline self-test: argument parsing, storage URLs, payload preparation, index input building,
# backup checks and row columns, the buy-stamp quote, cast arguments.
node relay/cli.mjs dry-check
```

`mirror` and `watch` need at least one of `--storage` and `--tee`. For example, against the demo deployment:

```sh
node relay/cli.mjs mirror \
  --exam 0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295 \
  --registry 0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8 \
  --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams
```

Each pass starts with a summary line, ending in `(TEE stage <stage>)` only when the TEE serves this exam, `(TEE serves another exam)` when it shows another exam's approved list, or `(TEE shows no exam)` when it shows none. Then it prints one line per piece of evidence: `written` (new row, with its entity key, transaction hash and explorer links from `arkiv.network.explorer`), `skipped` (this writer already has it), `held` (not written yet; a later pass may write it), `refused` (not this exam's evidence) or `failed` (the write failed). `mirror` exits 1 if anything was refused or failed.

`pnpm --filter @paperseal/relay test|typecheck|lint` run the unit tests (no network), `tsc` and ESLint.

## What a pass does

1. **Storage** (`--storage`): reads `<url>/<examId>/release-log.json` and `<url>/<examId>/release-token.jwt`, the way `apps/verifier` builds object URLs. A 404 means the file isn't there yet.
2. **TEE** (`--tee`): reads `GET /v1/status`, the exact bytes of `GET /v1/release/log`, and, once the TEE has a log for this exam, `GET /v1/attestation`.
3. Every log must have `examId` equal to `--exam`, or it is refused, along with the storage token beside it. A TEE whose status shows another exam's approved list is ignored entirely.
4. **Tokens first.** The storage token's instance key is the storage log's `instancePublicKey`, as spec/api.md "Storage" says. The TEE's token is mirrored only when the attestation's `instancePublicKey` is the key that signed the TEE's log, so it is the Unlock instance's token. Otherwise it is held.
5. **Then logs.** A log is written only once a token for its signer is on Arkiv from this writer, because readers ignore a log whose signer no token attests. A newer TEE log and an older storage log are both written: readers show the verified log with the most entries.

## The exam index

`index` copies what `ExamRegistry`'s events already publish to the `paperseal.v1.exam` and `paperseal.v1.participant` rows of spec/arkiv.md "Exam Index". Readers check every row against Sepolia, so the index only helps people find exams.

1. **Scan.** It reads `ExamCreated`, `ApprovedListPosted` and `BuildPosted` from `--from-block` to `--to-block` (default: the latest block) through `@paperseal/chain`'s `scanEvents`, at most `logChunkBlocks` (10000) blocks per log query. The Sepolia RPC is `--rpc`, else `RELAY_SEPOLIA_RPC`, else `https://ethereum-sepolia-rpc.publicnode.com`; the header says which. Only the RPC's origin is printed: any path, query or credentials are hidden and redacted from errors, since providers put keys there.
2. **One full row per exam.** `stage` is `built` with a `BuildPosted`, else `listed` with an `ApprovedListPosted`, else `published`. `examStart`, `criteriaHash` and `createdBlock` come from `ExamCreated`, or from `getExam` when that event came before `--from-block`; `approvedListHash` from `ApprovedListPosted`, or from `getApprovedList` when only the build is in range; `paperHash` from `BuildPosted`; `board` from `board()`; `chainId` from `spec/constants.json`. `@paperseal/arkiv`'s `upsertExam` creates the row, patches what changed, or leaves it (`created`, `patched`, `unchanged`).
3. **Names.** Each `--names` entry goes through `resolveExamName` (every check of "Exam Names" in spec/api.md). Its name is set only on the exam it resolves to, and only if its `addr` is `--registry`. Any other name is skipped, and the reason is printed. An exam without a verified name gets an empty name. A name the RPC couldn't read decides nothing: a new exam it would name is `held` (not written), so a row's name isn't cleared by an outage.
4. **Participants.** For an exam with a list, the list bytes (from the event, else `getApprovedListEntries`, both already checked against the list hash) are decoded with `@paperseal/protocol`'s `decodeApprovedList`, the same rules every other reader applies, and passed to `mirrorParticipants`, which skips entries this writer already has. A list that fails is printed as `refused` and gets no participant rows.

Each exam prints its action, stage and name, entity key and explorer link, transaction hashes, and participants written and skipped; the pass ends with a summary line. One pass (no `--every`) exits 1 if any exam failed or was held, or a list was refused or failed.

With `--every <seconds>` (2 to 3600; no `--to-block`), `index` loops until Ctrl+C, each scan starting at the last `toBlock + 1`. What it has seen stays in memory, so a later `BuildPosted` builds on an earlier `ExamCreated` and list, and the stage never moves back (`upsertExam` refuses that too). A failed scan is tried again from the same block; a failed exam or participant write is tried again on the next pass even with no new event; an exam whose verified name changes is patched.

## Backups

`backup` follows spec/arkiv.md "Backups", "Writing". Every file is read and checked before anything is sent; the first failure prints `REFUSED`, exits 1, and nothing is uploaded or written.

1. **Phase.** `--phase`, else `unlock` if storage has `release-log.json`, else `build`. `--phase unlock` with no log is refused.
2. **Manifest.** `getBuild` on Sepolia (`--rpc`, else `RELAY_SEPOLIA_RPC`, else the public default) must have a Build. The SHA-256 of `manifest.json` must equal its `storageManifestHash`, and the manifest must parse (`parseManifest`) and name this exam.
3. **Listed files.** Each file the manifest lists is downloaded and must match its `sha256`.
4. **Unlock files** (`unlock` only), the list in spec/api.md "Storage":
   - `release-log.json` must name this exam, and its `entriesHash` must be the hash of its `entries`. Its `teeSignature` is left to readers.
   - `release-token.jwt` must be a JWT whose `eat_nonce` is the `attestationNonce` of the log's `instancePublicKey` and this exam. Its signature is left to readers.
   - `key-priv.tlock` and one `key-priv/<derivedPublicKey>.bin` per centre (roles 3 and 4 of the on-chain approved list, read with `getApprovedListEntries` and `decodeApprovedList`) must all be there. Nothing commits to their bytes (the Build commits to none of the unlock files, as `IsUnlockFile` in tee/internal/storage says), so the output marks them `unhashed`: they are backed up because they are in the spec's unlock list, and a reader authenticates each by its own means (the timelock, and HPKE to the centre's key).
5. **Batch.** `--batch` must be on the Bee node and usable (`GET /stamps`).

Then, unless `--dry-run`, it loads the keystore key (a keystore problem stops here with nothing sent), uploads every file as one unencrypted collection under its storage name with `Swarm-Deferred-Upload: false`, so Bee answers only after pushing every chunk to the network, and writes the row through `mirrorBackup`: `phase`, `swarmRef`, `swarmNetwork` (`swarm.network` in spec/arkiv.json), `manifestHash`, `files` (the number of files in the collection, `manifest.json` included) and `batchId`. `mirrorBackup` skips a row this writer already has for the same exam, registry, phase and reference. It prints the reference, a read-back link `<bee api>/bzz/<reference>/manifest.json`, and the entity key, transaction and explorer links. Last it downloads `manifest.json` from the collection and compares its bytes with what was uploaded. A failed row or a read-back that is missing or differs exits 1; a failed row still prints the reference; running `backup` again uploads again and writes the row.

`paper.bin` is padded to 1 MiB, so each storage download gets 180 s. The demo exam's unlock collection is 25 files, about 1.1 MB.

The Bee API is `--swarm`, else `RELAY_SWARM_API`, else `swarm.defaultApiUrl` in spec/arkiv.json (`http://127.0.0.1:1633`).

### Postage batches

`swarm-status` prints, each on its own so one 503 doesn't hide the rest: `/health`, the node's address, its wallet (sBZZ and ETH), `/chainstate` (price, and a note while Bee is still syncing the postage contract), each batch (ID, depth, usable, utilization of the fullest bucket out of `2^(depth − 16)`, TTL), and a quote for a depth-19 batch lasting 7 days.

`buy-stamp` prints the same quote for `--depth` (17 to 255) and `--days` (1 to 3650), and the wallet's balance. Without `--yes` it stops there and exits 0, having spent nothing. With `--yes` it buys an immutable batch and prints its ID; Bee needs some confirmations before the batch is usable, which `swarm-status` shows. It refuses, even with `--yes`, when the wallet holds less than the cost, or while Bee is still syncing the postage contract, since its price may then be stale. `--yes` buys at the quote printed in the same run.

A quote's `amount` (PLUR per chunk) is the current price times the blocks in the period: Sepolia's 12-second blocks, or Gnosis's 5-second blocks for a mainnet node (by the wallet's chain, else `swarm.network`). It is never below `minAmount` (Bee's minimum validity). The cost is `stampCost`: `2^depth × amount` PLUR, with 10^16 PLUR to 1 BZZ.

## Heartbeats

Readers time the mirror's last sign of life from its newest heartbeat or log row (spec/arkiv.md "Reading", rule 4), and warn once it is older than `staleAfterSeconds` (120). So `watch` writes a `relay-heartbeat` row every `heartbeatSeconds` (60) from `spec/arkiv.json`, whether or not the log changed, on its own timer apart from `--every`. The first is written right after the first pass; if that pass already ends the watch, unlock is over and none is written. Heartbeats stop when the loop does, by the rules below.

Each heartbeat carries the `entriesHash` of the newest log the relay has seen for this exam in this run (from the TEE or storage, the one with the most entries; none if it has seen none) and the TEE's stage when the TEE serves this exam (none otherwise; a TEE that didn't answer leaves the last stage read). These are the writer's word, not evidence: readers only use the row's block and creator. A failed heartbeat is printed and tried again at the next tick; it never stops the loop. Heartbeats are never deduplicated, are `readonly`, not extendable, and expire after `heartbeatLifetimeHours` (24). `--no-heartbeat` turns them off; `mirror` (one pass) never writes one.

## Deduplication and stopping

`@paperseal/arkiv` skips a row this writer already has (the same `examId`, `registry` and `entriesHash`, or the same `instanceKeyHash`). `watch` also remembers what it confirmed, so it doesn't query Arkiv for the same rows every few seconds. `watch` stops only when a TEE that shows this exam says `released` or `failed`, after a pass with no failed writes (or three more tries).

Rows are created `readonly`, extendable by anyone, and live `lifetimeDays` (180) from `spec/arkiv.json`. `chainId` is `chain.chainId` from `spec/constants.json`.

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `RELAY_KEYSTORE` | `paperseal-board` | Foundry keystore name under `~/.foundry/keystores` |
| `RELAY_PASSWORD_FILE` | `~/.paperseal/board-keystore-password` | Password file path, passed to cast and never read by the relay |
| `RELAY_SEPOLIA_RPC` | `https://ethereum-sepolia-rpc.publicnode.com` | Sepolia RPC for `index` and `backup` when `--rpc` is not given |
| `RELAY_SWARM_API` | `swarm.defaultApiUrl` in spec/arkiv.json | Bee API for `backup`, `swarm-status` and `buy-stamp` when `--swarm` is not given |
| `ARKIV_ACCESS_KEY` | unset | Arkiv Hub access key. Without it, `ARKIV_ACCESS_KEY=` in `~/.paperseal/arkiv-relay.env` is used if present, else the public RPC, which is rate limited |

cast is found on `PATH`, else at `~/.foundry/bin/cast`. `status` (with or without `--index`), `backup --dry-run`, `swarm-status`, `buy-stamp` and `dry-check` need no key. `status` without `--writer` runs `cast wallet address`, which prints only the address.

## Safety

- **The index holds only what the registry's events already publish**: exam IDs, hashes, `examStart`, blocks, the board, an ENS name that passed every check, and approved-list entries as the spec's columns (role, `owner`, which for a setter is already its `setterOwner` hash, and SHA-256 hashes of the keys).
- **Only already-public, signed evidence is mirrored**: the release log (`GET /v1/release/log` or `release-log.json`) and the Unlock instance's PKI attestation token (`release-token.jwt` or `GET /v1/attestation`). The relay reads nothing else, so it can't mirror anything else. Questions (even encrypted), setter receipts, keys or submission times, invite secrets, shares and anything not already public never go on Arkiv, because Arkiv is public and permanent. A heartbeat adds nothing else: the exam ID, the registry, the `entriesHash` of a log already public, and the stage the TEE's public `GET /v1/status` shows.
- **The signing key stays in memory.** `mirror` and `watch` run `cast wallet private-key --account <name> --password-file <path>` with stdin closed, and pass its output straight to viem's `privateKeyToAccount`. The key is never printed, logged or written to disk. cast's stdout is never shown, even on failure, and anything key-shaped is cut from its stderr. The relay never opens the password file.
- **The access key is not printed.** It rides in the RPC URL's path, so every line the relay prints, errors included, is redacted for it.
- The relay sends Arkiv transactions only from `mirror`, `watch` (rows, and heartbeats), `index` (exam and participant rows) and `backup` (backup rows, not with `--dry-run`). `index` signs with the same keystore and redacts the access key the same way; it sends nothing to Sepolia, only reads it. Use a dedicated writer address, fund it with Rabdi testnet tGLM, and publish it next to the board's other settings so readers trust its rows.
- `backup` uploads only files the Build's `storageManifestHash` covers, plus the unlock files spec/api.md lists, each already public and encrypted or signed, as an unencrypted collection: an encrypted reference carries its own key and never goes on Arkiv. Arkiv gets only the reference and hashes. Uploads spend the batch's capacity, and `buy-stamp --yes` spends the Bee node's sBZZ and gas; nothing else here touches the Bee wallet.
- Two relays, or two runs of one, at once may both write a row. Readers ignore the duplicate.
