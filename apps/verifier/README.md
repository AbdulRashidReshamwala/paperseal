# Paper Seal verifier

The public verifier, on port 5172, with no sign-in. `pnpm build` writes `dist/` with relative paths, so it can be hosted from any domain or folder.

`VITE_RPC_URL`, `VITE_TEE_URL`, `VITE_STORAGE_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` set build-time defaults. Viewers can replace them under "Check it yourself", and the values stay in their browser.

`VITE_RELEASES_REPO` is optional. It is the `owner/name` GitHub repository the code, rebuild and self-hosting links point at, `AbdulRashidReshamwala/paperseal` when unset, so a fork can set its own. Any other shape is an error. Viewers cannot change it.

Browsers only allow these calls if the RPC and TEE send cross-origin headers for the hosting domain.

The Overview leads with chain checks, which need only the RPC URL, registry address and exam ID. The TEE URL is optional. It adds fresh attestation, the release log and live release progress.

`#/name/<ENS name>`, or a name typed into the exam box, such as `jee-main-2026.board.eth`, checks the exam by name first, as in "Exam Names" in `spec/api.md`. Step 1, Exam name, reads ENS on-chain through the viewer's own RPC and fails unless the whole name is normalised and the exam part is a valid exam name, the code at the name's address is exactly `ExamRegistry`'s with that registry's board filled in, and that board has the parent as its primary name both ways. Its failures are titled "Not a valid name", "No registry", "Primary name differs", "Not verified both ways" and "Can't read ENS". Every chain read has CCIP-Read off, the later `ExamRegistry` reads included, so no offchain gateway is ever asked. Only then does the page read the exam, with the name's registry and its exam ID, the labelhash of the exam part. The name's TEE, storage and bucket records are used for that view only, and any it leaves out fall back to the viewer's own settings and, for the bucket, `VITE_TEE_STORAGE_BUCKET`. Nothing from a name is saved. A Sepolia name is only a demo, because anyone can register a look-alike there.

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
