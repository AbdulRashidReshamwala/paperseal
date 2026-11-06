# Paper Seal Wire Formats

Formats shared by the TEE, contracts and apps. Change this file first, then every implementation in the same change.

## Conventions

- Bytes are lowercase hex with a `0x` prefix in JSON.
- Integers that can exceed 2^53, including drand rounds, are decimal strings in JSON.
- `examId` is 32 bytes, the `keccak256` of the exam's human-readable name. The name must be one normalised ENS label (see [Exam Names](#exam-names)), so `examId` is also its ENS `labelhash`.
- Every signed or hashed message is `SHA-256(abi.encode(string tag, field, ...))`, using Solidity's standard ABI encoding, not `abi.encodePacked`. `tag` is the domain tag from `constants.json`, and the fields follow in the listed order with the listed types. Use a library for this: `abi.encode` in Solidity, viem in TypeScript and go-ethereum's `accounts/abi` in Go.
- Hashes are SHA-256 unless a field says otherwise. On-chain identifiers use `keccak256`.
- TEE signatures are ECDSA over P-256 with SHA-256, encoded as 64-byte `r || s` with low `s`.
- P-256 public keys, including `instancePublicKey`, are 65-byte uncompressed points starting with `0x04`, and have the ABI type `bytes`.
- The WebAuthn PRF `first` input is the hash of the `prfInput` message, computed from the UTF-8 bytes of `webauthn.prfSalt` in `constants.json` and the `examId`. It is the same in register, release and open, and differs per exam, so one passkey gives each exam its own derived key and a leak of one derived key opens no other exam's material. Changing it changes every derived key, so a registered holder could no longer open their share. The TEE never computes it.
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

`schedule` in `constants.json` adds two bounds that the contract doesn't check, so each reader does:

- `delta` is at most `schedule.maxDeltaSeconds`, 24 hours. The paper is with centres from `T−Δ`, so a long `Δ` means a long time to leak.
- `endRound` is produced at most `schedule.maxEndAfterStartSeconds`, 7 days, after `examStart`. An end round far ahead, or one drand will never reach, would mean the paper never opens to everyone and the proof never happens.

The TEE refuses to start with settings outside these, the board app refuses them before publishing, and the verifier fails the exam's first step. The development and `finalized` schedules in `e2e/live/config.ts` fit them, and `dry-check` checks this.

`createExam` also stores two values that are not startup arguments:

| Field | Type |
| --- | --- |
| `commitHash` | `bytes20`, the git SHA-1 of the tagged commit |
| `imageDigest` | `bytes32`, the raw image digest without the `sha256:` prefix |

The TEE has no board key. Its settings name `ExamRegistry`, and that contract's immutable `board` address is the only writer.

## Registry Code

An address on its own doesn't show that a contract is `ExamRegistry`, so every reader that trusts one checks the code there against one pin. `spec/registry.json` holds it, and `make abi` writes it from the Foundry build:

| Field | Meaning |
| --- | --- |
| `runtimeCodeHash` | SHA-256 of the executable code, with each `board` word zeroed |
| `executableBytes` | The length of the executable code |
| `boardOffsets` | Byte offsets of the 32-byte `board` words, which the constructor fills in |

A reader takes the bytes `eth_getCode` returns, then:

1. Removes the CBOR metadata that solc appends. Its length is the code's last two bytes, big-endian, plus those two bytes. It never runs, and it hashes the source including comments, so a comment edit would otherwise change the pin. A contract built from older comments has different metadata, and its executable code still matches.
2. Checks that `executableBytes` bytes remain.
3. Checks that every `board` word holds the same value, and that the value is a non-zero address left-padded with zeros. That address is the board.
4. Zeroes those words, and compares the SHA-256 of the result with `runtimeCodeHash`.

The TEE reads the code at the `chain.readBlock` block, once, before it trusts any read from `registry`. Code that differs fails the exam. No code at all, or a failed read, is retried and never fails the exam, because at `finalized` a new contract isn't visible yet and a lagging node answers the same way. Nothing from the address is used in the meantime.

The verifier makes the same check on every read of the public record, and fails the exam's first step if the code differs or is missing. It reads nothing else from that address, and it shows the board address the code holds. The Exam Names check uses the same pin.

After a change to the contract's code, `make abi` updates the pin, its copy in the TEE and `spec/fixtures/registry-code.json`, the sample code the tests use. The pin is in the attested image, so it also needs a new TEE release. `node e2e/live/cli.mjs registry-check` compares the deployed contract with the pin, read-only. Code can't show how storage was set at deployment. See the note in Exam Names, check 2.

## TEE Releases

A tag `v<major>.<minor>.<patch>` on the repository makes `.github/workflows/repro.yml` build the image twice. If the digests match, it publishes a GitHub release for that tag. The release notes hold one fenced `json` block:

| Field | Type |
| --- | --- |
| `version` | `string`, the tag |
| `commit` | `0x`-prefixed git SHA-1, the `commitHash` in `createExam` |
| `imageDigest` | `0x`-prefixed digest with no `sha256:` prefix, the `imageDigest` in `createExam` |
| `run` | `string`, the URL of the workflow run that built it |
| `checkerSha256` | `0x`-prefixed plain SHA-256 of `paperseal-verify.mjs`, the [agent checker](agent-verification.md#checker) attached to the release |

The metadata sits in the notes because browsers can read them through the GitHub API, but can't fetch release assets across origins. The board app lists these releases, ignores drafts, prereleases and any release that doesn't parse, and rejects a release whose `commit` differs from what its tag points at.

This only fills in the board's form. The on-chain values are what count, and anyone can rebuild them.

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

The sum of `questions` times `padding.questionBytes`, plus 1024 bytes for the paper's JSON, must fit in `padding.paperBytes`, so a paper that passes Lock always fits. `criteriaHash` is the hash of the `criteria` message. The board app and the TEE reject criteria that break these rules, or whose re-encoded bytes differ, so one set of criteria has one encoding. The paper's `selected` count is the sum of `questions`.

## Invites

Setters are invited, and nobody else is. The board creates one invite per setter. An invite holds a random 32-byte `inviteSecret` and the `role`, always `setter`, and is sent privately as a link. All of it sits in the URL fragment, so it never reaches a server. It has no `owner`, because a setter's `owner` is its `setterOwner` hash.

The registrant's app computes `inviteTag = HMAC-SHA-256(inviteSecret, passkeyPublicKey)`, signs it inside the `registration` message and sends it to the TEE. The TEE stores the tag and returns it from `GET /v1/registrations`. It never sees the secret, so it can't check the tag.

The board's app keeps its invites in the browser and recomputes each tag. A registration joins the list only if its tag matches an invite and its `owner` is the `setterOwner` hash of its passkey. A tag copied from someone else fails, because it binds a different passkey. If two passkeys match one invite, the board app refuses both until the board reissues that invite. Names of setters stay in the board's browser and are never published.

Key holders and centres have no invite. They have a permanent identity instead, as in "Party Names". A link with any other role is refused.

## Party Names

A key holder or a centre has one permanent identity: an ENS name that publishes their security key. There is no wallet, no invite link and no secret, and there is no plain name. The name becomes the party's `owner`, so the TEE, `ExamRegistry` and the approved list treat it as an opaque string of at most `limits.ownerBytes` bytes. Setters never have one: their names are never published, and their `owner` stays the `setterOwner` hash.

An `owner` is an ENS name when it has no spaces, has at least two parts around dots, and `normalize(owner)` returns it unchanged. The board app refuses any other `owner` for a key holder or a centre, and for one written like an ENS name that is not normalised it says what to use ("Did you mean ..."), so every reader reaches the same answer. The board's list composing refuses it too. The TEE and `ExamRegistry` do not check this, so an older exam or a board that skips the app can still list a plain `owner`. A reader shows such an owner as "Not an ENS name", a warning and never a failure.

### Enrolment

A person enrols once, at `/enrol` on the app's domain. They touch their security key to create a permanent device-bound passkey with PRF support, and the page shows a key card of public values to send to the directory owner:

| Key card field | Value |
| --- | --- |
| `passkey` | `passkeyRecordValue(passkeyPublicKey)`, the `setterOwner` hash of the passkey public key as lowercase `0x` hex |
| `credentialId` | The WebAuthn credential ID, lowercase `0x` hex |
| `attestationObject` | The attestation object from the create, lowercase `0x` hex |

The card is JSON with these three keys and `"kind": "paperseal-key-card"`, `"version": 1`. Nothing on it is secret.

Enrolling must not silently make a second identity for one key. The page passes every credential ID it knows as `excludeCredentials`: the ones this browser enrolled and every `ens.records.credential` value in the directory, so a key already known refuses with `InvalidStateError` and nothing new is made. A browser that already enrolled shows its card again instead of offering to create. The user handle is random, because a create with a repeated handle would overwrite the earlier passkey on the key.

A passkey belongs to one domain, its relying party ID. Moving the app to another domain needs everyone to enrol again.

### Directory

The directory owner is whoever controls the parent name, `VITE_DIRECTORY_NAME` in the web app, `paperseal-demo.eth` by default. They create subnames with no holder wallet, writing records on the parent's resolver. The text keys are in `spec/ens.json`.

| Name | Record | Holds |
| --- | --- | --- |
| Party name | `addr` (ETH) | Any address, so the name exists |
| Party name | `text` `ens.records.passkey` | The card's `passkey` |
| Party name | `text` `ens.records.credential` | The card's `credentialId` |
| Parent | `text` `ens.records.directory` | A JSON array of party names |

The directory is a menu. It is read with one text lookup, is at most `ens.directoryBytes` bytes, and a reader refuses a value that is longer, isn't a JSON array of strings, or holds a name that fails the ENS name rule above. Each listed name is verified by its own records, so a wrong entry in the list gains nothing. `deploy/ens/records.mjs` prints the exact commands from a key card and sends nothing.

The directory owner decides which key belongs to which name, and can swap a record publicly at any time. To replace a lost key, the person enrols a new key and the directory owner replaces both records. An exam's list holds the key as it was when the list was posted.

### The record check

`passkeyRecordValue(passkeyPublicKey)` reuses the `setterOwner` message instead of adding a domain tag. The key is public, so the value leaks nothing. A reader accepts the record in any hex case and ignores spaces around it.

A reader reads records with the viewer's own RPC, on chain only (`ens.ccipRead` is `false`), with no fallback RPC, on the chain in `constants.json` (Sepolia in this build). It gives one of these states: confirmed (the record matches the passkey), mismatch (set to something else), missing (not set), refused (the chain would not answer on chain, an offchain lookup included), unreadable (the RPC failed), or invalid (not a normalised ENS name). Resolution goes through whatever the RPC's Universal Resolver does and is not tied to ENSv2.

### Registration by name

A party registers per exam from the public exam page, `#/exam?exam=<examId>`, with the same key. The page holds no secret.

1. It reads the name's `ens.records.credential` and `ens.records.passkey` records.
2. It runs one WebAuthn get with `allowCredentials` set to that credential and the exam's PRF input, and derives the exam's key. If it doesn't already know the passkey public key, it recovers it from this signature with the audited curve library, and accepts only the candidate whose `passkeyRecordValue` equals the record.
3. It asks for a challenge and runs a second get, which signs the `registration` message with `inviteTag` set to 32 zero bytes.
4. It sends `POST /v1/register` with the `attestationObject` from enrolment, or `0x` in a browser that didn't enrol.

Two touches are needed, because the derived public key is a field of the signed message, so the PRF output has to exist before the signing ceremony starts.

Registering twice is harmless: the TEE answers `already_registered`, and the app accepts that if `GET /v1/registrations` shows this passkey under this name. After the list is posted a new browser needs no ceremony, because the list already holds the key.

### What the board accepts

The board picks names from the directory and may add others by typing. It gives each one a list role. Nobody defaults to a centre without a share: names fill the neutral places, then the centre key-holder places, in the order chosen, and after that the board must choose. A registration joins the list only if its `owner` is the chosen name, it has a derived key and a zero `inviteTag`, and its `passkeyRecordValue` equals the name's `ens.records.passkey` record. A name with no record, or a record for another key, stays off the list, with no way to go ahead without it. A name that can't be read says so and offers to try again, and the board can always remove it.

The verifier reads the same record for each listed party and shows "Name confirmed" when it matches. For a key holder a missing or wrong record shows "Not confirmed". For a centre it shows a label only. Either way it says who vouches for the name: whoever controls its parent. Neither ever fails the exam, and the TEE and `ExamRegistry` never read ENS. On Sepolia anyone can register a look-alike name, so a confirmed name there proves nothing.

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

For a setter, `owner` is the lowercase `0x`-prefixed hex of the `setterOwner` hash of its own passkey public key. Setter names are never published. Readers recompute the hash and reject an entry where it differs.

Order is free, because the hash covers the posted bytes. The TEE decodes `entries`, then re-encodes it and rejects the list if the bytes differ, so one list has one encoding. It also rejects a list with an unknown role, a repeated passkey, a repeated derived key, the wrong number of key holders from `threshold`, or an entry it didn't verify at registration.

The TEE reads `getApprovedList` over TLS at the `chain.readBlock` block, either `finalized` or `latest`, from `rpcHost`, using root certificates in the attested image. It then calls `eth_getLogs` for that record's `postedBlock` only.

Every client reads `entries` and `criteria` this way. `getExam` returns `createdBlock`, and `getApprovedList` returns `postedBlock`, so a log query covers exactly one block. Public RPC operators reject wide block ranges, so clients never search from an earlier block.

## Signed Messages

| Message | Signed by | Fields, in hash order |
| --- | --- | --- |
| `registration` | Passkey | `bytes derivedPublicKey`, `bytes holderId`, `bytes challenge`, `bytes32 inviteTag` |
| `instanceKey` | TEE | `bytes32 examId`, `bytes encryptionPublicKey` |
| `setterOwner` | None, a public hash | `bytes passkeyPublicKey` |
| `prfInput` | None, a public hash | `bytes prfSalt`, `bytes32 examId` |
| `criteria` | None, a public hash | `bytes criteria` |
| `approvedList` | TEE | `bytes32 examId`, `bytes entries` |
| `questionSubmission` | Passkey | `bytes32 examId`, `bytes challenge`, `bytes32 questionHash` |
| `questionReceipt` | TEE | `bytes32 examId`, `bytes passkeyPublicKey`, `bytes32 questionHash` |
| `build` | TEE | `bytes32 examId`, `bytes32 approvedListHash`, `bytes32 paperHash`, `bytes32 storageManifestHash`, `bytes32 saltedPaperHash`, `uint32 selected`, `uint32 bankSize`, `bytes32 criteriaHash`, `uint64 builtRound` |
| `shareRelease` | Passkey | `bytes32 examId`, `bytes challenge` |
| `releaseLog` | TEE | `bytes32 examId`, `bytes32 entriesHash`, `bytes32 filesHash` |

- `registration.derivedPublicKey` is empty for setters. `holderId` is the UTF-8 bytes of `owner`. `inviteTag` is 32 zero bytes for a registration by name (see "Party Names"), which keeps the field and its place in the hash. It is the HMAC of an invite for a setter, and the TEE refuses a zero tag without a derived key.
- `prfInput.prfSalt` is the UTF-8 bytes of `webauthn.prfSalt`. No party signs this message: it is the PRF input, and only apps compute it.
- `approvedListHash` is the hash of the `approvedList` message. `ExamRegistry` computes the same hash from the posted bytes, and `postBuild` rejects a Build whose hash differs. The TEE signature on `approvedList` isn't posted. Apps fetch it from the TEE and compare the hash with the chain.
- `questionHash` is the plain SHA-256 of the question ciphertext. It is never a hash of the plaintext, because that would let people test guesses at a question.
- `paperHash` is the plain SHA-256 of the encrypted paper file.
- `saltedPaperHash` uses the `paperHash` domain tag, with fields `bytes32 seed`, `bytes paper`. It never hashes the plaintext unsalted, because that would let people test guesses at the paper.
- `builtRound` is the newest verified drand round when the TEE sealed the paper, read from the relay's latest round as release entries read theirs. A stale relay can only understate it. It is the signed time of sealing, whatever time the board posts the Build. Round `r` is published at `genesisTime + (r - 1) * periodSeconds`. `postBuild` takes the `build` fields after `examId` as one `BuildFields` struct in hash order, and rejects a zero `builtRound`, which is a format rule only. The rounds themselves are checked by readers, not by `ExamRegistry`: a Build is sound only if `lockRound <= builtRound`, and it was sealed in time if `builtRound < unlockRound`. If the TEE can't read the latest round while sealing, it retries and doesn't fail the exam.
- `shareRelease` doesn't cover a share hash. One WebAuthn request gives both the signature and the PRF output, so the share isn't decrypted yet when the passkey signs.
- `shareHash` uses the `shareHash` domain tag, with the field `bytes share`.

## Instance Keys

Each TEE instance generates two P-256 keys in memory at start and never stores them.

- The signing key is `instancePublicKey`. It signs every TEE message, and `eat_nonce` binds it.
- The encryption key is `encryptionPublicKey`. It opens HPKE messages sent to the TEE. The signing key signs it through the `instanceKey` message, and apps verify that before encrypting anything.

## Encryption

- **HPKE:** base mode, framed as `enc || ciphertext`. `info` is the UTF-8 bytes of the purpose's `crypto.hpke.info` value. `aad` is `examId`, except for `question`, where it is `examId || passkeyPublicKey`, so one setter can't resubmit another's ciphertext.
- **AES-256-GCM:** framed as a random 12-byte nonce, then ciphertext and tag. `aad` is `examId`.
- **Padding:** a big-endian `uint32` length, the data, then zero bytes up to the target size from `padding`. Reject data that doesn't fit, and reject non-zero padding when removing it.
- **Derived keys:** RFC 9180 `DeriveKeyPair` for the HPKE suite, with the 32-byte PRF output as the input keying material.
- **Timelock:** the armoured age format shared by `drand/tlock` and `tlock-js`, on quicknet. `K_pub` is sealed to `unlockRound`, and the `K_priv` copy to `endRound`. The TEE verifies every drand round against `drand.publicKey`.

| Purpose | Sender | Recipient | Plaintext |
| --- | --- | --- | --- |
| `question` | Setter app | `encryptionPublicKey` | A padded question, to `padding.questionBytes` |
| `share` | TEE | Holder's derived key | The Shamir share |
| `release` | Key holder app | `encryptionPublicKey` | `abi.encode(bytes share, bytes signature, bytes authenticatorData, bytes clientDataJSON)` |
| `keyPriv` | TEE | Centre's derived key | The 32-byte `K_priv` |

## Paper Format

A question is the JSON `{"topic": string, "text": string}`, or `{"topic": string, "text": string, "options": [string]}` for a multiple choice question. `topic` must name a criteria topic.

`options` holds between `limits.questionOptionsMin` and `limits.questionOptionsMax` strings, in the order the setter wrote them. Each is non-empty after trimming, and no two are equal. A written question has no `options` key, so `null` and an empty list are refused. A question's correct answer is never part of it, because the paper becomes public at the end round.

The paper is the JSON `{"examId": hex, "questions": [question]}`, with each question's keys in the order above. `paper` in `saltedPaperHash` means these bytes, before padding.

The encrypted paper file is AES-256-GCM under `K` over the 32-byte `seed`, then the paper padded to `padding.paperBytes`.

## Passkey Signatures

The message hash is the WebAuthn `challenge`. The signature is ES256 in DER form, over `authenticatorData || SHA-256(clientDataJSON)`.

The TEE checks the signature, that `clientDataJSON.challenge` is the base64url message hash, that `type` matches the ceremony, that user present and user verified are set, and that both backup flags are clear. It doesn't check `origin` or `rpIdHash`, because the passkey public key identifies the holder and the board serves the app anyway.

A challenge is 32 random bytes plus an expiry, authenticated with an in-memory key, so issuing one stores nothing. It is single use and expires after 5 minutes. Release challenges are only issued once `unlockRound` is published.

`webauthn.requireHardwareAttestation` is `false` for the demo, so the TEE doesn't look at `attestationObject`. The value is in the attested image, and the verifier page shows it. When it's `true`, the TEE first checks that the object's attested credential is exactly `passkeyPublicKey`, and refuses with `invalid_attestation` otherwise, including when the object is empty. The chain check that follows isn't implemented, so it rejects the registration.

## Storage

Files live under `<examId>/` in a public bucket, named by the `STORAGE_BUCKET` environment variable. `STORAGE_DIR` writes to a local folder instead, for local runs. Apps read from their configured base URL, and hashes protect the content.

In file names, `<derivedPublicKey>` is the key's lowercase hex with its `0x` prefix.

Written before the Build:

| File | Content |
| --- | --- |
| `paper.bin` | The encrypted paper |
| `key-pub.tlock` | Timelocked `K_pub` |
| `shares/<derivedPublicKey>.bin` | One HPKE `share` per key holder |
| `token.jwt` | The PKI attestation token |
| `manifest.json` | `{"examId": hex, "files": [{"name": string, "sha256": hex, "recipient"?: hex, "shareHash"?: hex}]}`, sorted by `name`, listing every file above |

`storageManifestHash` is the plain SHA-256 of `manifest.json`.

Written at unlock. The signed release log lists the hash of each `key-priv` file, and carries its own signature and token:

| File | Content |
| --- | --- |
| `key-priv/<derivedPublicKey>.bin` | One HPKE `keyPriv` per approved centre (roles 3 and 4) |
| `key-priv.tlock` | `K_priv` timelocked to `endRound` |
| `release-log.json` | The `GET /v1/release/log` body |
| `release-token.jwt` | The PKI attestation token of the instance that ran Unlock |

Unlock may run on a different instance from the Build, so the log names its signer in `instancePublicKey`, and `release-token.jwt` attests that key. `entriesHash` is the plain SHA-256 of `abi.encode(ReleaseEntry[])`, with `ReleaseEntry` being `(bytes passkeyPublicKey, bytes32 shareHash, uint64 round)`, in the order received.

`filesHash` is the plain SHA-256 of `abi.encode(ReleaseFile[])`, with `ReleaseFile` being `(string name, bytes32 sha256)`, sorted by `name` in byte order. `sha256` is the plain SHA-256 of the stored file. `files` is empty until the threshold is reached. After that it lists exactly `key-priv.tlock` and one `key-priv/<derivedPublicKey>.bin` per approved centre (roles 3 and 4), so a reader must treat a missing, extra or changed file as a failure. These files are written after the Build, so the Build can't cover them.

## Dev Mode

`chain.readBlock` is `latest` during development, so a full test exam takes under 5 minutes, and must be `finalized` for any real exam. A block at `latest` can be reorged, so a run may fail, but `ExamRegistry` still rejects a mismatched Build. The value is in the attested image, like `webauthn.requireHardwareAttestation`, and the verifier shows both in its folded evidence, as the values it was built with.

## Size Limits

`limits` in `constants.json` caps `entries` and `criteria`, because ABI offsets let many elements share one large value, so a small input can decode to a huge one. Every reader must reject a value before decoding it if:

- It is longer than `limits.entriesBytes` or `limits.criteriaBytes`.
- Its array offsets don't start right after the array's head and increase strictly, with each element ending at or before the next one starts.

After decoding, readers also apply `limits.entries`, `limits.topics`, `limits.ownerBytes` and `limits.topicNameBytes`. `ExamRegistry` rejects oversized `entries` and `criteria` by length alone, and still doesn't decode them.

`limits.entriesBytes` and `limits.entries` are set by what one transaction can carry. geth's mempool refuses a transaction over 131,072 bytes, and most public nodes run it, so a longer list would never reach a block. An entry with an owner at `limits.ownerBytes` takes 576 bytes, so 225 entries take 129,664 bytes with the array's head, and `limits.entriesBytes` is 130,000. Calldata adds at most 131 bytes to that, which leaves about 900 bytes for the transaction's own fields and signature. The board app refuses a list over either limit before it asks the wallet to sign.

`ExamRegistry` enforces the same `limits.entriesBytes` as its own cap on `entries`, so the contract and the readers accept the same lists.

## Exam Names

An exam's human-readable name is one ENS label that is already normalised under ENSIP-15: `normalize(name)` returns `name` unchanged and it holds no `.`. So `jee-main-2026` is a name, but `Maths 2026`, `JEE-Main-2026` and `jee.main` are not. A name that normalises to something else would hash to a different `examId` than the one ENS finds, so the board app refuses it rather than fixing it. `spec/fixtures/exam-names.json` lists valid and invalid names with their `examId`.

A board may give an exam an ENS name `<name>.<parent>`, where `parent` is the board address's primary name, so anyone can check the exam by name. This is optional and only helps people find the exam: the TEE and `ExamRegistry` never read ENS, and every value a name supplies is checked again by the usual checks. The exam name has these records, with the text keys in `spec/ens.json`:

| Record | Holds |
| --- | --- |
| `addr` (ETH) | The `ExamRegistry` address |
| `text` `ens.records.tee` | The TEE URL |
| `text` `ens.records.storage` | The public storage URL |
| `text` `ens.records.bucket` | The storage bucket the TEE was started with |
| `text` `ens.records.arkivWriters` | The Arkiv writers the board publishes, as addresses separated by commas (`arkiv.md`, "Writers") |

A reader checks a name with the viewer's own RPC, on-chain only (`ens.ccipRead` is `false`, so no offchain gateway is asked), and fails unless all of these hold:

1. The whole name is normalised, its first label is a valid exam name, and that label's `labelhash` is the `examId` used for every other check.
2. The name's `addr` record is set, the code at that address passes the check in [Registry Code](#registry-code), and the board it holds is the address `board()` returns. After deployment, only that board can write to a contract running this code. Answering `board()` alone isn't enough, because any contract can return the real board's address. Code can't show how storage was set at deployment, because a custom constructor can fill it before returning this code, so whoever can set the name's `addr` record must be trusted as much as the board.
3. That board address's primary name, read by reverse resolution, is exactly `parent`.
4. `parent`'s own `addr` record is that board address, so the primary name is verified both ways.

A read that needs an offchain gateway fails at its check, rather than being retried as an RPC outage. Every chain read on a name route, including the later `ExamRegistry` reads, has CCIP-Read off. `ExamRegistry` never asks for an offchain lookup, so this costs nothing.

The TEE, storage and bucket records only say where to look. A wrong value makes the later checks fail; it can't make them pass. A TEE or storage record that isn't an `http` or `https` URL fails check 2, the same rule the verifier's own settings have. This build reads ENS on Sepolia only, the chain in `constants.json`. On Sepolia anyone can register a look-alike parent, so the check means something only once the reader supports a mainnet name.

## TEE Lifecycle

The TEE runs each stage by itself, with no board calls, so it needs no board login. It serves HTTPS on port 8080 directly, with a self-signed P-256 certificate generated in memory at startup and never written to disk, so Cloudflare's connection to the origin is never downgraded to plain HTTP. The certificate is valid for `tee.abdulrashid.dev` and any host, and has no trust role: apps trust the attestation and HPKE, not this certificate. TLS 1.2 is the minimum version.

1. **Onboard:** register until the list appears on-chain, then check it.
2. **Submit:** accept questions from setters on the list until the lock round is published.
3. **Lock:** check the bank against the criteria. On failure the stage becomes `failed`, and the exam can't go ahead.
4. **Build and Distribute:** run straight after Lock, ending with the Build in the outbox for the board to post.
5. **Unlock:** accept shares once `unlockRound` is published, as in "Unlock Instance" on a new instance.

Duplicate questions are rejected only for the same setter, so a setter can't test guesses about other setters' questions. `maxSetterPercent` limits each setter's share of a topic's bank. `seed` is 32 random bytes generated after Lock. `selected` questions are picked at random per topic, using randomness that never leaves the TEE.

## TEE API

All bodies are JSON. Every route allows any origin, without credentials. Bytes follow the conventions above.

| Route | Request | Response |
| --- | --- | --- |
| `GET /v1/attestation` | None | `{token, instancePublicKey, encryptionPublicKey, instanceKeySignature}` |
| `GET /v1/status` | None | `{stage, examId, questionCount, approvedList?: {examId, entries, hash, teeSignature}, release: {released: hex[], required}}`. `examId` is the exam this instance was started for, because it serves only that one and `stage` says nothing about any other. |
| `POST /v1/register/challenge` | `{}` | `{challenge}` |
| `POST /v1/register` | `{owner, inviteTag, challenge, passkeyPublicKey, derivedPublicKey, attestationObject, clientDataJSON, signature, authenticatorData}` | `{}` |
| `GET /v1/registrations` | None | `{registrations: [{owner, passkeyPublicKey, derivedPublicKey, inviteTag}]}` |
| `POST /v1/questions/challenge` | `{}` | `{challenge}` |
| `POST /v1/questions` | `{passkeyPublicKey, ciphertext, challenge, signature, authenticatorData, clientDataJSON}` | `{questionHash, teeSignature}` |
| `GET /v1/outbox` | None | `{messages: [{kind: "build", examId, fields, teeSignature, instancePublicKey}]}` |
| `POST /v1/release/challenge` | `{}` | `{challenge}` |
| `POST /v1/release/share` | `{passkeyPublicKey, challenge, sealed}` | `{}` |
| `GET /v1/release/log` | None | `{examId, entries, entriesHash, files: [{name, sha256}], filesHash, teeSignature, instancePublicKey}` |

`release.released` lists the passkey public keys of holders whose shares were accepted. In an outbox message, `examId` sits at the top level, and `fields` holds the other `build` message fields, with `selected`, `bankSize` and `builtRound` as decimal strings. `stage` is one of `onboard`, `submit`, `lock`, `build`, `distribute`, `unlock`, `released`, `failed`. `register`'s passkey signature covers the `registration` message, signed in a `webauthn.get` ceremony. That proves the key whether it was created a moment ago, as for a setter, or at enrolment, as for a party. The same flag checks and challenge rules apply to both. A challenge works only on the instance that issued it, so a signature made for one exam can't be replayed on another. `register` refuses a zero `inviteTag` with an empty `derivedPublicKey`, and refuses an `owner` that is empty, not valid UTF-8 or longer than `limits.ownerBytes`, the same limit readers apply to the approved list, so every registration fits on the list.

`GET /v1/release/log` answers `503` with code `delivery_pending` between the threshold and the delivery being prepared, because a log at the threshold must list its files. Once prepared, it answers with the same bytes as `release-log.json`.

## Unlock Instance

Unlock can run on a new TEE instance that shares no state with the one that ran the Build. Only the instance that ran Onboard holds registrations, so `CheckRegistered` applies at Onboard alone. Before accepting a share, an Unlock instance must:

1. Read `getBuild` and `getApprovedList` from `ExamRegistry`, as in "Approved List", and read `entries`.
2. Fetch the Build instance's PKI attestation token. It is listed in the storage manifest, so `storageManifestHash` commits to it.
3. Check that token against Google's root in the attested image and the on-chain exam settings, as in the README's claim table. Its `eat_nonce` must bind `build.instancePublicKey`. The token is a record, so check its signature as of its `iat` and skip the expiry check.
4. Verify `build.teeSignature` over the `build` message with `build.instancePublicKey`.
5. Check that `build.approvedListHash` equals the on-chain list hash and the hash of `entries`.

An instance that holds no registrations waits in `onboard` until it can see the Build, and refuses registrations once the list is visible, so start spare instances after the list is posted. If any step fails, the instance refuses every share. After these checks it trusts the on-chain list without re-checking registrations, because the attested Build instance already committed to that list.

## Attestation Token

`GET /v1/attestation` and the published files always use the PKI token type, because a browser can check it against Google's root without fetching keys. `spec/fixtures/confidential-space-claims.json` holds the claims of a real token from an earlier test.

The launcher sets these claims under `submods.container`, and readers compare them exactly:

| Claim | Expected value |
| --- | --- |
| `cmd_override` | The startup arguments |
| `args` | `/tee`, then the startup arguments |
| `env_override` | `{"STORAGE_BUCKET": <bucket>}` |

`submods.container.env` also holds variables from the base image, such as `PATH` and `HOSTNAME`, so readers don't compare it. Only `env_override` shows what the operator set.

## Attestation Nonce

`eat_nonce` is the lowercase hex, with no `0x` prefix, of the `attestationNonce` message, with fields `bytes instancePublicKey`, `bytes32 examId`.

## TEE API Errors

Errors return a non-2xx status and `{"error": {"code": "<snake_case>", "message": "<text>"}}`.

## Registration Flooding

The TEE can't check who may register. It never could, because it never sees an invite secret, so the public exam page adds no new power: anyone with a software key could already register. What limits a flood:

- Each registration costs a fresh signed challenge and a passkey signature, and a passkey or derived key registers once. The spent-challenge set is capped at 100,000, and past that the TEE answers `busy` until challenges expire.
- Each request body is at most 1 MiB. The TEE holds no other cap on registrations, so a sustained flood costs it memory until Onboard ends and makes `GET /v1/registrations` slower.
- A flood can't take anyone's place. A registration under someone's name with another key never joins the list, and it doesn't block their own, because only the passkey and derived key must be unique. The list itself is capped by `limits.entries`.
- The board app shows only a count of registrations that match nobody, in one line, so a flood can't bury the list.
