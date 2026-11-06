# Paper Seal verifier

The public verifier, on port 5172, with no sign-in. `pnpm build` writes `dist/` with relative paths, so it can be hosted from any domain or folder.

`VITE_RPC_URL`, `VITE_TEE_URL`, `VITE_STORAGE_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` set build-time defaults. Viewers can replace them under Connection, and the values stay in their browser.

`VITE_RELEASES_REPO` is optional. It is the `owner/name` GitHub repository the code, rebuild and self-hosting links point at, `AbdulRashidReshamwala/paperseal` when unset, so a fork can set its own. Any other shape is an error. Viewers cannot change it.

Browsers only allow these calls if the RPC and TEE send cross-origin headers for the hosting domain.

The Overview leads with chain checks, which need only the RPC URL, registry address and exam ID. The TEE URL is optional. It adds fresh attestation, the release log and live release progress.

`#/name/<ENS name>`, or a name typed into the exam box, such as `jee-main-2026.board.eth`, checks the exam by name first, as in "Exam Names" in `spec/api.md`. Step 1, Name, reads ENS on-chain through the viewer's own RPC and fails unless the exam part is a valid exam name, the name's address is an `ExamRegistry`, and that registry's board has the parent as its primary name both ways. Only then does the page read the exam, with the name's registry and its exam ID, the labelhash of the exam part. The name's TEE, storage and bucket records are used for that view only, and any it leaves out fall back to Connection and, for the bucket, `VITE_TEE_STORAGE_BUCKET`. Nothing from a name is saved. A Sepolia name is only a demo, because anyone can register a look-alike there.

`VITE_STORAGE_URL` is the public bucket's base URL, and files are read from `<URL>/<exam ID>/`. It adds the published attestation token, the storage manifest, the release log and the post-exam proof. drand is read from `api.drand.sh`, pinned to quicknet's chain hash and public key.
