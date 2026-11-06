# How We Use Arkiv

## Filters

| Filter | Why | What users see |
| --- | --- | --- |
| `examId` (indexed `str`) | Every reader looks at one exam | The verifier's step 6 for that exam |
| `$creator` in the trusted writers | Anyone can write rows, so we read only from published writers | "Writers read" in the evidence, and rows from strangers never appear |
| `entriesHash` / `instanceKeyHash` (indexed `str`) | The relay checks for these before it writes, so a snapshot is written only once | One row per log snapshot, and no spam |
| `registry` (indexed `addr`), alone | The exam history page lists a registry's exams, which `ExamRegistry` itself can't do | `#/exams`: 10 exams, newest first, each checked against Sepolia |
| `examStart` (indexed `u64`) | People look for an exam by when it was | The history list's dates. The page sorts by it after reading, and the column is indexed so a date filter works too |
| `owner` (indexed `str`) | A centre or key holder wants every exam they're on | "Find exams by person": `centre-1` finds 6 exams, each checked against that exam's approved list on Sepolia |
| `examId` + `phase` on `paperseal.v1.backup` | When the board's bucket can't give a file, the verifier looks for that exam's Swarm backup, and takes unlock files only from an `unlock` one | The "Backup on Swarm" block in a step's evidence, with links to the files on Swarm and to the Arkiv row |
| `registry` (indexed `addr`) | The same exam ID can't be mixed up across registries | The verifier asks only for rows in the registry it reads, and the token check binds the registry as well |

## Who Can Edit Each Entity

Nobody, for evidence, participant, backup and heartbeat rows. They are `readonly`, and that is the point: the record of an unlock must not change. Exam rows are the one kind their writer can edit (`patchEntity`), because an exam moves from published to listed to built. The relay only ever moves the stage forward. The verifier shows Sepolia's stage, not the row's, and says "The Arkiv copy is behind" when the row lags. The owner is the relay's wallet, but readers trust the creator, not the owner, because ownership can be handed over.

## When It Expires

Evidence rows expire after 180 days, which covers results, rechecks and appeals, and `permissionlessExtension` lets anyone extend them. The explorer shows "expires in ~179d 23h" for each one. Heartbeats expire after 24 hours and can't be extended: they say "the relay is alive right now", which is worthless a day later.

## How Each Feature Changes What Users See

- **Reading rows.** With the board's TEE and storage both unreachable, step 6 still shows "8 of the 8 needed key holders have released. Read from the copy on Arkiv. Every row shown passed its check." It lists each holder, the entity key, an explorer link and when the row was written.
- **The signed token row.** The verifier checks Google's signature on it against the on-chain exam before it trusts any log. The evidence shows "Release log signed by a key a passing release token attests: Pass".
- **Heartbeats and block timing.** While it watches, the relay writes a heartbeat every 60 seconds. The verifier compares the newest heartbeat or log row's `$createdAt` with Arkiv's latest block, not the viewer's clock. If that is too old, it warns that the Arkiv copy stopped updating. If unlock is open and there is nothing at all, it says no relay has written. Silence is never shown as "nobody released".
- **ENS text record for writers.** On a name route (`#/name/jee-main-2026.paperseal-mumbai.eth`), the verifier reads the writers from the name's `paperseal.arkiv-writers` record, so the board publishes and rotates them without a new build.
- **Rows that don't verify** are counted under "Rows ignored" and never move the progress.

## Run It

```bash
node relay/cli.mjs mirror --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --registry 0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams
```

```bash
node relay/cli.mjs status --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --writer 0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
```
