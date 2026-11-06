# How We Use Arkiv

## Filters

| Filter | Why | What users see |
| --- | --- | --- |
| `examId` (indexed `str`) | Every reader looks at one exam | The verifier's step 6 for that exam |
| `$creator` in the trusted writers | Anyone can write rows, so we read only from published writers | "Writers read" in the evidence, and rows from strangers never appear |
| `entriesHash` / `instanceKeyHash` (indexed `str`) | The relay checks for these before it writes, so a snapshot is written only once | One row per log snapshot, and no spam |
| `registry` (indexed `addr`) | The same exam ID can't be mixed up across registries | Rows belong to the registry the page reads |

## Who Can Edit Each Entity

Nobody. Rows are `readonly`, and that is the point: the record of an unlock must not change. The owner is the relay's wallet, but readers trust the creator, not the owner, because ownership can be handed over.

## When It Expires

After 180 days, which covers results, rechecks and appeals. `permissionlessExtension` lets anyone extend it after that. The explorer shows "expires in ~179d 23h" for each row.

## How Each Feature Changes What Users See

- **Reading rows.** With the board's TEE and storage both unreachable, step 6 still shows "8 of the 8 needed key holders have released. Read from the copy on Arkiv. Every row shown passed its check." It lists each holder, the entity key, an explorer link and when the row was written.
- **The signed token row.** The verifier checks Google's signature on it against the on-chain exam before it trusts any log. The evidence shows "Release log signed by a key a passing release token attests: Pass".
- **Block timing.** `getBlockTiming` against `$createdAt` drives the warning "The Arkiv copy stopped updating N minutes ago", so silence is never shown as "nobody released".
- **Rows that don't verify** are counted under "Rows ignored" and never move the progress.

## Run It

```bash
node relay/cli.mjs mirror --exam 0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295 --registry 0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8 --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams
```

```bash
node relay/cli.mjs status --exam 0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295 --writer 0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
```
