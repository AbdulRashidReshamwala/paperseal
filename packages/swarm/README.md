# @paperseal/swarm

A small client for the Bee HTTP API, used for the exam backups in `spec/arkiv.md` ("Backups"). It uploads an exam's storage files as one unencrypted Swarm collection, reads single files back by path, and manages the postage batches that pay for the upload. It uses plain `fetch`, so the same code runs in Node and in a browser against the viewer's own node.

It does not check hashes. A backup writer checks every file against the manifest and the Build's `storageManifestHash` before it uploads, and a reader checks every file it downloads, exactly as for files from the bucket.

## API

```ts
import { createSwarmClient, stampCost, minAmount, minDepth } from '@paperseal/swarm';

const bee = createSwarmClient({ apiUrl: 'http://127.0.0.1:1633' }); // default: swarm.defaultApiUrl in spec/arkiv.json

const { reference } = await bee.uploadCollection(
  [
    { path: 'manifest.json', bytes: manifestBytes },
    { path: 'paper.bin', bytes: paperBytes },
  ],
  { batchId },
);
const manifest = await bee.download(reference, 'manifest.json'); // Uint8Array, or null on 404
```

| Call | Bee endpoint | Returns |
| --- | --- | --- |
| `uploadCollection(files, { batchId, deferred? })` | `POST /bzz` | `{ reference }`, 64 lowercase hex |
| `download(reference, path)` | `GET /bzz/{reference}/{path}` | `Uint8Array`, or `null` on 404 |
| `stamps()` | `GET /stamps` | `PostageBatch[]`, amounts as `bigint` |
| `buyStamp({ amount, depth, label? })` | `POST /stamps/{amount}/{depth}` | The new batch ID |
| `chainState()` | `GET /chainstate` | Price and totals as `bigint` |
| `wallet()` | `GET /wallet` | Balances as `bigint` (PLUR and wei) |
| `health()` | `GET /health` | `{ status, version, apiVersion }` |
| `addresses()` | `GET /addresses` | Overlay, Ethereum address and keys |

Helpers: `stampCost({ amount, depth })` gives `{ plur, bzz }`, `formatBzz(plur)`, `minAmount(chainState)`, `minDepth` (17), `checkCollectionPath`, `checkReference`, `checkBatchId` and `collectionTar`.

### Uploads

`uploadCollection` packs the files into an uncompressed tar in memory and sends it with exactly these headers:

```
Content-Type: application/x-tar
Swarm-Collection: true
Swarm-Postage-Batch-Id: <batchId>
Swarm-Deferred-Upload: false
```

It never sends `Swarm-Encrypt`. Every backed-up file is already public and encrypted or signed, and an encrypted reference contains its own decryption key, which must not go on Arkiv. A 128-character (encrypted) reference in the response is rejected, and so is one passed to `download`.

`deferred` defaults to `false`, so Bee pushes every chunk to the network before it answers, and the backup survives the uploading node going offline. `deferred: true` sends `Swarm-Deferred-Upload: true`: Bee answers once the chunks are stamped and stored on the node and pushes them in the background, so the node has to stay up until that push finishes. Bee's own default, with no header, is deferred.

Paths are the bucket's file names. Each must be relative and `/`-separated, with no leading `/`, no empty, `.` or `..` segments, no backslashes, no control characters, at most 255 UTF-8 bytes, and unique in the collection. The storage names `shares/<derivedPublicKey>.bin` and `key-priv/<derivedPublicKey>.bin` are 143 and 145 bytes long, past ustar's 100-byte name field, and their file name alone is over 100 bytes, so the ustar prefix can't split them. They are written as PAX `path` records, which Go's `archive/tar`, and so Bee, reads. All other header fields are fixed, so the same files always give the same tar.

### Stamps

A batch of depth `d` can stamp `2^d` chunks of 4 KB, and `amount` is the PLUR paid per chunk, so it costs `2^d × amount` PLUR, with `10^16` PLUR to 1 BZZ. For example, depth 24 at amount `10^9` costs `16777216000000000` PLUR, or 1.6777216 BZZ. The balance drains by `currentPrice` PLUR per chunk per block, and Bee refuses an `amount` that won't last `minimumValidityBlocks` blocks, which `minAmount` computes (24 hours, or 17280 Gnosis blocks, when Bee doesn't report it). The smallest depth is 17. Because of how chunks fill a batch's buckets, a depth-17 batch reliably holds only about 44 KB of unencrypted data, so check the docs' effective-volume table before choosing a depth.

`buyStamp` sends `Immutable: true`, so a full batch refuses new chunks rather than overwriting old ones. It spends the node's BZZ and gas.

### Errors

Every failed request throws `SwarmApiError`, with `status` (0 when no response came back) and `endpoint`, such as `GET /wallet`, and Bee's own message. `download` throws `SwarmReadError`, a subclass, for anything but a 404. Bee answers some endpoints, such as `/wallet` and `/stamps`, with 503 until it has synced.

## Why Plain `fetch`

`@ethersphere/bee-js` 13.2.0 is 2.5 MB unpacked and depends on `ws`, `isomorphic-ws`, `zod`, `debug`, `semver`, `cafe-utility` and `@ethersphere/core-sdk`. Paper Seal needs eight endpoints, so plain `fetch` keeps the browser bundle small and the requests exact.

The tar is built with [`modern-tar`](https://github.com/ayuhito/modern-tar), which has no dependencies, uses only web APIs and writes PAX headers for long names. `nanotar` truncates names at 100 bytes, which the storage names exceed.

## Commands

```sh
pnpm --filter @paperseal/swarm test       # mocked fetch, plus the system tar reading the output
pnpm --filter @paperseal/swarm test:live  # read-only health, addresses and wallet against a running node
```

`test:live` uses `SWARM_API_URL`, or `swarm.defaultApiUrl` from spec/arkiv.json. It never buys a stamp or uploads anything.
