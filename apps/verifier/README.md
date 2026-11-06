# Paper Seal verifier

The public verifier, on port 5172, with no sign-in. `pnpm build` writes `dist/` with relative paths, so it can be hosted from any domain or folder.

`VITE_RPC_URL`, `VITE_TEE_URL`, `VITE_STORAGE_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` set build-time defaults. Viewers can replace them under "Check it yourself", and the values stay in their browser.

`config.json` beside `index.html` is read before the page renders, as in "App config.json" in `spec/deploy.md`, so one build works for every board: overwrite `dist/config.json` to point it at yours. The build writes it from its `VITE_` values, with empty ones left out. Each value resolves as `VITE_` first, then `config.json`, then the built-in default, and a viewer's own settings under "Check it yourself" override all three, the bucket included.

A missing or invalid file counts as empty. Its `chainId` and `chainName` only describe the chain, are dropped when they name another chain than `spec/constants.json`, and never switch it. Mock mode never reads the file.

`VITE_TEE_STORAGE_BUCKET`, or `storageBucket` in `config.json`, is the bucket the TEE's token must name. Viewers can change it under "Check it yourself" too.

`VITE_RELEASES_REPO` is optional. It is the `owner/name` GitHub repository the code, rebuild and self-hosting links point at, `AbdulRashidReshamwala/paperseal` when unset, so a fork can set its own. Any other shape is an error. `config.json`'s `repository` sets it too. Viewers cannot change it.

Browsers only allow these calls if the RPC and TEE send cross-origin headers for the hosting domain.

The Overview leads with chain checks, which need only the RPC URL, registry address and exam ID. The TEE URL is optional. It adds fresh attestation, the release log and live release progress.

`#/name/<ENS name>`, or a name typed into the exam box, such as `jee-main-2026.board.eth`, checks the exam by name first, as in "Exam Names" in `spec/api.md`. Step 1, Name, reads ENS on-chain through the viewer's own RPC and fails unless the whole name is normalised and the exam part is a valid exam name, the code at the name's address is exactly `ExamRegistry`'s with that registry's board filled in, and that board has the parent as its primary name both ways. Its failures are titled "Not a valid name", "No exam record", "Not the board’s name", "Not confirmed by the board" and "Can't read the name". Every chain read has CCIP-Read off, the later `ExamRegistry` reads included, so no offchain gateway is ever asked. Only then does the page read the exam, with the name's registry and its exam ID, the labelhash of the exam part. The name's TEE, storage and bucket records are used for that view only, and any it leaves out fall back to the viewer's settings under "Check it yourself" and, for the bucket, `VITE_TEE_STORAGE_BUCKET`. Nothing from a name is saved. A Sepolia name is only a demo, because anyone can register a look-alike there.

`VITE_STORAGE_URL` is the public bucket's base URL, and files are read from `<URL>/<exam ID>/`. It adds the published attestation token, the storage manifest, the release log and the post-exam proof. drand is read from `api.drand.sh`, pinned to quicknet's chain hash and public key.

## Arkiv copy

The page can also read the release evidence that a relay copies to Arkiv, as in "Reading" in `spec/arkiv.md`. Arkiv is only a copy, so unlock progress keeps showing when the TEE can't be reached, and nothing from Arkiv counts until it passes the checks below.

`VITE_ARKIV_WRITERS` holds the writer addresses the board publishes, comma-separated, as the build-time default. The Arkiv RPC URL defaults to `network.rpcUrl` in `spec/arkiv.json`, Rabdi's public RPC, which allows cross-origin reads without a key. Viewers can change both under "Check it yourself". A writer written in mixed case must have a valid checksum.

On a `#/name/` route, the writers read are the ones the name's `arkivWriters` record lists now, plus the viewer's own, each once and checksummed. Without a name they are the viewer's own. With no writers at all, the Arkiv copy is off and nothing is read from Arkiv. The evidence tags each writer "From the name", "Your own choice" or "Built into this page", and shows any record entries that are not addresses as a quiet note.

Once an exam ID is known and writers are set, the page reads the exam's `release-token`, `release-log` and `relay-heartbeat` rows from those writers only, for the registry this view reads, as often as the live TEE:

- Each token row's body is checked exactly like `release-token.jwt` in storage, with the same claims from the exam on `ExamRegistry`. A token that passes attests the instance key of a log it is checked against.
- Each log row's body is parsed like `release-log.json`, and counts only if its `teeSignature`, `entriesHash` and exam ID pass under a key that a passing token attested.
- The verified log with the most entries is shown. Rows that don't verify are counted under "Rows ignored", never shown as progress, and never fail the exam. The indexed columns are only used to find rows.
- Step 6 shows the verified progress with the most releases among the TEE, storage and Arkiv, and says which one it came from. Its evidence lists the writers, the log's entity key with a link to the Arkiv explorer, when it was written, the rows ignored, and the newest heartbeat's time and the stage it names.
- Heartbeats only say a writer is running. They never count toward progress and never fail anything.
- The mirror's last sign of life is its newest heartbeat or log row. Its age is the distance from Arkiv's latest block, at 2 seconds a block, and never uses this device's clock. While unlock is open, an age over `staleAfterSeconds` in `spec/arkiv.json` warns that the copy has stopped updating, and no heartbeat or log row at all says that no relay has written for this exam since unlock opened. Silence is never treated as proof that nothing happened.
- An Arkiv read that fails shows as not read, never as a failed check.

## Swarm backup

The page can read the exam's files from a backup on Swarm when the bucket loses them, as in "Backups", "Reading" in `spec/arkiv.md`. The backup is only a second copy, and a file from it counts only after it passes the same checks as a bucket file.

The Swarm API URL defaults to `swarm.defaultApiUrl` in `spec/arkiv.json`, the viewer's own Bee node at `http://127.0.0.1:1633`. Viewers can change it under "Check it yourself", and an empty one turns the backup off. Backups are found with the same Arkiv node and writers as the Arkiv copy, so with no writers nothing is read either.

- The bucket is always read first. Swarm is read only for a file the bucket doesn't have or can't serve, or one that fails its hash: `manifest.json` against the Build's `storageManifestHash`, and any file the manifest lists against its `sha256` there. While the bucket works, nothing is read from Arkiv or Swarm.
- It finds the exam's `backup` rows from those writers, for the registry this view reads, `unlock` before `build` and newest first. Nothing is read until the Build is on the public record.
- A collection is used only if its row's `manifestHash` and the SHA-256 of its own `manifest.json` both equal the Build's `storageManifestHash`. A file the manifest lists must match its `sha256`. A collection or file that fails is ignored and the next row is tried.
- The unlock files, `release-log.json`, `release-token.jwt`, `key-priv.tlock` and `key-priv/*`, come only from an `unlock` collection. Nothing hashes them, so each backup copy is tried in row order and the first that passes the page's own check is used: the token against the on-chain exam and the log's key, the release log under the key that token attests, and `key-priv.tlock` by opening the paper and matching the Build's `saltedPaperHash`. A copy that fails is ignored and the next row is tried. It is listed in the evidence with its Swarm reference and why, and it never fails the step. If no copy passes, the file shows as not read from the backup.
- If no backup passes, the bucket's own answer stands, so a bucket file that fails still fails its check. Only the bucket's own copies can fail a check.
- Swarm content never changes under a reference, so each file read is kept for the visit.
- Steps 2, 5, 6 and 7 say which of their files came from the backup, with the Swarm reference, the backup row's entity key and its link to the Arkiv explorer, and a link to `<Swarm API>/bzz/<reference>/<file>`. A backup that Arkiv or Swarm can't serve shows as not read, never as a failed check.

## Exam history

`#/exams` lists the exams in the viewer's registry that the viewer's Arkiv writers have indexed, as in "Exam Index" in `spec/arkiv.md`, "Reading". The main page links to it under the exam box. It uses the same settings as the rest of the page: the RPC URL and registry address under "Check it yourself", the Arkiv RPC URL, and the viewer's own Arkiv writers. Without a registry or without writers it explains what to add and reads nothing. It reads once when opened, and again when the viewer presses "Read again".

- It asks Arkiv only for `exam` rows for this registry from these writers, then reads `getExam`, `getApprovedList` and `getBuild` for each exam through the viewer's RPC. An exam is listed only if `getExam` has it with the same `examStart` and `criteriaHash`. Rows for an exam not on chain, rows that differ, and rows that can't be read are ignored and counted in a folded note. An exam whose Sepolia reads fail, as when a public RPC answers 429, is shown on its own as "Could not be read yet", with no stage or time claimed and the reason folded under Details. It is counted apart from the ignored rows, never shown as a failure, and never stops the other exams. "Read again" retries it.
- The stage shown is the registry's: "Exam published", "People approved" or "Paper built and sealed". When no matching row has reached it, a quiet "The Arkiv copy is behind" says so. A row never moves an exam ahead of the registry.
- Each row shows the exam's status, start, how many people are on its list and which copies are recorded. An exam with no paper past its start reads "Never ran", and those are folded under the list. Search and the status filter work on what was read.
- A row's name is shown only after `resolveExamName` passes again and resolves to this exam ID and registry, and then links to `#/name/<name>`. An exam opened by ID moves to that link too. Otherwise the exam shows its ID and links to `#/exam/<id>`, and the failed names are counted.
- Exams are sorted by `examStart`, newest first. The list says that it holds only the exams its writers have indexed, so a missing exam may still exist.
- "Find exams by person" looks up `participant` rows by `owner`, matched exactly as typed. An exam is listed only if `getApprovedListEntries` returns a list, checked against its hash, that decodes under the usual list rules and holds an entry with the row's passkey hash, owner and role. The role is shown in plain words. An exam whose list can't be read yet is shown as not checked, with the reason folded, and searching again retries it. Entries of a list whose bytes differ from the record or break the list rules are ignored and counted separately. Setters are indexed by their `setterOwner` hash, so they can't be found by name.
