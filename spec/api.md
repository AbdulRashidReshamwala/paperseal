# Paper Seal Wire Formats

Formats shared by the TEE, contracts and apps. Change this file first, then every implementation in the same change.

## Conventions

- Bytes are lowercase hex with a `0x` prefix in JSON.
- Integers that can exceed 2^53, including drand rounds, are decimal strings in JSON.
- `examId` is 32 bytes, the `keccak256` of the exam's human-readable name.
- Every signed or hashed message is `SHA-256(abi.encode(string tag, field, ...))`, using Solidity's standard ABI encoding, not `abi.encodePacked`. `tag` is the domain tag from `constants.json`, and the fields follow in the listed order with the listed types. Use a library for this: `abi.encode` in Solidity, viem in TypeScript and go-ethereum's `accounts/abi` in Go.
- Hashes are SHA-256 unless a field says otherwise. On-chain identifiers use `keccak256`.
- TEE signatures are ECDSA over P-256 with SHA-256, encoded as 64-byte `r || s` with low `s`.
- P-256 public keys, including `instancePublicKey`, are 65-byte uncompressed points starting with `0x04`, and have the ABI type `bytes`.
- The WebAuthn PRF `first` input is the UTF-8 bytes of `webauthn.prfSalt` from `constants.json`. Changing it changes every derived key, so a registered holder could no longer open their share.
- Every WebAuthn create and get request sets `userVerification` to `webauthn.userVerification`. An authenticator can give a different PRF output with and without user verification, so this setting can't vary between requests.

## Exam Settings

These are the attested startup arguments.

| Field | Type | Stored by `createExam` |
| --- | --- | --- |
| `examId` | `bytes32` | Yes |
| `examStart` | `uint64`, `T` in Unix seconds | Yes |
| `delta` | `uint64`, `Δ` in seconds | Yes |
| `lockRound` | `uint64` | Yes |
| `unlockRound` | `uint64` | Yes |
| `endRound` | `uint64` | Yes |
| `criteriaHash` | `bytes32` | Yes |
| `rpcHost` | `string`, the RPC operator's hostname, with no scheme, port or path | Yes |
| `registry` | `address`, the `ExamRegistry` contract | No, it is the contract itself |
| `chainId` | `uint64`, equal to `chain.chainId` in `constants.json` | No, it is the contract's chain |

The startup arguments are one `--<name>=<value>` each, in the order of this table, so `tee-cmd` and the attestation check compare one exact list. Names are the kebab-case field names, such as `--exam-id` and `--rpc-host`. Hex values are lowercase with a `0x` prefix, and integers are decimal with no leading zeros.

`createExam` rejects these unless `lockRound < unlockRound < endRound`, `delta` is not zero, `examStart − delta` is after `drand.genesisTime`, and:

- `unlockRound` is the first quicknet round at or after `examStart − delta`, which is `ceil((examStart − delta − genesisTime) / periodSeconds) + 1`. The paper can't open early by rounding.
- `endRound` is produced after `examStart`.

`createExam` also stores two values that are not startup arguments:

| Field | Type |
| --- | --- |
| `commitHash` | `bytes20`, the git SHA-1 of the tagged commit |
| `imageDigest` | `bytes32`, the raw image digest without the `sha256:` prefix |

The TEE has no board key. Its settings name `ExamRegistry`, and that contract's immutable `board` address is the only writer.

## Selection Criteria

`createExam` takes the encoded criteria as `criteria`. `ExamRegistry` checks them against `settings.criteriaHash`, reverts on a mismatch and emits the full bytes in `ExamCreated`, so anyone can read them and recompute the hash. It doesn't decode them.

`criteria` is `abi.encode(Criteria)`, with these structs:

| `Criteria` field | ABI type |
| --- | --- |
| `maxSetterPercent` | `uint32`, the most of a topic's bank one setter can hold, from 1 to 100 |
| `minBankMultiple` | `uint32`, how many times larger than its question count each topic's bank must be, at least 2 |
| `topics` | `Topic[]`, not empty |

| `Topic` field | ABI type |
| --- | --- |
| `name` | `string`, not empty and unique within the exam |
| `questions` | `uint32`, how many questions the paper takes from this topic, at least 1 |

`criteriaHash` is the hash of the `criteria` message. The board app and the TEE reject criteria that break these rules, or whose re-encoded bytes differ, so one set of criteria has one encoding. The paper's `selected` count is the sum of `questions`.

## Approved List

`postApprovedList` takes the encoded list as `entries`. `ExamRegistry` stores its hash and emits the full bytes in `ApprovedListPosted`.

`entries` is `abi.encode(Entry[])`, with this struct:

| Field | ABI type |
| --- | --- |
| `role` | `uint8`, from the table below |
| `passkeyPublicKey` | `bytes`, a P-256 public key |
| `derivedPublicKey` | `bytes`, a P-256 public key or empty |
| `owner` | `string`, not empty |

| `role` | Meaning | `derivedPublicKey` |
| --- | --- | --- |
| `1` | Setter | Empty |
| `2` | Neutral party, a key holder | 65 bytes |
| `3` | Centre that is a key holder | 65 bytes |
| `4` | Approved centre without a share | 65 bytes |

Order is free, because the hash covers the posted bytes. The TEE decodes `entries`, then re-encodes it and rejects the list if the bytes differ, so one list has one encoding. It also rejects a list with an unknown role, a repeated passkey, a repeated derived key, the wrong number of key holders from `threshold`, or an entry it didn't verify at registration.

The TEE reads `getApprovedList` over TLS at the `finalized` block, from `rpcHost`, using root certificates in the attested image. It then calls `eth_getLogs` for that record's `postedBlock` only.

Every client reads `entries` and `criteria` this way. `getExam` returns `createdBlock`, and `getApprovedList` returns `postedBlock`, so a log query covers exactly one block. Public RPC operators reject wide block ranges, so clients never search from an earlier block.

## Signed Messages

| Message | Signed by | Fields, in hash order |
| --- | --- | --- |
| `registration` | Passkey | `bytes derivedPublicKey`, `bytes holderId`, `bytes challenge` |
| `criteria` | None, a public hash | `bytes criteria` |
| `approvedList` | TEE | `bytes32 examId`, `bytes entries` |
| `questionSubmission` | Passkey | `bytes32 examId`, `bytes challenge`, `bytes32 questionHash` |
| `questionReceipt` | TEE | `bytes32 examId`, `bytes passkeyPublicKey`, `bytes32 questionHash` |
| `build` | TEE | `bytes32 examId`, `bytes32 approvedListHash`, `bytes32 paperHash`, `bytes32 storageManifestHash`, `bytes32 saltedPaperHash`, `uint32 selected`, `uint32 bankSize`, `bytes32 criteriaHash` |
| `shareRelease` | Passkey | `bytes32 examId`, `bytes challenge` |
| `releaseLog` | TEE | `bytes32 examId`, `bytes32 entriesHash` |

- `registration.derivedPublicKey` is empty for setters.
- `approvedListHash` is the hash of the `approvedList` message. `ExamRegistry` computes the same hash from the posted bytes, and `postBuild` rejects a Build whose hash differs. The TEE signature on `approvedList` isn't posted. Apps fetch it from the TEE and compare the hash with the chain.
- `questionHash` is the plain SHA-256 of the question ciphertext. It is never a hash of the plaintext, because that would let people test guesses at a question.
- `paperHash` is the plain SHA-256 of the encrypted paper file.
- `saltedPaperHash` uses the `paperHash` domain tag, with fields `bytes32 seed`, `bytes paper`. It never hashes the plaintext unsalted, because that would let people test guesses at the paper.
- `shareRelease` doesn't cover a share hash. One WebAuthn request gives both the signature and the PRF output, so the share isn't decrypted yet when the passkey signs.
- `shareHash` uses the `shareHash` domain tag, with the field `bytes share`.

## Attestation Nonce

`eat_nonce` is the lowercase hex, with no `0x` prefix, of the `attestationNonce` message, with fields `bytes instancePublicKey`, `bytes32 examId`.

## TEE API Errors

Errors return a non-2xx status and `{"error": {"code": "<snake_case>", "message": "<text>"}}`.
