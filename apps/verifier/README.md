# Paper Seal verifier

The public verifier, on port 5172, with no sign-in. `pnpm build` writes `dist/` with relative paths, so it can be hosted from any domain or folder.

`VITE_RPC_URL`, `VITE_TEE_URL`, `VITE_STORAGE_URL`, `VITE_REGISTRY_ADDRESS` and `VITE_EXAM_ID` set build-time defaults. Viewers can replace them under Connection, and the values stay in their browser.

Browsers only allow these calls if the RPC and TEE send cross-origin headers for the hosting domain.

The Overview leads with chain checks, which need only the RPC URL, registry address and exam ID. The TEE URL is optional. It adds fresh attestation, the release log and live release progress.

`VITE_STORAGE_URL` is the public bucket's base URL, and files are read from `<URL>/<exam ID>/`. It adds the published attestation token, the storage manifest, the release log and the post-exam proof. drand is read from `api.drand.sh`, pinned to quicknet's chain hash and public key.
