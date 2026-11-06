# Swarm

Paper Seal backs up each exam's public files to Swarm, and records where the backup is on Arkiv, so the files survive if the exam board's bucket goes down or is emptied on exam morning. Today the public verifier uses the backup: with the bucket gone, it still checks the exam and opens the paper. The key holder and centre pages don't use it yet. That comes next, so holders can fetch their encrypted shares, and centres the encrypted paper, from Swarm. The rules are in [`spec/arkiv.md`](../spec/arkiv.md), "Backups".

## What Goes Where

| Where | What | Why there |
| --- | --- | --- |
| **Swarm** | One collection per exam: `manifest.json`, `paper.bin` (the encrypted paper, 1 MiB), `key-pub.tlock`, every `shares/<key>.bin` (each encrypted to its key holder) and `token.jwt`. After unlock it also holds `release-log.json`, `release-token.jwt`, `key-priv.tlock` and every `key-priv/<key>.bin`. That's 25 files, 1.08 MB | The files are large and must be immutable, and the board can't delete them. A file's address is its own hash |
| **Arkiv** | A `paperseal.v1.backup` entity per exam and phase. **`swarmRef` holds the Swarm reference**, next to `manifestHash`, `phase`, `files` and `batchId` | Anyone can find the backup by exam ID, with no help from the board |
| **Sepolia** | The Build's `storageManifestHash` | The source of truth. A backup is used only if its `manifest.json` hashes to it, and each file it lists is used only if it matches its hash in the manifest. Unlock files aren't in the manifest. The relay checks them before uploading (token, log signature, timelock round, sizes), and the verifier checks them exactly like the bucket's copies. One that fails is ignored and the next backup is tried |
| **Nowhere** | Questions, setter data, invite secrets | Never mirrored |

Every file is already public and already encrypted or signed, so the collection is uploaded **unencrypted**. Swarm's own encryption would put a decryption key inside the reference, and Arkiv entities are public: the Arkiv writer refuses any 128-character, encrypted reference.

## One Entity and Its Reference

| | |
| --- | --- |
| Arkiv entity | [`0x766f01f7b808ef19378a715d0dd9512b3c2508dda38521ab7255156f8c61de36`](https://rabdi.explorer.arkiv.network/entity/0x766f01f7b808ef19378a715d0dd9512b3c2508dda38521ab7255156f8c61de36) |
| `swarmRef` | `64221579f12d975d45155eca774770505ebf76c4108cc96bdc44f5adf97448fd` |
| Exam | `0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295`, on registry `0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8` (Sepolia) |
| Phase | `unlock`, 25 files |
| Link | `http://127.0.0.1:1633/bzz/64221579f12d975d45155eca774770505ebf76c4108cc96bdc44f5adf97448fd/manifest.json` |

**About the link:** the upload is on Swarm's **Sepolia testnet**, which has no public gateway. So the link opens through any testnet Bee node, here the one on `127.0.0.1:1633`. With a node on the testnet, replace the host with your own. We checked that `paper.bin` downloaded from Swarm has exactly the hash in the bucket and in the on-chain manifest (`c4a1765f…6cee`).

## Postage Batch and Node

| | |
| --- | --- |
| Batch ID | `6b239feebe6cc8efb71eda3dc87c1cc496b93966ed6a04895495c5e5b4829626` |
| Size and life | Depth 18 (about 6.6 MB reliably), 3 days from 2026-11-06, bought for 0.0565 sBZZ |
| Bought by | The Bee node's wallet [`0x1A33528CFA77203027643aB842a26455C68DC329`](https://sepolia.etherscan.io/address/0x1A33528CFA77203027643aB842a26455C68DC329), funded from the team's board wallet `0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b` |
| Uploaded through | Our own Bee 2.8.3 light node on the Swarm Sepolia testnet (`mainnet: false`), API on `127.0.0.1:1633` |

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
node relay/cli.mjs backup --exam 0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295 --registry 0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8 --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams --batch <your batch id>
```

You should see `hash … the Build's storageManifestHash on Sepolia`, `uploaded reference …`, `row written` and `read-back manifest.json from Swarm matches`. Writing the row needs a wallet with tGLM on Arkiv (see `relay/README.md`). Re-running with the same files skips the row.

**One read.** The verifier with the board's bucket gone:

1. Put this in `apps/verifier/.env.local`. The storage URL is a bucket that doesn't exist:

   ```bash
   VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
   VITE_REGISTRY_ADDRESS=0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8
   VITE_TEE_STORAGE_BUCKET=paperseal-demo-paperseal-exams
   VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
   VITE_STORAGE_URL=https://storage.googleapis.com/paperseal-demo-bucket-gone
   ```

2. Run `pnpm --filter @paperseal/verifier dev` and open `http://localhost:5172/#/exam/0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295`.
3. All 7 steps should be done, ending with "The paper is open". Each step's evidence has a "Backup on Swarm" block marking `token.jwt`, `manifest.json`, `paper.bin` and `key-pub.tlock` as "From the Swarm backup, checked against the exam's on-chain record". `release-log.json`, `release-token.jwt` and `key-priv.tlock` also come from Swarm, checked by the same steps as the bucket's copies. Each block links to the files on Swarm and to the Arkiv row. The browser console shows the failed requests to the missing bucket.

Your Bee node must allow the verifier's origin: `cors-allowed-origins: ["http://localhost:5172"]` in its config.

## Demo Video

To be added by the team, with the timestamp where the bucket is switched off and the paper opens from Swarm.

## What Got in Our Way

1. **Pruned RPCs break the first sync.** Bee's postage listener failed with `pruned history unavailable` on a popular public Sepolia RPC, because it must read the postage contract from block 6,596,277. Only some free RPCs keep that history: `rpc.sepolia.ethpandaops.io` and `sepolia.gateway.tenderly.co` did. A note in the testnet docs would save hours.
2. **The first testnet sync takes about an hour.** It covers about 5.5 million blocks, at 70,000 to 200,000 blocks a minute. Mainnet has a postage snapshot. A testnet snapshot would make hackathon onboarding much faster.
3. **Bee exits while waiting for funds.** A fresh node gave up after about 3 minutes with `insufficient ETH for deploying chequebook`, and had to be restarted after funding.
4. **The first batch purchase failed on a race.** `POST /stamps` returned `500 cannot create batch`, and the log said `ERC20: insufficient allowance`. The approval was mined a moment later, and the same request then worked.
5. **"Synced" is never exactly the chain tip.** Bee trails the tip by about 5 blocks, by design, so a check for `block == chainTip` never passes. We allow 10.
6. **The price swings while syncing.** `/chainstate` showed 24,618, then 205,334, then 99,788 PLUR per chunk per block during the sync, so quotes were only good once synced.
7. **There is no testnet gateway,** so the reads judges can do need their own node. We'd love a public, CORS-enabled testnet gateway, even a rate-limited one.
8. **Depth 17 holds only about 45 KB reliably.** That surprised us, because it is the minimum depth and its theoretical size is 537 MB. The effective volume table is what matters, and it is easy to miss.
9. **sBZZ only comes from a Uniswap testnet swap.** A faucet would be simpler.

## In Production

- The board runs one always-on Bee node on Swarm mainnet, for example a small VM next to the TEE, or uses a hosted upload service.
- It buys one batch per exam season, sized for results and appeals, and runs `relay backup` after the Build and again after unlock.
- Readers use any public mainnet gateway, and check every file against Sepolia as now.
- The exam never depends on Swarm. It is used only when the bucket fails.
