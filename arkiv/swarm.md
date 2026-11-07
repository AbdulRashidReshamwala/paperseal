# Swarm

We back up each exam's public files to Swarm and write where the backup is on Arkiv. If the exam board's bucket goes down, or is emptied on exam morning, the verifier still checks the exam and opens the paper from Swarm.

Today only the public verifier reads the backup. Next, key holders and centres will fetch their files from it too. The rules are in [`spec/arkiv.md`](../spec/arkiv.md), "Backups".

## What Goes Where

| Where | What | Why |
| --- | --- | --- |
| **Swarm** | One folder per exam, 25 files, about 1.1 MB: the encrypted paper, the time-locked key, every key holder's encrypted share and Google's token. After unlock it also holds the release log and the unlock keys | The files are big and must not change. A file's address is its own hash, and the board can't delete it |
| **Arkiv** | One `paperseal.v1.backup` entity per exam and phase. **The `swarmRef` field holds the Swarm reference** | Anyone can find the backup by exam ID, without asking the board |
| **Sepolia** | The hash of the exam's file list (`storageManifestHash`) | The source of truth. A backup is used only if its file list matches this hash, and each file only if it matches the list |
| **Nowhere** | Questions, setter data, invite secrets | Never copied anywhere |

The files are already encrypted or signed, so we upload them **unencrypted**. An encrypted Swarm reference contains its key, and Arkiv is public, so our Arkiv writer refuses any encrypted reference.

## One Entity and Its Reference

| | |
| --- | --- |
| Arkiv entity | [`0x2d08b220813b576a3a87193723aa31969c22792eef5b5c333f1049f26a9871a8`](https://rabdi.explorer.arkiv.network/entity/0x2d08b220813b576a3a87193723aa31969c22792eef5b5c333f1049f26a9871a8) |
| `swarmRef` | `bae94aa7a550c4d870856306bb0bf68fa366a2e59039de2d48e404b27c527ed6` |
| Open it | [`manifest.json` on Swarm](https://34-93-7-127.sslip.io/bzz/bae94aa7a550c4d870856306bb0bf68fa366a2e59039de2d48e404b27c527ed6/manifest.json) |
| Exam | `0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3` on registry `0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb` (Sepolia) |
| See it used | [The exam in the verifier](https://paperverify.abdulrashid.dev/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3) |

Swarm's Sepolia testnet has no public gateway, so we run one for the event: our Bee node behind Caddy, which allows only `GET /bzz/...` and `/health`. Nobody can upload or touch the node's wallet through it. It's a temporary VM. After the event, use your own testnet Bee node in place of the host.

## Postage Batch and Node

| | |
| --- | --- |
| Batch used for every backup | `6b239feebe6cc8efb71eda3dc87c1cc496b93966ed6a04895495c5e5b4829626`: depth 18 (about 6.6 MB usable), bought on 2026-11-06 for 0.0565 sBZZ ([transaction](https://sepolia.etherscan.io/tx/0x86876d38e7e965fd6ab96f820c93cd924fe0b92cc55e1c0e0dd73c34a8e2b1f4)) |
| Spare batch | `9ffbf39decf0958ad5119a396e286f62b813318e964983c5f5e052c54b0a19c4`: depth 20 (about 690 MB usable), bought on 2026-11-06 for 0.2275 sBZZ ([transaction](https://sepolia.etherscan.io/tx/0xd47a1adcc35ffced53e24c4cd006e220cc792aae712faa55f77e7aab59f61b45)). No backup uses it yet |
| Bought by | The Bee node's wallet [`0x1A33528CFA77203027643aB842a26455C68DC329`](https://sepolia.etherscan.io/address/0x1A33528CFA77203027643aB842a26455C68DC329), funded from the team's wallet `0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b` |
| Uploaded through | Our own Bee 2.8.3 light node on the Swarm Sepolia testnet. It started on a laptop, then moved to a GCP VM in Mumbai |
| Read through | `https://34-93-7-127.sslip.io`, the read-only gateway above. It allows any origin, so a verifier on any domain can read it |

## Code

| File | Does |
| --- | --- |
| [`packages/swarm/src/client.ts`](../packages/swarm/src/client.ts) | Talks to Bee: upload a folder, download a file, buy stamps |
| [`packages/swarm/src/tar.ts`](../packages/swarm/src/tar.ts) | Packs the folder for upload. It handles file names up to 145 bytes |
| [`packages/arkiv/src/schemas.ts`](../packages/arkiv/src/schemas.ts), [`writer.ts`](../packages/arkiv/src/writer.ts), [`reader.ts`](../packages/arkiv/src/reader.ts) | Writes and reads the `paperseal.v1.backup` entity |
| [`relay/src/backup.ts`](../relay/src/backup.ts) | **Upload:** checks every file against Sepolia, uploads, writes the Arkiv row, then reads the file list back |
| [`relay/src/swarm-node.ts`](../relay/src/swarm-node.ts) | Node status and stamp buying |
| [`packages/verify/src/backup.ts`](../packages/verify/src/backup.ts) | **Read:** finds the backup through Arkiv and checks each file before using it |
| [`apps/verifier/src/swarm.ts`](../apps/verifier/src/swarm.ts) | Shows in the verifier which files came from Swarm |

## Run It Yourself

You need this repo after `pnpm install`.

**One upload.** This also needs a Bee node on the Swarm Sepolia testnet with a usable batch, and a wallet with tGLM on Arkiv (see `relay/README.md`):

```bash
node relay/cli.mjs backup --exam 0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3 --registry 0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams --batch <your batch id>
```

You should see `uploaded reference …`, `row written` and `read-back manifest.json from Swarm matches`. Running it again with the same files writes nothing new.

**One read, with the bucket gone.** The quickest way: open the [exam in the verifier](https://paperverify.abdulrashid.dev/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3). Under "Check it yourself", set "Where the public files are kept" to `https://storage.googleapis.com/paperseal-demo-bucket-gone`, a bucket that doesn't exist, and save.

To run it locally instead, put this in `apps/verifier/.env.local`, run `pnpm --filter @paperseal/verifier dev`, and open `http://localhost:5172/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3`:

```bash
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_REGISTRY_ADDRESS=0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb
VITE_TEE_STORAGE_BUCKET=paperseal-demo-paperseal-exams
VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
VITE_SWARM_API_URL=https://34-93-7-127.sslip.io
VITE_STORAGE_URL=https://storage.googleapis.com/paperseal-demo-bucket-gone
```

**What you should see:** all 7 steps done, ending with "The paper is open". Each step's evidence has a "Backup on Swarm" block that marks which files came from Swarm, with links to Swarm and to the Arkiv row. The browser console shows the failed requests to the missing bucket.

To use your own Bee node, set `VITE_SWARM_API_URL` to it and allow the verifier's origin in its config.

## Demo Video

The demo video is on our ETHGlobal submission and the [homepage's demo section](https://paperseal-home.pages.dev/#demo). Swarm is used when the board's bucket is switched off: the verifier still opens the paper, and each step's evidence shows "Backup on Swarm".

## What Got in Our Way

1. **Many public RPCs break the first sync.** Bee needs old Sepolia history, from block 6,596,277. A popular RPC failed with `pruned history unavailable`. `rpc.sepolia.ethpandaops.io` and `sepolia.gateway.tenderly.co` worked. A note in the docs would save hours.
2. **The first testnet sync takes about an hour.** Mainnet has a snapshot, and a testnet one would help hackathons a lot.
3. **Bee quits while waiting for funds.** A new node gave up after about 3 minutes with `insufficient ETH for deploying chequebook` and needed a restart after funding.
4. **The first stamp purchase failed.** `POST /stamps` returned `500 cannot create batch` because the token approval hadn't been mined yet. The same request worked a moment later.
5. **"Synced" is never exactly the chain tip.** Bee stays about 5 blocks behind on purpose, so we allow 10.
6. **The price jumps while syncing.** It moved between 24,618 and 205,334 PLUR per chunk per block, so quotes only made sense once synced.
7. **There is no testnet gateway,** so judges need their own node. A public testnet gateway with CORS, even a slow one, would help.
8. **Depth 17 holds only about 45 KB reliably,** though its maximum is 537 MB. The "effective volume" table is what matters, and it's easy to miss.
9. **sBZZ only comes from a Uniswap testnet swap.** A faucet would be simpler.
10. **Moving a node is easy once you know how.** Copying its data folder (7 MB) to a new machine kept the wallet, the batch and the sync. It was ready in under a minute.

## In Production

- The board runs one always-on Bee node on Swarm mainnet, or uses a hosted upload service.
- It buys one batch per exam season and backs up after the Build and again after unlock.
- Readers use any public mainnet gateway and check every file against the chain, as now.
- The exam never depends on Swarm. It's only used when the bucket fails.
