# Arkiv Evidence Mirror

How Paper Seal's public unlock evidence is mirrored to [Arkiv](https://docs.arkiv.network), and how readers check it. Change this file first, then every implementation in the same change. The reasoning is in [the proposal](../docs/proposals/arkiv.md). Values are in `arkiv.json`.

Arkiv is only a mirror. `ExamRegistry`, the TEE's signatures, Google's attestation tokens and the file hashes stay the source of truth, and the TEE never reads Arkiv. A reader accepts nothing from Arkiv that it hasn't checked, so a writer can stay silent but can't make a check pass.

## Network

The network is Arkiv's Rabdi testnet, from `arkiv.json` `network`. Its public RPC allows cross-origin reads without a key, but it is rate limited, so writers should use an access key. Readers may use the public RPC or their own.

## Rows

Each row is an Arkiv entity written through one of two named schemas, `schemas.releaseLog` and `schemas.releaseToken`. Every row is created with the `readonly` flag, so it can never change, and with a lifetime of `lifetimeDays`. The lifetime can be extended by anyone, so the public can keep the evidence alive.

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

The indexed columns only help readers find rows. Every reader parses `body` and checks it, and ignores the other columns where they disagree with it.

## What May Be Mirrored

Only evidence that is already public, and signed by the TEE or Google:

- The release log, from `GET /v1/release/log` or `release-log.json`.
- The PKI attestation token of the Unlock instance, from `release-token.jwt` or `GET /v1/attestation`.

These never go on Arkiv, because Arkiv is public and permanent: questions, even encrypted; setter receipts, keys or submission times; invite secrets; shares; and anything that isn't already public.

## Writers

A writer, which the code calls the relay, reads the TEE and public storage and creates a row for each new log or token. A writer doesn't write a log again if it already has a row with the same `examId`, `registry` and `entriesHash`, and the same goes for a token with the same `examId`, `registry` and `instanceKeyHash`. An empty log has the same `entriesHash` in every exam, and one instance can run Unlock for several exams, so the hash alone isn't enough. The check runs before the write, so two runs of one writer at once may both write. Readers ignore the duplicate.

Anyone can write to Arkiv, so readers only read rows whose `$creator` is a published writer address. The board publishes its writers' addresses next to its other settings, and a viewer can add their own. Only the creator counts, not the owner, because ownership can be handed over.

## Reading

To show unlock progress from Arkiv, a reader:

1. Finds the `release-token` rows for the exam from published writers, and checks each `body` as a published token, exactly like `release-token.jwt` from storage. A token that passes attests its instance public key.
2. Finds the `release-log` rows for the exam from published writers, parses each `body` like `release-log.json`, and checks its `teeSignature` under an instance key that step 1 attested. A log signed by any other key is ignored.
3. Shows the verified log with the most entries. Logs only grow, so a verified log with fewer entries is an earlier snapshot.
4. Shows when the newest row was written. If that was more than `staleAfterSeconds` ago and unlock isn't over, it warns that the mirror has stopped, and never treats silence as proof that nothing happened.

When the TEE is also reachable, the reader shows whichever verified log has more entries, and says where each came from. Two verified logs never conflict, because both are signed by an attested key.
