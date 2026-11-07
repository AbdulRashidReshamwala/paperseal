# How We Use Arkiv

## What We Filter On

| Filter | Why | What users see |
| --- | --- | --- |
| `examId` | Every reader looks at one exam | The verifier's step 6 for that exam |
| `$creator` is a trusted writer | Anyone can write rows, so we read only from published writers | Rows from strangers never appear |
| `entriesHash`, `instanceKeyHash` | The relay checks these before writing, so each copy is written once | One row per copy, no spam |
| `registry` | Lists a registry's exams, which `ExamRegistry` can't do. Also keeps the same exam ID in two registries apart | `#/exams`: every exam, newest first, each checked against Sepolia |
| `examStart` | People look for an exam by date | Dates in the exam list |
| `owner` | A centre or key holder wants every exam they're on | "Find exams by person": `centre-1` finds 6 exams |
| `examId` and `phase` on backups | When the bucket fails, the verifier looks for that exam's Swarm backup | The "Backup on Swarm" block in a step's evidence |

## Who Can Edit Each Entity

**Nobody**, for evidence, participant, backup and heartbeat rows. They are `readonly`, because the record of an unlock must not change.

Exam rows are the one exception. Their writer updates the stage as the exam moves from published to listed to built, and only ever forward. The verifier shows the stage from Sepolia, and says "The Arkiv copy is behind" when the row lags.

Readers trust a row's creator, not its owner, because an owner can hand a row over.

## When It Expires

- **Evidence: 180 days.** That covers results, rechecks and appeals. Anyone can extend it (`permissionlessExtension`). The explorer shows "expires in ~179d 23h".
- **Heartbeats: 24 hours, and can't be extended.** They say "the relay is alive right now", which is useless a day later.

## How Each Feature Changes What Users See

- **Reading rows.** With the board's TEE and storage both off, step 6 still shows "8 of the 8 needed key holders have released. Read from the copy on Arkiv. Every row shown passed its check." It lists each key holder, the entity, an explorer link and when the row was written.
- **The signed token row.** The verifier checks Google's signature on it against the exam on Sepolia before it trusts any log.
- **Heartbeats and block time.** The relay writes a heartbeat every 60 seconds. The verifier compares the newest row's time with Arkiv's latest block, not the viewer's clock. If the copy stops, it warns. If unlock is open and nothing was ever written, it says no relay has written. Silence never shows as "nobody released".
- **Writers from ENS.** When an exam is opened by its ENS name, the verifier reads the writers from the name's `paperseal.arkiv-writers` record, so a board can change writers without a new build.
- **Rows that fail a check** are counted under "Rows ignored" and never change the progress.

## Run It

Copy an exam's unlock record to Arkiv:

```bash
node relay/cli.mjs mirror --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --registry 0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams
```

See what is on Arkiv for that exam:

```bash
node relay/cli.mjs status --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --writer 0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
```
