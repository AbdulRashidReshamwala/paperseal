# Schema

What Paper Seal stores on Arkiv's Rabdi testnet, how we search it, who owns it and when it expires.

The code: [`packages/arkiv`](../packages/arkiv) (schemas, reader, writer), [`relay/`](../relay) (writes the data) and [`apps/verifier`](../apps/verifier) (reads it for users). The full rules are in [`spec/arkiv.md`](../spec/arkiv.md).

## Entities

| Schema | One per | Holds |
| --- | --- | --- |
| `paperseal.v1.release-log` | Copy of the release log | Who has released their key share, signed by the TEE. The exact bytes the TEE gave |
| `paperseal.v1.release-token` | Unlock machine | Google's signed token: which code the machine runs and which key it signs with |
| `paperseal.v1.exam` | Exam | Stage, start time, hashes and ENS name, copied from `ExamRegistry`. The only kind its writer updates |
| `paperseal.v1.participant` | Person on an exam's approved list | Role, owner and key hashes. A setter's owner is already a hash |
| `paperseal.v1.backup` | Swarm backup of an exam's files | Where the backup is: the Swarm reference, the manifest hash and the postage batch ([`swarm.md`](swarm.md)) |
| `paperseal.v1.relay-heartbeat` | Minute the relay is watching an unlock | That the relay is alive. Never counts as evidence |

## Fields We Search On

| Field | Type | Used for | On |
| --- | --- | --- | --- |
| `examId` | `str` | Every query: "this exam" | All |
| `registry` | `addr` | Keeps exams from different registries apart, and lists a registry's exams | All |
| `entriesHash`, `instanceKeyHash` | `str` | The writer checks these first, so it never writes the same thing twice | Logs, tokens |
| `stage` | `str` | Filter exams by how far they got | Exams |
| `examStart` | `u64` | Sort and filter exams by date | Exams |
| `board` | `addr` | Filter exams by board | Exams |
| `role`, `owner`, `passkeyKeyHash` | `str` | "Which exams is this person on?" | Participants |
| `phase` | `str` | Unlock files are only read from an `unlock` backup | Backups |
| `swarmRef` | `str` | The Swarm reference, 64 hex characters, never an encrypted one. Also the duplicate check | Backups |
| `$creator` | built in | Read only from writers we trust | All |

Other fields are stored but not searched: `chainId`, `released`, `body` (the signed bytes), `createdBlock`, `criteriaHash`, `approvedListHash`, `paperHash`, `name`, `derivedKeyHash`, `swarmNetwork`, `manifestHash`, `files` and `batchId`.

Readers always check `body` against Sepolia, and never trust the other fields over it.

## Who Owns and Edits Them

- The relay's wallet creates and owns every entity.
- Readers trust a row by its `$creator`, not its owner, because an owner can hand a row over.
- Evidence, participant, backup and heartbeat rows are `readonly`. Nobody can change them, not even their owner.
- Exam rows are the one exception. The writer updates the stage as the exam moves on. The verifier still takes the stage from Sepolia.

## When They Expire

| Rows | Lifetime | Why |
| --- | --- | --- |
| Logs, tokens, backups | 180 days, and anyone can extend them (`permissionlessExtension`) | Covers results and appeals. Just under Arkiv's limit of about 182 days |
| Heartbeats | 24 hours, can't be extended | They only matter while an unlock is running |

## Writer

| Wallet | Role |
| --- | --- |
| [`0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`](https://rabdi.explorer.arkiv.network/address/0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b) | The team's relay wallet for the demo |

A board publishes its writers in the `paperseal.arkiv-writers` record of the exam's ENS name, and can change them there. Viewers can add their own.
