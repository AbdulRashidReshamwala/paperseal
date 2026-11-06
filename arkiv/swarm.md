# Swarm

Paper Seal backs up each exam's public files to Swarm, and records where the backup is on Arkiv, so the files survive if the exam board's bucket goes down or is emptied on exam morning. Today the public verifier uses the backup: with the bucket gone, it still checks the exam and opens the paper. The key holder and centre pages don't use it yet. That comes next, so holders can fetch their encrypted shares, and centres the encrypted paper, from Swarm. The rules are in [`spec/arkiv.md`](../spec/arkiv.md), "Backups".

## What Goes Where

| Where | What | Why there |
| --- | --- | --- |
| **Swarm** | One collection per exam: `manifest.json`, `paper.bin` (the encrypted paper, 1 MiB), `key-pub.tlock`, every `shares/<key>.bin` (each encrypted to its key holder) and `token.jwt`. After unlock it also holds `release-log.json`, `release-token.jwt`, `key-priv.tlock` and every `key-priv/<key>.bin`. That's 25 files, 1.08 MB | The files are large and must be immutable, and the board can't delete them. A file's address is its own hash |
| **Arkiv** | A `paperseal.v1.backup` entity per exam and phase. **`swarmRef` holds the Swarm reference**, next to `manifestHash`, `phase`, `files` and `batchId` | Anyone can find the backup by exam ID, with no help from the board |
| **Sepolia** | The Build's `storageManifestHash` | The source of truth. A backup is used only if its `manifest.json` hashes to it, and each file it lists is used only if it matches its hash in the manifest. Unlock files aren't in the manifest. The relay checks them before uploading (token, log signature, the hashes the signed log lists, timelock round, sizes), and the verifier checks them exactly like the bucket's copies. One that fails is ignored and the next backup is tried |
| **Nowhere** | Questions, setter data, invite secrets | Never mirrored |

Every file is already public and already encrypted or signed, so the collection is uploaded **unencrypted**. Swarm's own encryption would put a decryption key inside the reference, and Arkiv entities are public: the Arkiv writer refuses any 128-character, encrypted reference.

## One Entity and Its Reference

| | |
| --- | --- |
| Arkiv entity | [`0x2d08b220813b576a3a87193723aa31969c22792eef5b5c333f1049f26a9871a8`](https://rabdi.explorer.arkiv.network/entity/0x2d08b220813b576a3a87193723aa31969c22792eef5b5c333f1049f26a9871a8) |
| `swarmRef` | `bae94aa7a550c4d870856306bb0bf68fa366a2e59039de2d48e404b27c527ed6` |
| Exam | `0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3`, on registry `0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb` (Sepolia) |
| Phase | `unlock`, 25 files, 1.09 MB |
| Link | [`https://34-93-7-127.sslip.io/bzz/bae94aa7…7ed6/manifest.json`](https://34-93-7-127.sslip.io/bzz/bae94aa7a550c4d870856306bb0bf68fa366a2e59039de2d48e404b27c527ed6/manifest.json) |
| Verifier | [`https://34-93-7-127.sslip.io/#/exam/0x83b3…c4c3`](https://34-93-7-127.sslip.io/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3) |

**About the link:** the upload is on Swarm's **Sepolia testnet**, which has no public gateway, so we run one for the hackathon: our Bee node behind Caddy, which passes only `GET /bzz/...` and `/health` and refuses every other Bee route, so nobody can upload, buy stamps or touch the node's wallet. It is a temporary VM, so after the event the link opens only through your own testnet Bee node: replace the host with it. Before uploading, the relay checked every file against Sepolia and the signed release log, and after uploading it read `manifest.json` back from Swarm and compared its bytes.

## Postage Batch and Node

| | |
| --- | --- |
| Batch ID | `6b239feebe6cc8efb71eda3dc87c1cc496b93966ed6a04895495c5e5b4829626` |
| Size and life | Depth 18 (about 6.6 MB reliably), 3 days from 2026-11-06, bought for 0.0565 sBZZ |
| Bought by | The Bee node's wallet [`0x1A33528CFA77203027643aB842a26455C68DC329`](https://sepolia.etherscan.io/address/0x1A33528CFA77203027643aB842a26455C68DC329), funded from the team's board wallet `0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b` |
| Uploaded through | Our own Bee 2.8.3 light node on the Swarm Sepolia testnet (`mainnet: false`), first on a laptop, then moved to a GCP VM in Mumbai with its synced state, so it kept its wallet and batch and skipped the first sync |
| Read through | `https://34-93-7-127.sslip.io`, the read-only gateway above, with `cors-allowed-origins: ["*"]`, so a verifier on any domain can read it |

## Code

| File | Does |
| --- | --- |
| [`packages/swarm/src/client.ts`](../packages/swarm/src/client.ts) | Bee HTTP client over plain `fetch`: upload a collection, download a file, stamps, chain state, wallet |
| [`packages/swarm/src/tar.ts`](../packages/swarm/src/tar.ts) | Builds the collection tar. It uses PAX names, because key file names are up to 145 bytes |
| [`packages/arkiv/src/schemas.ts`](../packages/arkiv/src/schemas.ts), [`writer.ts`](../packages/arkiv/src/writer.ts), [`reader.ts`](../packages/arkiv/src/reader.ts) | The `paperseal.v1.backup` entity: write, deduplicate and read |
| [`relay/src/backup.ts`](../relay/src/backup.ts) | Checks every file against Sepolia, uploads, writes the Arkiv row, and reads it back |
| [`relay/src/swarm-node.ts`](../relay/src/swarm-node.ts) | `swarm-status` and `buy-stamp` |
| [`apps/verifier/src/backup.ts`](../apps/verifier/src/backup.ts) | Reads a file from Swarm when the bucket can't give a good one. It finds the backup through Arkiv and checks the manifest against Sepolia and each file against the manifest |

## Run It Yourself

You need a Bee node on the Swarm Sepolia testnet, with a usable postage batch, and this repo after `pnpm install`.

**One upload.** This checks the files, uploads 25 of them, writes the Arkiv row and reads the manifest back:

```bash
node relay/cli.mjs backup --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --registry 0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams --batch <your batch id>
```

You should see `hash … the Build's storageManifestHash on Sepolia`, `uploaded reference …`, `row written` and `read-back manifest.json from Swarm matches`. Writing the row needs a wallet with tGLM on Arkiv (see `relay/README.md`). Re-running with the same files skips the row.

**One read.** The verifier with the board's bucket gone. The quickest way is the hosted verifier: open the Verifier link above, and under "Check it yourself" set "Where the public files are kept" to `https://storage.googleapis.com/paperseal-demo-bucket-gone` and save. To run it locally instead:

1. Put this in `apps/verifier/.env.local`. The storage URL is a bucket that doesn't exist:

   ```bash
   VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
   VITE_REGISTRY_ADDRESS=0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb
   VITE_TEE_STORAGE_BUCKET=paperseal-demo-paperseal-exams
   VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
   VITE_SWARM_API_URL=https://34-93-7-127.sslip.io
   VITE_STORAGE_URL=https://storage.googleapis.com/paperseal-demo-bucket-gone
   ```

2. Run `pnpm --filter @paperseal/verifier dev` and open `http://localhost:5172/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3`.
3. All 7 steps should be done, ending with "The paper is open". Each step's evidence has a "Backup on Swarm" block marking `token.jwt`, `manifest.json`, `paper.bin` and `key-pub.tlock` as "From the Swarm backup, checked against the exam's on-chain record". `release-log.json`, `release-token.jwt` and `key-priv.tlock` also come from Swarm, checked by the same steps as the bucket's copies. Each block links to the files on Swarm and to the Arkiv row. The browser console shows the failed requests to the missing bucket: 42 in our run, while all 7 files came from Swarm.

With your own Bee node instead of the gateway, set `VITE_SWARM_API_URL` to it, and allow the verifier's origin in its config, for example `cors-allowed-origins: ["http://localhost:5172"]`.

## Demo Video

To be added by the team, with the timestamp where the bucket is switched off and the paper opens from Swarm.

## What Got in Our Way

1. **Pruned RPCs break the first sync.** Bee's postage listener failed with `pruned history unavailable` on a popular public Sepolia RPC, because it must read the postage contract from block 6,596,277. Only some free RPCs keep that history: `rpc.sepolia.ethpandaops.io` and `sepolia.gateway.tenderly.co` did. A note in the testnet docs would save hours.
2. **The first testnet sync takes about an hour.** It covers about 5.5 million blocks, at 70,000 to 200,000 blocks a minute. Mainnet has a postage snapshot. A testnet snapshot would make hackathon onboarding much faster.
3. **Bee exits while waiting for funds.** A fresh node gave up after about 3 minutes with `insufficient ETH for deploying chequebook`, and had to be restarted after funding.
4. **The first batch purchase failed on a race.** `POST /stamps` returned `500 cannot create batch`, and the log said `ERC20: insufficient allowance`. The approval was mined a moment later, and the same request then worked.
5. **"Synced" is never exactly the chain tip.** Bee trails the tip by about 5 blocks, by design, so a check for `block == chainTip` never passes. We allow 10.
6. **The price swings while syncing.** `/chainstate` showed 24,618, then 205,334, then 99,788 PLUR per chunk per block during the sync, so quotes were only good once synced.
7. **There is no testnet gateway,** so judges would need their own node. We ran a read-only one on a VM for the event (Caddy in front of Bee, passing only `GET /bzz/*`), but we'd love a public, CORS-enabled testnet gateway, even a rate-limited one.
10. **Moving a node is easy once you know how.** Copying the data directory (`keys`, `statestore`, `localstore`, `stamperstore`, 7 MB) to a new machine kept the wallet, the batch and the postage sync. The new node was ready in under a minute.
8. **Depth 17 holds only about 45 KB reliably.** That surprised us, because it is the minimum depth and its theoretical size is 537 MB. The effective volume table is what matters, and it is easy to miss.
9. **sBZZ only comes from a Uniswap testnet swap.** A faucet would be simpler.

## In Production

- The board runs one always-on Bee node on Swarm mainnet, for example a small VM next to the TEE, or uses a hosted upload service.
- It buys one batch per exam season, sized for results and appeals, and runs `relay backup` after the Build and again after unlock.
- Readers use any public mainnet gateway, and check every file against Sepolia as now.
- The exam never depends on Swarm. It is used only when the bucket fails.
