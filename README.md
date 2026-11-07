# Paper Seal

Leak-proof exam papers: no single person can see or unlock the paper before the exam starts.

> **Status:** hackathon build for ETHGlobal Mumbai 2026. A whole exam runs end to end on Sepolia, with the TEE on Google Confidential Space. Security keys are simulated with Chrome's virtual authenticator, so the hardware key check is off ([Hardware Keys](#hardware-keys)).

## Try It

| | |
| --- | --- |
| Public verifier | [A finished demo exam](https://34-93-7-127.sslip.io/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3) and [every exam](https://34-93-7-127.sslip.io/#/exams). It runs on a temporary VM for the event |
| `ExamRegistry` on Sepolia | [`0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb`](https://sepolia.etherscan.io/address/0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb) |
| Arkiv writer | [`0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`](https://rabdi.explorer.arkiv.network/address/0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b) on Rabdi. A query to run is in [Arkiv Copy](#arkiv-copy) |
| Demo video | To be added |

## Run It

You need Node 22 or later and pnpm 10. `make build` and `make test` also need Go 1.25 and Foundry.

```bash
pnpm install
```

**The verifier, against the live demo exam.** Put this in `apps/verifier/.env.local`:

```bash
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
VITE_REGISTRY_ADDRESS=0xc25F7e0004f0E9B77581CFf6B4B5Ae8b120658eb
VITE_STORAGE_URL=https://storage.googleapis.com/paperseal-demo-paperseal-exams
VITE_TEE_STORAGE_BUCKET=paperseal-demo-paperseal-exams
VITE_ARKIV_WRITERS=0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b
```

Then run `pnpm --filter @paperseal/verifier dev` and open `http://localhost:5172/#/exam/0x83b30c31827789be7213e71731864d40ea7a89b92844ab09070cd132cccfd4c3`.

**A whole exam on your machine.** `pnpm --filter @paperseal/e2e ui:mock` runs every role in Chrome against a local chain in about ten minutes. It needs Chrome, ffmpeg and Foundry's `anvil`. A TypeScript stand-in replaces the TEE, so it is a test, not a real run ([Mock run](docs/ARCHITECTURE.md#mock-run-test-only)).

**A real exam.** [deploy/README.md](deploy/README.md) sets up the TEE on Google Cloud and `ExamRegistry` on Sepolia, and `pnpm demo:keys` runs every role from one tab.

## Hackathon Prizes

Built from scratch at ETHGlobal Mumbai, 5 to 7 November 2026: the first commit is from 5 November, and the Arkiv and Swarm work started on 6 November.

| Prize | Where to look |
| --- | --- |
| ENS: Best Use of ENSv2 | [ENSv2 in Paper Seal](docs/ensv2.md) |
| Arkiv: Build on Arkiv | [Arkiv Copy](#arkiv-copy) and [`arkiv/`](arkiv): [schema](arkiv/schema.md), [how we use it](arkiv/how-you-use-arkiv.md), [why Arkiv](arkiv/why-arkiv.md), [reach](arkiv/reach.md), [friction](arkiv/friction.md) |
| Arkiv + Swarm bonus | [`arkiv/swarm.md`](arkiv/swarm.md) |
| Ethereum Foundation: Best CROPS App | [CROPS](#crops) |

## Overview

Paper Seal removes the need to trust any single person with an exam paper. Open-source paper-setter code assembles the paper inside a trusted execution environment (TEE) on Google Cloud, so no single human sees the final version. The paper stays encrypted until shortly before the exam. Unlocking it takes both a public time seal and a threshold of private key holders, so neither side can open it alone. [Trust Assumptions](#trust-assumptions) lists the limits of this guarantee.

Exam boards and centres don't need to understand any of this. The cryptography sits behind a simple interface.

### Goals

- **No single point of leakage:** no one person sees the final paper or holds the whole key.
- **Fair:** every exam centre gets the same paper.
- **Transparent:** as much as possible is open to verification without leaking the paper.
- **Accountable:** ideally, anyone who tries to collude can be identified.
- **Simple to use:** exam boards and centres never handle the cryptography directly.

### Scope

Paper Seal currently covers electronic distribution only. Printed papers, TEE restarts during paper setting, tuning `Δ` and tampered setter apps are out of scope for now.

### Terms

| Term | Meaning |
| --- | --- |
| `T` | Exam start time |
| `T−Δ` | Unlock time, shortly before the exam |
| `K` | The key that encrypts the paper, where `K = K_pub ⊕ K_priv` |
| `K_pub` | The public half, released by the time seal |
| `K_priv` | The private half, rebuilt from key holders' shares |
| End round | The drand round at the end of the exam |
| `x` of `n` | `x` questions selected from a bank of `n` |
| Key holder | One of the 7 centres or 3 neutral parties holding a share of `K_priv` |
| Approved centre | A registered centre that receives `K_priv` at unlock, whether or not it holds a share |

## Users

| User | What they do |
| --- | --- |
| **Board admin** | Sets the blueprint (topics, questions per topic and setter limits), schedule and `Δ`, onboards setters, key holders and centres, posts the approved list, hosts the web apps, runs the TEE and posts its signed messages on-chain. |
| **Setter** | Registers a security key, signs in and uploads questions, then gets a "sealed ✓" receipt. |
| **Centre** | Enrols a security key once, downloads the encrypted paper, watches the countdown, unlocks with that key and sees an unlock log. |
| **Neutral party** | Enrols a security key once, holds a share and releases it at unlock, without receiving the paper's key. |
| **Directory owner** | Controls the parent ENS name and writes which security key belongs to which party's name. |
| **Public** | Uses the verifier page to see the code hash, attestation, commitments, approved list and live unlock status, then a full proof after the exam. |

## How It Works

1. **Onboard:** the TEE starts. The board picks key holders and approved centres from a directory of ENS names and invites setters by private link, and each registers through the TEE. The board posts the final list on-chain, where anyone can see it, and the TEE reads it back over TLS and checks it.
2. **Submit:** setters on the list send questions directly to the TEE, encrypted to its key. The TEE holds the bank in memory, rejects questions in the wrong format and returns a signed receipt.
3. **Lock:** at the lock round, the TEE locks the bank by itself if it meets the attested selection criteria: no setter above a set percentage of a topic, and a bank for each topic several times larger than its question count.
4. **Build:** the attested, open-source TEE builder generates a private seed after Lock and uses it to pick a set number of questions per topic at random, so no setter can influence or work out the selection. It assembles the one identical paper, pads it to a fixed size and encrypts the paper and seed with `K`.
5. **Split:** the TEE splits `K` into `K_pub` and `K_priv`. It timelocks `K_pub` and cuts `K_priv` into shares.
6. **Distribute:** the TEE stores the encrypted paper, timelocked `K_pub` and encrypted shares on public storage. Only then does the signed Build go on-chain, listing the approved list hash and the hash of each file, so a crash can't leave a committed paper that nobody can open. `ExamRegistry` accepts only one Build per exam. Centres download the files days ahead and check them against the Build.
7. **Unlock:** at `T−Δ`, the time seal releases `K_pub` and key holders submit their shares to the TEE. The TEE rebuilds `K_priv` and sends it to approved centres, and the centre app combines the two halves and decrypts the paper.
8. **Verify:** at the end round, drand opens the paper to everyone, and anyone can check the selection proof and that the paper matches the committed hash.

## Security Design

### Key Split

| Half | Held by | Released by |
| --- | --- | --- |
| `K_pub` | Time seal (drand timelock) | The public network at `T−Δ` |
| `K_priv` | 7 centres and 3 neutral parties, as Shamir shares | 8 of the 10 key holders, through the TEE, at `T−Δ` |

- Any 8 shares rebuild `K_priv`, and 7 reveal nothing about it.
- Centres alone can't reach the threshold, so at least one neutral party must take part.
- Up to 2 key holders can go offline without stopping the unlock.
- Each share is encrypted to its holder. Holders could pool shares early, but `K_priv` alone can't open the paper without `K_pub`.

### Hardware Keys

Each key holder and approved centre has a root secret in a hardware security key, and the secret can't be exported.

1. **Enrol:** once, the web app creates a device-bound passkey on the security key and requests its attestation. It shows a key card of public values, and the directory owner puts them on the person's ENS name. This identity is permanent and is used for every exam.
2. **Derive:** for each exam, the app signs in with that passkey and uses the WebAuthn PRF extension to derive a keypair. The PRF input is a hash of the fixed salt in `spec/constants.json` and the exam ID, so each exam has its own keypair, and a leak of one opens no other exam's material. Every request requires user verification, because a security key can give a different output without it. The private key is never stored.
3. **Register:** the TEE sends a fresh challenge. The passkey signs a hash of the derived public key, the holder ID and the challenge. This takes two touches: one for the derived key, then one to sign, because the derived key is part of what is signed. The app sends the derived public key, the signature and the attestation from enrolment.
4. **Check:** the TEE checks the passkey signature and, with hardware attestation on, the attestation chain. Anyone who fails doesn't go on the approved list.
5. **Deliver:** after the Split, the TEE encrypts each key holder's share to their derived public key and publishes it with a hash of the share.

Synced passkeys are not accepted, because they copy the secret to a cloud account. The attestation and the passkey's backup flags are checked to enforce this.

Keys sit behind one small interface (`generateKey`, `getPublicKey`, `decryptShare`, `sign`) and the same WebAuthn code runs in both modes:

- **Dev and demo mode:** Chrome's virtual authenticator with PRF enabled mocks the security key. It is software, so the hardware attestation check is skipped by an attested setting the verifier page shows, and the demo is simulated. This is the only mode in the hackathon build. `pnpm demo:keys` does the same in one tab, with a software authenticator in the page holding a planted key per person (see [deploy/README.md](deploy/README.md)). A production build cannot contain it.
- **Production mode:** a hardware security key through WebAuthn PRF.

### Approved List

The board posts one final list per exam on-chain, and the TEE reads it back over TLS, so the board's network can't change who is approved. The list is public, so anyone can see every key holder and approved centre, and which key each one holds. Setters appear only as a hash of their public key, and their names are never published, so the list doesn't show who to pressure.

The TEE knows the board through its attested settings: they name `ExamRegistry`, and only that contract's fixed board address can write to it. The TEE and the verifier page check that the code at that address is `ExamRegistry`'s, so a different contract can't stand in for it. The verifier shows the board address that code holds. The board announces the contract address on its official site, which is how everyone else knows it is the real board.

1. **Register:** the board picks each key holder and centre by ENS name and shares one public exam link. No secret gates it, and none is needed: a registration joins the list only if its passkey hash equals the name's published record, so knowing someone's name isn't enough to take their place. The board sends each setter a private invite link with a secret instead, because a setter has no public identity. Setters register a passkey only, because nothing is ever encrypted to them, and they need no name. Registration works as in [Hardware Keys](#hardware-keys).
2. **Post:** the board's address posts the list to `ExamRegistry`, where it can be written only once. Each entry has the owner, role, passkey public key and derived public key. The contract stores a hash of the list and emits the full list, so reading it doesn't depend on storage the board controls.
3. **Read:** the TEE reads the list at a finalised block from the RPC operator named in its attested settings. Development builds read the latest block to run faster, and the verifier page shows this. The TLS root certificates are part of the attested image, so the board can block this read but can't change it.
4. **Check:** the TEE rejects the list if any entry wasn't verified at registration. It signs the list hash into the Build, and `ExamRegistry` rejects a Build whose hash differs from the posted one.
5. **Use:** the TEE accepts questions only from setters on the list, and encrypts shares and `K_priv` only to keys on the list. Each published copy names its recipient. The verifier page compares recipients with the list, and each centre can check its own entry.

### Exam Names

An exam's name is a plain ENS label such as `jee-main-2026`, and its exam ID is that label's hash. A board can give an exam an ENS name under its own primary name, such as `jee-main-2026.paperseal.eth`, so anyone can check the exam by typing its name instead of a contract address and exam ID.

The verifier page fails the name unless it points to a contract running exactly `ExamRegistry`'s code, whose board address has that parent as its primary name, verified both ways. Every read is on-chain, through the viewer's own RPC. It then runs every other check as usual. ENS only helps people find the real exam. The TEE and `ExamRegistry` never read it, and a name that points somewhere wrong makes the later checks fail, not pass. On Sepolia anyone can register a look-alike name, so the check only means something with a mainnet name. If a name leads to a different contract from the one the page is set up to read, the page warns about it first. [ENS setup](docs/ens-setup.md) shows how to name an exam.

### Party Names

A key holder or a centre has one permanent identity: an ENS name that publishes their security key, such as `centre-1.paperseal-demo.eth`. There is no wallet, no invite link and no secret, and there are no plain names. The name goes on the public list. Setters never have a name on the list.

1. **Enrol:** the person opens `/enrol`, touches their security key once and sends the resulting key card to the directory owner. Nothing on the card is secret.
2. **Publish:** the directory owner writes two text records on the person's name, `paperseal.passkey` with the hash of the key and `paperseal.credential` with its credential ID, and lists the name in `paperseal.directory` on the parent. The list is only a menu: each name is checked by its own records.
3. **Choose:** the board ticks names from the directory, gives each a role, and shares the public exam link once.
4. **Register:** the person opens the link and touches their key. The record tells the browser which key to ask for, so this works in any browser on this domain.
5. **Match:** the board app compares each registration's passkey hash with the name's record. A match shows "Name confirmed". A name with no record, or a record for another key, stays off the list.

The verifier page shows, for each listed party with an ENS name, whether the record matches their key, with the evidence folded. It says plainly who vouches for the name: whoever controls its parent. This is a label and a proof of who holds a key, not something the exam depends on. A name that can't be read shows "not confirmed" and never fails a check. The TEE and `ExamRegistry` never read ENS. Names are read on Sepolia through the viewer's own RPC with no gateway, so they prove nothing until a mainnet name is used. Every name is a subname on its parent's ENSv2 Permissioned Resolver ([ENSv2 in Paper Seal](docs/ensv2.md)).

If a key is lost, the person enrols a new one and the directory owner replaces both records. A passkey belongs to one domain, so moving the app to another domain means everyone enrols again.

### Arkiv Copy

The board runs the TEE and the storage, so it could switch them off during unlock. To stop that hiding anything, a relay copies the unlock record to [Arkiv](https://docs.arkiv.network) as it happens.

- **What is copied:** the TEE's signed release log, and Google's token for the machine that signed it. Questions, shares and anything not already public never go on Arkiv.
- **Rows can't be changed.** They live for 180 days, and anyone can extend them.
- **The verifier checks every row** against the exam on Sepolia and ignores any row that fails. It shows the most progress it can verify, from storage, the TEE or Arkiv.
- **Silence shows.** During unlock the relay writes a heartbeat every minute, so the verifier warns if the copy stops.
- **Exam index.** The relay also lists every exam in a registry and its approved people, because `ExamRegistry` can't list its own exams. The verifier's `#/exams` page searches it.
- **Swarm backup.** Each exam's public files are backed up to [Swarm](https://www.ethswarm.org), with the reference on Arkiv. If the bucket is gone, the verifier reads the files from Swarm and checks them against Sepolia ([`arkiv/swarm.md`](arkiv/swarm.md)).

A board lists its writers in the exam's ENS name. The rules are in [`spec/arkiv.md`](spec/arkiv.md), and the relay is in [`relay/`](relay).

**Writer:** [`0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b`](https://rabdi.explorer.arkiv.network/address/0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b) on Arkiv's Rabdi testnet.

**A query to run.** It lists every release log the writer copied. Change the schema to `paperseal.v1.exam` to list the exams:

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H "content-type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'paperseal.v1.release-log'"'"') AND $creator = addr(0x1E6220497eCc77edeA4E79d73CB194Bb2D1b188b)",{"select":{"key":true,"attributes":true,"count":true}}]}'
```

The data comes from Paper Seal's own demo exams, and the repo is [MIT](LICENSE) licensed. The [`arkiv/`](arkiv) folder answers the Arkiv prize's questions.

### Question Submission

Setters talk to the TEE directly, and the board's infrastructure only ever carries ciphertext.

1. **Confirm:** the setter app checks the TEE's attestation and confirms that the list hash the TEE signed matches the on-chain hash.
2. **Encrypt:** the app pads each question to a fixed size and encrypts it with HPKE to the TEE's attested key.
3. **Sign:** the setter touches their security key. The passkey signs the exam ID, a fresh TEE challenge and a hash of the ciphertext.
4. **Check:** the TEE confirms that the setter is on the list and the signature is valid, then decrypts the question, checks its format and topic, and holds it in memory. A question is written or multiple choice. Correct answers are never sent, because the paper becomes public after the exam.
5. **Receipt:** the TEE signs a receipt with the question hash, using its instance key, and the app shows "sealed ✓". After the Build, the app checks that the same instance key signed the Build, which shows the question went to the TEE that built the paper.

### Share Release

Released shares stay private. The TEE collects them and delivers `K_priv` only to approved centres.

1. **Confirm:** at `T−Δ`, the app checks the TEE's attestation and confirms that the list hash the TEE signed matches the on-chain hash.
2. **Submit:** a key holder touches their security key once, and that touch gives two things. The passkey signs the exam ID and a fresh TEE challenge, which proves this holder is releasing. The PRF output lets the app re-derive the holder's personal private key from [Hardware Keys](#hardware-keys), which is never stored. This key isn't `K` or `K_priv`, and it opens only that holder's encrypted share. The app decrypts the share and discards the key, then sends the share and signature, encrypted to the TEE's attested key.
3. **Check:** the TEE confirms that the drand round is published, the holder is on the list, and the signature and share hash are valid.
4. **Rebuild:** once it has 8 valid shares, the TEE rebuilds `K_priv`.
5. **Deliver:** the TEE encrypts `K_priv` to each approved centre's derived public key, then publishes the encrypted copies, a copy of `K_priv` timelocked to the end round and a signed release log that lists the hash of each of those files. Neutral parties don't receive `K_priv` at unlock.
6. **Decrypt:** a centre staff member touches the security key. The app recovers `K_priv`, combines it with `K_pub` from drand and decrypts the paper. It then recomputes the salted paper hash and refuses to show the paper if that doesn't match the Build.

Unlock runs on one TEE instance, so shares can't split across instances. It keeps no long-term state, so if it stops, the board starts a new one and holders resubmit. That instance doesn't need the one that ran the Build. It verifies the Build's signature against the published attestation token, then trusts the on-chain list that the Build committed to.

The verifier page shows which holders have released and the signed log during `Δ`. Shares themselves are never published.

### Accountability

Every share submitted through the TEE carries a signature from the holder's attested passkey, so that release is tied to a physical key touch by that holder.

Holders could pool shares privately, and that wouldn't appear in the log. Before `T−Δ` this opens nothing, because `K_pub` is still sealed.

A leak after a centre decrypts the paper can't be traced to that centre.

### Proving the TEE Code

Anyone can check that the TEE runs the exact open-source code, unchanged. The TEE runs on Google Confidential Space, which adds workload attestation on top of Confidential VMs.

1. **Build:** a tagged commit builds into a single-architecture container image reproducibly, with pinned dependencies, base images and toolchain, and fixed timestamps. Rebuilding that commit gives the same image digest.
2. **Publish:** each tagged version is built twice on a clean GitHub runner and published as a release with its commit hash and image digest, and the board picks a version in the app. The commit hash, image digest and exam settings go on-chain in `ExamRegistry` before Onboard, and can't be changed. The full selection criteria go on-chain with them, so anyone can read them and check `criteriaHash`. `ExamRegistry` stores `T` and `Δ` and rejects an unlock round that doesn't match them under quicknet's timing, and the verifier page shows each round as a clock time. The TEE, the board app and the verifier page also limit `Δ` to 24 hours and the end round to 7 days after `T`, so the paper can't be set to open at a round that never comes.
3. **Deploy:** the image is deployed by digest, never by tag, on the production Confidential Space image. Its startup arguments carry the exam settings: the exam ID, `T`, `Δ`, lock round, unlock round, end round, selection criteria hash, `ExamRegistry` address, chain ID and RPC operator host. They are passed with `tee-cmd`, so the image sets the `tee.launch_policy.allow_cmd_override=true` label.
4. **Attest:** the TEE generates a keypair and requests a Google-signed attestation token, with a hash of its public key and the exam ID as the nonce. Tokens last about an hour, so apps ask for a fresh one when they connect, and anything published uses the PKI token type so it can be checked later.
5. **Verify:** the setter app, centre app and verifier page each check the token before trusting the TEE. Setter apps encrypt questions to the TEE's key only after this check passes.
6. **Bind:** each TEE instance generates an attested signing key and signs its outputs with it, so each output traces back to the published code. The signing key also signs the instance's separate encryption key, and apps check that before encrypting anything.

| Token claim | Expected value |
| --- | --- |
| Signature | Verifies against Google's published keys or root |
| `iss` | `https://confidentialcomputing.googleapis.com` |
| `aud` | Paper Seal's custom audience |
| `iat`, `exp` | Valid for live checks. Published tokens are a record of when they were issued. |
| `swname` | `CONFIDENTIAL_SPACE` |
| `dbgstat` | `disabled-since-boot` |
| `hwmodel` | An approved Confidential VM type |
| `secboot` | `true` |
| `submods.confidential_space.support_attributes` | Includes `STABLE` |
| `submods.container.image_digest` | The digest recorded on-chain |
| `submods.container.args`, `submods.container.cmd_override`, `submods.container.env_override` | The arguments match the on-chain exam settings, and the operator set only the storage bucket |
| `eat_nonce` | The hash of the TEE's public key and the exam ID |

A TEE given fake exam settings fails this check, whichever Google Cloud project it runs in. A copy given the real settings can't post anything, because `ExamRegistry` accepts writes only from the board's address. The contract only checks the format of a Build's signature. Apps and any fresh TEE instance verify it against the attestation token, so a Build the TEE didn't sign fails those checks.

The verifier page shows each check, and anyone can rebuild the commit themselves and compare digests. It needs no private key and all its data is public, so anyone can host their own copy instead of trusting a hosted one. The [Reproducible build](.github/workflows/repro.yml) action does this for any commit on a clean GitHub runner:

```bash
gh workflow run repro.yml -R AbdulRashidReshamwala/paperseal -f commit=<full commit hash> -f expected_digest=<on-chain digest>
```

### Post-Exam Proof

The question bank is never revealed, so unused questions stay private. The Build the board posts on-chain is signed by the TEE's attested key. It says the TEE selected `x` questions from `n` against the published criteria, and includes a hash of the paper salted with the private seed.

The paper stays with approved centres from `T−Δ` until the end round. At that round, drand opens the timelocked copy of `K_priv` published at unlock. Together with `K_pub`, it lets anyone decrypt the paper and seed, with no further action from key holders. If the unlock never happens, no such copy exists and the paper stays sealed. That allows two checks:

- **Selection:** the signed Build matches the published criteria, and the paper has `x` questions. This is attested by the TEE, not independently proven, because the bank stays hidden.
- **Same paper:** hashing the paper with the seed gives the committed hash. Anyone with a copy of the exam can compare it with this paper, but cryptography can't prove what a centre showed students.

## CROPS

**Lead property: censorship resistance.** The exam board runs the servers, but it can't stop the paper opening or hide who released their key. Try it: point the verifier at a bucket that doesn't exist. It still checks the exam and opens the paper from Swarm and Arkiv ([steps](arkiv/swarm.md#run-it-yourself)).

**C: Censorship resistant.**
- The board controls the app's domain, the TEE, the storage bucket and the default RPC.
- Bucket gone: the files come from the [Swarm backup](arkiv/swarm.md). TEE gone quiet: the signed unlock record is still on [Arkiv](#arkiv-copy).
- The verifier is a static page anyone can host, and viewers can use their own RPC.
- Limits: if the board doesn't run the TEE at unlock, centres wait until the end round, when drand opens the paper to everyone. Passkeys only work on the app's domain, so key holders can't release while that domain is down.

**O: Open source.**
- [MIT](LICENSE). Everything builds and runs from this repo ([Run It](#run-it)).
- The TEE image is reproducible: anyone can rebuild a commit and compare it with the digest on-chain ([Proving the TEE Code](#proving-the-tee-code)).
- A real exam also needs a Google Cloud project and a Sepolia wallet.

**P: Private.**
- Questions go encrypted from the setter's browser to the TEE. They never go on-chain, on Arkiv or on Swarm.
- Setters appear on the public list only as a hash.
- The RPC, the bucket, the Swarm gateway, Arkiv's RPC, drand and GitHub see a viewer's IP and which exam or files they read. Viewers can pick their own RPC.
- No trackers or analytics. Fonts are self-hosted.

**S: Secure.**
- Each person's keys come from their security key and stay on their device. They're derived when needed through WebAuthn PRF and never stored.
- Every action needs a key touch.
- The paper is encrypted with AES-256-GCM. Its key is split between a drand time seal and 8-of-10 Shamir shares, so nobody can open it alone or early.
- We trust Google's attestation, drand and the board serving honest app code ([Trust Assumptions](#trust-assumptions)). The demo simulates the security keys.

## Trust Assumptions

### TEE and Google Cloud

- The Google Cloud TEE is trusted, and physical tampering with it is out of scope.
- Google signs the attestation token, so it is trusted to report the running code honestly.
- Attestation proves which code is running, not that the code is free of bugs. That depends on the code being open to review.
- The TEE briefly holds the whole of `K` before splitting it. This adds no new trust, because it already builds the paper.
- The exam board runs the TEE and controls its network, so it can block what the TEE reads, but TLS stops it changing those reads. Exam settings are attested, and the approved list is read from `ExamRegistry`.
- The TEE trusts the RPC operator to report the chain honestly, because it can't verify chain data itself. A false list can't reach the Build, because `ExamRegistry` rejects its hash, and at unlock apps compare the TEE's list hash with the chain through their own RPC.

### Board

- The board chooses the key holders. Key ownership is public, so anyone can judge whether the neutral parties are really neutral.
- The directory owner decides which key belongs to which name, and can swap a record at any time. A swap is public on the chain, and a posted list keeps the key it was posted with. A record says only that the directory owner put it there.
- In the demo the board owns the directory and issues the neutral parties' records too, so the neutrals aren't independent of the board. A real exam needs each neutral to use a name they own, or a directory the board doesn't control.
- The exam date is written once to `ExamRegistry` and can't be changed, even by the board.
- `ExamRegistry` doesn't compare a Build with block time, so the board could post one late. The verifier page flags a Build posted after the unlock time, as a warning that doesn't fail the exam.
- `ExamRegistry` accepts writes only from the board's address. The board could route setters to a different TEE instance, but the receipt check shows this after the Build, and an unusually low question count would show on-chain.

### Selection

- Attestation proves the published code made the selection. That code holds the bank in memory and applies the attested criteria, so the proof relies on the TEE instead of a public re-run of the selection.
- The criteria set how many questions come from each topic and limit each setter's share of a topic. Questions are picked at random, and the TEE relies on the topic each setter assigns.
- Setters know their own questions, so one could recognise a selected question. A setter with 10% of the bank is likely to know at least one question on a 20-question paper. The setter cap limits each setter's share of the paper, but doesn't remove this risk.
- Setter names are never published, so the public can't check who set the paper. The board still knows who it invited, so a leak from the board would show who to pressure.
- Nobody reviews question content, so a poor question could reach the paper with no way to replace it.

### Time

- drand is the only clock. `K_pub` relies on it, so if it is compromised, 8 key holders could open the paper early. The board could do this alone with a tampered web app, because that app could collect holders' keys at registration.

### Keys and Web App

- A private key briefly sits in browser memory during registration and release, and whoever serves the web app could tamper with its code. A stolen share still can't open the paper early, because that needs 8 shares and the time seal. It can't be submitted in that holder's name without the security key either.
- Attestation proves a passkey is on approved hardware, but not that the derived keypair came from it. The board serves the web app, so it could swap in its own derived keys at registration for every holder and centre, because staff can't see what a security key signs. It could then read shares and `K_priv` at unlock with no key holder involved, and the release log would still look normal. The time seal still keeps the paper closed until `T−Δ`.
- Security keys protect against theft, not dishonest holders, because they can't enforce time. The timelock on `K_pub` is what stops the paper opening early.
- Attestation usually identifies a batch of security keys, not one key. The on-chain registration ties each key to a holder.
- The public exam page has no secret, so anyone can register under any name with a key of their own. That never reaches the list, because the key doesn't match the name's record, but the TEE can't refuse it. [Registration Flooding](spec/api.md#registration-flooding) says what limits it.

### Availability

- The TEE must be available at unlock, so a Google Cloud outage could delay the exam.
- drand must produce the `T−Δ` round, so a drand outage could delay or block the unlock.
- Any 3 absent key holders block the unlock, including the 3 neutral parties together.
- A lost security key can't be recovered for an exam already in progress, because that holder's share is encrypted to it. For later exams the directory owner replaces the records.
- Passkeys only work on the web app's domain, so if the site is down at `T−Δ`, nobody can use their security key, and moving the domain needs everyone to enrol again.
- The board must run the TEE at unlock, so it can block the exam by refusing.
- Sepolia or its RPC operator being down could stop the board posting on-chain or the TEE reading the list.
- If the setter limits aren't met, the bank doesn't lock and the exam can't go ahead.
- A storage outage or a centre's internet outage at `T−Δ` could stop holders or centres getting their encrypted copies.
- Any delay past the end round needs a new paper, because once unlocked, the paper opens publicly at that round.

### Distribution

- The encrypted paper is public, but only approved centres receive `K_priv`. Any centre can still leak the paper once it decrypts it, so `Δ` stays as short as possible.

## Tech Stack

| Layer | Choice |
| --- | --- |
| TEE | Google Confidential Space on Confidential VMs |
| TEE language | Go |
| Reproducible builds | BuildKit with fixed timestamps |
| Time seal | drand timelock on the quicknet network |
| Selection randomness | TEE private seed |
| Public chain | Sepolia |
| Chain reads | RPC operator over TLS, with root certificates pinned in the image |
| Contracts | Solidity with Foundry |
| Web apps | React and TypeScript, built with Vite as static files |
| Browser | Chromium only, for both registration and unlock |
| Hardware keys | Chrome's virtual authenticator as a mock for the demo, and a security key through WebAuthn PRF in production |
| Sign-in | Passkeys on security keys for board admins and setters, and permanent ones published on an ENS name for key holders and centres |
| Key split | XOR of `K_pub` and `K_priv`, with Shamir shares of `K_priv` |
| Crypto | P-256, HPKE and AES-256-GCM, using audited libraries |
| Paper format | JSON, rendered by the centre app |
| Encrypted paper storage | Public storage, with its hash on-chain |
| Public copy of the unlock | Arkiv, on the Rabdi testnet |
| File backup | Swarm, on the Sepolia testnet |
| Names | ENSv2 subnames on Sepolia |

## Build Order

### MVP

- TEE builder on Confidential Space, with a reproducible image, an on-chain digest and attestation checks
- Sepolia contracts (`ExamRegistry` and commitments)
- `K` split with a drand timelock and an 8-of-10 threshold
- TEE share release
- Centre app
- Verifier page

### Stretch

- Distributed key generation (DKG) with a threshold public key, so the TEE never holds `K_priv`
- A second timelock network with separate operators, so opening `K_pub` needs both clocks
- A light client or ZK proof, so the TEE can verify chain data without trusting the RPC operator
- World ID for setters
- Native setter app signed with a developer key

## How AI Was Used

We used Claude Code to help write the code, tests and docs. We wrote the design and the specs in `spec/` first, then gave it one part of the project at a time. Two rules were fixed: no custom cryptography, and unfinished code says "not implemented" instead of faking a check. We reviewed and tested every change ourselves, including the live runs on Sepolia and Arkiv.

AI is also a feature: the verifier's "Check with your own AI" button copies a prompt, so any AI agent can check an exam from the original sources without trusting our website ([spec/agent-verification.md](spec/agent-verification.md)).

## License

[MIT](LICENSE)
