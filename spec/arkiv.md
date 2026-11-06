# Arkiv Evidence Mirror

How Paper Seal's public unlock evidence is mirrored to [Arkiv](https://docs.arkiv.network), and how readers check it. Change this file first, then every implementation in the same change. The reasoning is in [the proposal](../docs/proposals/arkiv.md). Values are in `arkiv.json`.

Arkiv is only a mirror. `ExamRegistry`, the TEE's signatures, Google's attestation tokens and the file hashes stay the source of truth, and the TEE never reads Arkiv. A reader accepts nothing from Arkiv that it hasn't checked, so a writer can stay silent but can't make a check pass.

## Network

The network is Arkiv's Rabdi testnet, from `arkiv.json` `network`. Its public RPC allows cross-origin reads without a key, but it is rate limited, so writers should use an access key. Readers may use the public RPC or their own.

## Rows

Each row is an Arkiv entity written through one of the named schemas in `schemas`. Every row is created with the `readonly` flag, so it can never change. Evidence rows live for `lifetimeDays`, and anyone can extend them, so the public can keep the evidence alive.

`paperseal.v1.release-log` holds one signed release log, exactly as the TEE returned it:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `chainId` | `u64` | No | That registry's chain, `chain.chainId` in `constants.json` |
| `entriesHash` | `str` | Yes | The log's `entriesHash`, lowercase `0x` hex |
| `released` | `i32` | No | The number of entries in the log |
| `body` | `bytes` | No | The exact bytes of the `GET /v1/release/log` body, or of `release-log.json` in storage |

`paperseal.v1.release-token` holds one PKI attestation token of the instance that ran Unlock:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `chainId` | `u64` | No | That registry's chain |
| `instanceKeyHash` | `str` | Yes | The SHA-256 of the token's instance public key, lowercase `0x` hex |
| `body` | `bytes` | No | The exact bytes of `release-token.jwt`, or of a PKI token from `GET /v1/attestation` on the Unlock instance |

`paperseal.v1.relay-heartbeat` says that a writer is still running. It isn't evidence, and it never counts toward progress:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `entriesHash` | `str` | No | The `entriesHash` of the newest log the writer has seen, or empty if it has seen none |
| `stage` | `str` | No | The TEE stage the writer last read, or empty |

A heartbeat lives for `heartbeatLifetimeHours` and can't be extended, so heartbeats clean themselves up.

The indexed columns only help readers find rows. Every reader parses `body` and checks it, and ignores the other columns where they disagree with it.

## What May Be Mirrored

Only data that is already public. As evidence, only what the TEE or Google signed:

- The release log, from `GET /v1/release/log` or `release-log.json`.
- The PKI attestation token of the Unlock instance, from `release-token.jwt` or `GET /v1/attestation`.

For the exam index, only what `ExamRegistry`'s events already publish, plus an exam's ENS name once it passes its checks ("Exam Index").

These never go on Arkiv, because Arkiv is public and permanent: questions, even encrypted; setter receipts, keys or submission times; invite secrets; shares; and anything that isn't already public.

For backups ("Backups" below), Swarm may also hold a copy of the exam's files in public storage. That includes the encrypted paper and the shares, each already encrypted to its holder, but only the files the exam's on-chain `storageManifestHash` covers, and the unlock files the signed release log covers. Arkiv then holds only a Swarm reference and hashes, never a file. Questions, setter data and invite secrets go on neither.

## Writers

A writer, which the code calls the relay, reads the TEE and public storage and creates a row for each new log or token. A writer doesn't write a log again if it already has a row with the same `examId`, `registry` and `entriesHash`, and the same goes for a token with the same `examId`, `registry` and `instanceKeyHash`. An empty log has the same `entriesHash` in every exam, and one instance can run Unlock for several exams, so the hash alone isn't enough. The check runs before the write, so two runs of one writer at once may both write. Readers ignore the duplicate.

While it watches an exam during unlock, a writer also writes a heartbeat every `heartbeatSeconds`, whether or not the log has changed. It stops when unlock is over.

Anyone can write to Arkiv, so readers only read rows whose `$creator` is a published writer address. Only the creator counts, not the owner, because ownership can be handed over. Readers check every row anyway, so the writer list only keeps out spam and noise; a writer can stay silent, but it can't make a check pass.

A board publishes its writers in the `ens.records.arkivWriters` text record of the exam's ENS name ("Exam Names" in `api.md`), as addresses separated by commas. A viewer can add their own writers, and a build can set defaults. To rotate, the board edits the record: a reader uses the writers listed now, plus the viewer's own. Rows from a retired writer stay valid evidence, because each row is checked by its signatures, but readers stop asking for them unless the viewer still lists that writer. Neutral parties can run their own relays, and a viewer who trusts them adds their addresses.

## Reading

To show unlock progress from Arkiv, a reader:

1. Finds the `release-token` rows for the exam and its registry from published writers, and checks each `body` as a published token, exactly like `release-token.jwt` from storage. A token that passes attests its instance public key.
2. Finds the `release-log` rows for the exam from published writers, parses each `body` like `release-log.json`, and checks its `teeSignature` under an instance key that step 1 attested. A log signed by any other key is ignored.
3. Shows the verified log with the most entries. Logs only grow, so a verified log with fewer entries is an earlier snapshot.
4. While unlock is open, takes the newest heartbeat or log row from published writers as the mirror's last sign of life, timed by Arkiv's own blocks (`createdAt` against the latest block), not the device clock. If that is more than `staleAfterSeconds` old, it warns that the mirror has stopped. If there is none at all, it says no writer has written for this exam since unlock opened. Either way it never treats silence as proof that nothing happened.

When the TEE is also reachable, the reader shows whichever verified log has more entries, and says where each came from. Two verified logs never conflict, because both are signed by an attested key.

## Exam Index

`ExamRegistry` can find one exam by its ID but can't list exams, so nobody can browse a board's exams without an indexer. The index is a copy, on Arkiv, of what the registry's events already say in public. A reader checks every row against Sepolia, so the index only helps people find exams; it never decides what an exam is.

### Rows

`paperseal.v1.exam` describes one exam in one registry:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `board` | `addr` | Yes | That registry's `board()` |
| `chainId` | `u64` | No | The registry's chain |
| `stage` | `str` | Yes | `published`, `listed` or `built`, the furthest of `ExamCreated`, `ApprovedListPosted` and `BuildPosted` seen |
| `examStart` | `u64` | Yes | `T`, in Unix seconds, so readers can filter and sort by date |
| `createdBlock` | `u64` | No | The block of `ExamCreated` |
| `criteriaHash` | `str` | No | From `ExamCreated` |
| `approvedListHash` | `str` | No | From `ApprovedListPosted`, or empty |
| `paperHash` | `str` | No | From `BuildPosted`, or empty |
| `name` | `str` | No | The exam's ENS name, or empty. It is set only when that name passes every check in "Exam Names" in `api.md` and resolves to this exam ID and registry |

An exam row is not `readonly`. Its writer patches it as the exam moves on, and the stage only moves forward. It lives for `lifetimeDays`, and anyone can extend it.

`paperseal.v1.participant` describes one entry of an exam's approved list:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `role` | `str` | Yes | `setter`, `neutral`, `centre-holder` or `centre`, for list roles 1 to 4 |
| `owner` | `str` | Yes | The entry's `owner`. For a setter this is already its `setterOwner` hash, so no setter's name is ever indexed |
| `passkeyKeyHash` | `str` | Yes | The SHA-256 of the entry's `passkeyPublicKey`, lowercase `0x` hex |
| `derivedKeyHash` | `str` | No | The SHA-256 of `derivedPublicKey`, or empty for a setter |

A participant row is `readonly`, because the approved list is written once. It lives for `lifetimeDays`, and anyone can extend it. An `owner` longer than 128 bytes can't fit a `str`, but `limits.ownerBytes` in `constants.json` is 128, so every owner on a valid list fits.

### Writing

An indexer reads `ExamCreated`, `ApprovedListPosted` and `BuildPosted` from the registry in ranges of at most `logChunkBlocks` blocks, because public RPCs refuse wider log queries. Then:

- It writes one exam row per exam that has none from this writer, and patches the row when its stage, hashes or name change.
- It writes one participant row per approved-list entry that has no row from this writer with the same `examId`, `registry` and `passkeyKeyHash`. It decodes the entries with the same rules as every other reader of the approved list, and writes nothing for a list that fails them.
- It writes an exam's name only after checking that name in full, as "Exam Names" in `api.md` says. The registry only stores the name's hash, so names come from the board.

Index rows only ever hold data the registry's events already make public.

### Reading

To list a registry's exams, a reader:

1. Finds the `exam` rows for the registry from published writers. Rows for other registries are never requested.
2. For each row, reads `getExam`, `getApprovedList` and `getBuild` from Sepolia, through the viewer's own RPC. It shows an exam only if `getExam` has it with the same `examStart` and `criteriaHash`. It shows the stage that Sepolia shows, and says when the row is behind. A row for an exam that isn't on chain is ignored and counted.
3. Shows a name only after checking it again, as in "Exam Names". A name that fails is ignored, and the exam is shown by its ID.
4. Says that the list holds only the exams its writers have indexed, so a missing exam isn't proof that the exam doesn't exist.

To find exams by participant, a reader looks up `participant` rows by `owner` or `passkeyKeyHash`. It shows an exam only if that entry is in the exam's approved list on Sepolia, which `getApprovedListEntries` reads and checks against the list hash.

## Backups

The board's bucket holds every file an exam needs: the encrypted paper, `K_pub`'s timelock, each key holder's encrypted share, and, after unlock, the centres' copies of `K_priv`. If that bucket fails or is emptied at `T−Δ`, holders can't release and centres can't open the paper. A backup keeps a second copy on [Swarm](https://docs.ethswarm.org), where a file's address is its own hash and the board can't delete it. Arkiv records where the backup is, so anyone can find it by exam ID.

### What Is Backed Up

One Swarm collection per exam, holding the exam's storage files under the same names as in the bucket (`api.md`, "Storage"):

- **Before unlock:** `manifest.json` and every file it lists. The manifest must hash to the Build's `storageManifestHash` on Sepolia, and each file must match its `sha256` in the manifest.
- **After unlock:** a second collection that also holds `release-log.json`, `release-token.jwt`, `key-priv.tlock` and `key-priv/*`. The signed release log covers `release-log.json` itself, and `release-token.jwt` binds the log's signer to the exam. The signed log lists the hash of `key-priv.tlock` and of each `key-priv/*` (`files`, covered by `filesHash`), so a backup copy is checked against that list. Each is also authenticated encryption, and the paper's salted hash check catches any wrong key.

Every file is already public, and already encrypted or signed, so it is uploaded as a plain, unencrypted Swarm collection. An encrypted Swarm reference contains its own decryption key, so one never goes on Arkiv.

### Rows

`paperseal.v1.backup` records one Swarm collection:

| Column | Type | Indexed | Holds |
| --- | --- | --- | --- |
| `examId` | `str` | Yes | The exam ID, lowercase `0x` hex |
| `registry` | `addr` | Yes | The `ExamRegistry` the exam is in |
| `phase` | `str` | Yes | `build`, for the files the Build covers, or `unlock`, which adds the unlock files |
| `swarmRef` | `str` | Yes | The collection's Swarm reference, 64 lowercase hex characters with no `0x` |
| `swarmNetwork` | `str` | No | `swarm.network` in `arkiv.json`: `sepolia` here, `mainnet` once the build moves |
| `manifestHash` | `str` | No | The SHA-256 of the collection's `manifest.json`, lowercase `0x` hex |
| `files` | `i32` | No | The number of files in the collection |
| `batchId` | `str` | No | The postage batch the upload was stamped with, lowercase hex |

A backup row is `readonly`. It lives for `lifetimeDays`, and anyone can extend it. A writer doesn't write a second row for the same `examId`, `registry`, `phase` and `swarmRef`.

### Writing

A backup writer reads `manifest.json` from public storage. It checks the manifest against the Build's `storageManifestHash`, downloads each file it lists, and checks each one against the manifest's `sha256`. For `unlock`, it checks each unlock file as far as anything can be checked before the end round:
- `release-token.jwt` passes the same check readers apply to it (Google's PKI signature and the claims bound to the on-chain exam), and attests the log's `instancePublicKey`.
- `release-log.json` parses with no unknown fields, is for this exam, has an `entriesHash` that recomputes from its entries, and has a valid `teeSignature` under that attested key.
- The log's `filesHash` matches its `files`, which list exactly `key-priv.tlock` and one `key-priv/*` per approved centre, and each file has the hash listed.
- `key-priv.tlock` is a timelock ciphertext for the exam's `endRound`.
- There is one `key-priv/<derivedPublicKey>.bin` per approved centre (list roles 3 and 4), each exactly the size of an HPKE `keyPriv` sealing a 32-byte key.

A file that fails stops the upload, and nothing is written. Every file must also fit a size cap: the manifest's own size for the files it lists, and a few KiB for the unlock files. If storage has `release-log.json` but not yet all the unlock files, the writer backs up the `build` phase instead. Nothing that hasn't passed these checks reaches Swarm. Then the writer uploads the collection through a Bee node, stamped with a postage batch it controls, and writes the backup row.

### Reading

A reader uses a backup only when the bucket can't give it a file, or gives it one that fails its hash:

1. It finds the `backup` rows for the exam and registry from published writers, preferring `unlock` over `build`, and the newest first.
2. It reads `manifest.json` from the collection through the viewer's own Swarm API, which defaults to `swarm.defaultApiUrl`. It uses the collection only if the manifest hashes to the Build's `storageManifestHash` on Sepolia.
3. It reads the file it needs from the collection and checks it against its hash in the manifest. For unlock files, it applies the same checks it applies to the bucket's copies: the release log's signature, the token, and finally the decryption and the paper's salted hash. A file that fails is ignored, exactly as if the bucket had served it, and the reader tries the same file from the next backup row. A backup file that fails is never shown as a failure of the exam; only the bucket's own copies can fail a check.
4. It says which files came from the Swarm backup. A backup that can't be read isn't treated as a failure of the exam, only as "not read".

A reader may also read a backup just to show whether it holds a copy that passes, through the same checks as a copy in the bucket. What it finds is shown as that copy's own state and goes no further: it never decides a check, and it never replaces a file the bucket gave.

