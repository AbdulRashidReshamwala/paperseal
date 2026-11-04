# Paper Seal

Leak-proof exam paper distribution: a system that stops exam papers from leaking before the exam starts.

> **Status:** early design for a hackathon build. There is no code yet.

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
| **Board admin** | Sets the blueprint (topics, questions per topic and setter limits), schedule and `Δ`, onboards key holders and centres, hosts the web apps, runs the TEE and posts its signed messages on-chain. |
| **Setter** | Signs in and uploads questions, then gets a "sealed ✓" receipt. |
| **Centre** | Downloads the encrypted paper, watches the countdown, unlocks with a security key and sees an unlock log. |
| **Neutral party** | Holds a share and releases it at unlock, without receiving the paper's key. |
| **Public** | Uses the verifier page to see the code hash, attestation, commitments and live unlock status, then a full proof after the exam. |

## How It Works

1. **Onboard:** the TEE starts, and the board registers key holders and approved centres through it. The board then signs the final list, the TEE checks it, and the list goes on-chain.
2. **Submit:** setters submit questions to the bank. Each question is padded to a fixed size and encrypted to the TEE's key. The TEE rejects questions in the wrong format.
3. **Lock:** at the lock round, the TEE locks the bank if it meets the on-chain selection criteria: a cap on questions per setter in each topic, a minimum number of setters per topic, and a bank for each topic several times larger than its question count. The TEE keeps the Merkle root of the encrypted questions, and the root and question count go on-chain. Selection uses a later drand round, fixed in the exam settings, so no setter can influence which questions are picked.
4. **Build:** the attested, open-source TEE builder generates a private seed and mixes it with the public randomness, so the selection can't be computed from public data. It loads the whole bank before selecting, so what it fetches doesn't reveal the selection. It picks a set number of questions per topic, assembles the one identical paper, pads it to a fixed size and encrypts the paper and seed with `K`.
5. **Split:** the TEE splits `K` into `K_pub` and `K_priv`. It timelocks `K_pub` and cuts `K_priv` into timelocked shares.
6. **Distribute:** the TEE stores the encrypted paper, timelocked `K_pub` and encrypted shares on public storage. Only then does the signed Build go on-chain, so a crash can't leave a committed paper that nobody can open. `ExamRegistry` accepts only one Build per exam. Centres download the files days ahead.
7. **Unlock:** at `T−Δ`, the time seal releases `K_pub` and key holders submit their shares to the TEE. The TEE rebuilds `K_priv` and sends it to approved centres, and the centre app combines the two halves and decrypts the paper.
8. **Verify:** after the exam, anyone can check the selection proof and that the published paper matches the committed hash.

## Security Design

### Key Split

| Half | Held by | Released by |
| --- | --- | --- |
| `K_pub` | Time seal (drand timelock) | The public network at `T−Δ` |
| `K_priv` | 7 centres and 3 neutral parties, as Shamir shares | 8 of the 10 key holders, through the TEE, at `T−Δ` |

- Any 8 shares rebuild `K_priv`, and 7 reveal nothing about it.
- Centres alone can't reach the threshold, so at least one neutral party must take part.
- Up to 2 key holders can go offline without stopping the unlock.
- Each share is encrypted to its holder and timelocked to `T−Δ`, so key holders can't open or pool shares early.
- `K_priv` alone can't open the paper without `K_pub`.

### Hardware Keys

Each key holder and approved centre has a root secret in a hardware security key, such as a YubiKey, and the secret can't be exported.

1. **Create:** the web app creates a device-bound passkey on the security key and requests its attestation.
2. **Derive:** the app signs in with that passkey and uses the WebAuthn PRF extension, with a fixed salt, to derive a keypair. The private key is never stored.
3. **Register:** the TEE sends a fresh challenge. The app returns the derived public key, the attestation and a passkey signature over a hash of the derived public key, the holder ID and the challenge.
4. **Check:** the TEE checks the attestation chain and the passkey signature. Anyone who fails either check doesn't go on the approved list.
5. **Deliver:** after the Split, the TEE encrypts each key holder's share to their derived public key, timelocks the result to the drand round for `T−Δ`, and publishes it with a hash of the share.

Synced passkeys are not accepted, because they copy the secret to a cloud account. The attestation and the passkey's backup flags are checked to enforce this.

Keys sit behind one small interface (`generateKey`, `getPublicKey`, `decryptShare`, `sign`) with two backends:

- **Dev mode:** non-extractable WebCrypto software keys, so everyone can build and test in the browser.
- **Production and demo mode:** a hardware security key through WebAuthn PRF.

### Approved List

The board signs one final list per exam, so the TEE never relies on what its network tells it about who is approved.

1. **Sign:** after registration, the board signs the Merkle root of every key holder's and approved centre's passkey public key, derived public key and owner, together with the exam ID.
2. **Check:** the TEE verifies the signature with the attested board key and rejects any entry it didn't verify at registration. A forged list or one from another exam fails this check.
3. **Post:** the TEE signs the root, the board posts it on-chain, where it can be written only once, and the full list is published so anyone can see who holds which key.
4. **Use:** the TEE encrypts shares and `K_priv` only to keys on the list, and each published copy names its recipient. The verifier page compares recipients with the list, and each centre can check its own Merkle proof.

### Share Release

Released shares stay private. The TEE collects them and delivers `K_priv` only to approved centres.

1. **Open:** once the drand round for `T−Δ` is published, a key holder touches their security key. The app re-derives the private key in memory, decrypts its share and discards the key.
2. **Submit:** the app checks the TEE's attestation and confirms that the list root the TEE signed matches the on-chain root. A second key touch signs the exam ID, share hash and a fresh TEE challenge, and the app sends the share and signature, encrypted to the TEE's attested key.
3. **Check:** the TEE confirms that the drand round is published, the holder is on the signed list, and the signature and share hash are valid.
4. **Rebuild:** once it has 8 valid shares, the TEE rebuilds `K_priv`.
5. **Deliver:** the TEE encrypts `K_priv` to each approved centre's derived public key, then publishes the encrypted copies, a signed release log and a copy of `K_priv` timelocked to the end round. Neutral parties don't receive `K_priv` at unlock.
6. **Decrypt:** a centre staff member touches the security key. The app recovers `K_priv`, combines it with `K_pub` from drand and decrypts the paper.

Unlock runs on one TEE instance, so shares can't split across instances. It keeps no long-term state, so if it stops, the board starts a new one and holders resubmit.

The verifier page shows which holders have released and the signed log during `Δ`. Shares themselves are never published.

### Accountability

Every share submitted through the TEE carries a signature from the holder's attested passkey, so that release is tied to a physical key touch by that holder.

Shares are timelocked, so key holders can't pass usable shares to each other before `T−Δ`. After `T−Δ`, holders could pool decrypted shares privately, and that wouldn't appear in the log.

A leak after a centre decrypts the paper can't be traced to that centre.

### Proving the TEE Code

Anyone can check that the TEE runs the exact open-source code, unchanged. The TEE runs on Google Confidential Space, which adds workload attestation on top of Confidential VMs.

1. **Build:** a tagged commit builds into a single-architecture container image reproducibly, with pinned dependencies, base images and toolchain, and fixed timestamps. Rebuilding that commit gives the same image digest.
2. **Publish:** the commit hash, image digest and exam settings go on-chain in `ExamRegistry` before Onboard, and can't be changed.
3. **Deploy:** the image is deployed by digest, never by tag, on the production Confidential Space image. Its startup arguments carry the exam settings: the exam ID, lock round, selection round, unlock round, end round, selection criteria hash and board key. They are passed with `tee-cmd`, so the image sets the `tee.launch_policy.allow_cmd_override=true` label.
4. **Attest:** the TEE generates a keypair and requests a Google-signed attestation token, with a hash of its public key and the exam ID as the nonce. Tokens last about an hour, so apps ask for a fresh one when they connect, and anything published uses the PKI token type so it can be checked later.
5. **Verify:** the setter app, centre app and verifier page each check the token before trusting the TEE. Setter apps encrypt questions to the TEE's key only after this check passes.
6. **Bind:** each TEE instance generates its own attested key and signs its outputs with it, so each output traces back to the published code.

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
| `submods.container.args`, `submods.container.cmd_override`, `submods.container.env` | The arguments match the on-chain exam settings, and the environment is as expected |
| `eat_nonce` | The hash of the TEE's public key and the exam ID |

A TEE given fake exam settings fails this check, whichever Google Cloud project it runs in. A copy given the real settings can't post anything, because `ExamRegistry` accepts writes only from the board's address, and each write is signed by the TEE.

The verifier page shows each check, and anyone can rebuild the commit themselves and compare digests.

### Post-Exam Proof

The question bank is never revealed, so unused questions stay private. Before the exam, the TEE signs a selection statement with its attested key, and the board posts it on-chain. The statement says it selected `x` questions from `n` against the published criteria, and includes a hash of the paper salted with the private seed.

When the exam ends, drand opens the timelocked copy of `K_priv`. Together with `K_pub`, it lets anyone decrypt the paper and seed, with no further action from key holders. That allows two checks:

- **Selection:** the signed statement matches the on-chain criteria and question count, and the paper has `x` questions. This is attested by the TEE, not independently proven, because the bank stays hidden.
- **Same paper:** hashing the paper with the seed gives the committed hash. Anyone with a copy of the exam can compare it with this paper, but cryptography can't prove what a centre showed students.

## Trust Assumptions

### TEE and Google Cloud

- The Google Cloud TEE is trusted, and physical tampering with it is out of scope.
- Google signs the attestation token, so it is trusted to report the running code honestly.
- Attestation proves which code is running, not that the code is free of bugs. That depends on the code being open to review.
- The TEE briefly holds the whole of `K` before splitting it. This adds no new trust, because it already builds the paper.
- The exam board runs the TEE and controls its network, so the TEE doesn't rely on chain reads for what matters. Exam settings are attested, and the approved list is signed by the board.

### Board

- The board chooses the key holders. Key ownership is public, so anyone can judge whether the neutral parties are really neutral.
- The exam date is written once to `ExamRegistry` and can't be changed, even by the board.
- `ExamRegistry` accepts writes only from the board's address. The board could route setters to a different TEE instance. An unusually low question count would show on-chain, but setters can't easily confirm their own questions were included.

### Selection

- Attestation proves the published code made the selection. That code checks the bank against the Merkle root it computed at Lock and applies the attested criteria, so the proof relies on the TEE instead of a public re-run of the selection.
- The criteria set how many questions come from each topic and limit each setter's share of a topic. Questions are picked at random, and the TEE relies on the topic each setter assigns.
- Setters know their own questions, so one could recognise a selected question. A setter with 10% of the bank is likely to know at least one question on a 20-question paper. The setter limits cap each setter's share of the paper, but don't remove this risk.
- Nobody reviews question content, so a poor question could reach the paper with no way to replace it.

### Time

- drand is the only clock. `K_pub` and the share timelocks both rely on it, so if it is compromised, 8 key holders could open the paper early.

### Keys and Web App

- A private key briefly sits in browser memory during registration and release, and whoever serves the web app could tamper with its code. A stolen share still can't open the paper early, because that needs 8 shares and the time seal. It can't be submitted in that holder's name without the security key either.
- Attestation proves a passkey is on approved hardware, but not that the derived keypair came from it. The board serves the web app, so it could swap in its own derived keys at registration for every holder and centre, because staff can't see what a security key signs. It could then read shares and `K_priv` at unlock with no key holder involved, and the release log would still look normal. The time seal still keeps the paper closed until `T−Δ`.
- Security keys protect against theft, not dishonest holders, because they can't enforce time. The share timelock is what stops holders opening shares early.
- Attestation usually identifies a batch of security keys, not one key. The on-chain registration ties each key to a holder.

### Availability

- The TEE must be available at unlock, so a Google Cloud outage could delay the exam.
- drand must produce the `T−Δ` round, so a drand outage could delay or block the unlock.
- Any 3 absent key holders block the unlock, including the 3 neutral parties together.
- A lost security key can't be recovered, because that holder's share is encrypted to it.
- Passkeys only work on the web app's domain, so if the site is down at `T−Δ`, nobody can use their security key.
- The board must run the TEE at unlock, so it can block the exam by refusing.
- Sepolia or its RPC provider being down could stop the TEE posting on-chain.
- If the setter limits aren't met, the bank doesn't lock and the exam can't go ahead.
- A storage outage or a centre's internet outage at `T−Δ` could stop holders or centres getting their encrypted copies.
- Any delay past the end round needs a new paper, because the paper opens publicly at that round.

### Distribution

- The encrypted paper is public, but only approved centres receive `K_priv`. Any centre can still leak the paper once it decrypts it, so `Δ` stays as short as possible.

## Tech Stack

| Layer | Choice |
| --- | --- |
| TEE | Google Confidential Space on Confidential VMs |
| TEE language | Go |
| Reproducible builds | BuildKit with fixed timestamps |
| Time seal | drand timelock on the quicknet network |
| Selection randomness | drand |
| Public chain | Sepolia |
| Contracts | Solidity with Foundry |
| Web apps | React and TypeScript, built with Vite as static files |
| Browser | Chromium only, for both registration and unlock |
| Hardware keys | Security key through WebAuthn PRF |
| Sign-in | Passkeys on YubiKeys for board admins and setters |
| Key split | XOR of `K_pub` and `K_priv`, with Shamir shares of `K_priv` |
| Crypto | P-256, HPKE and AES-256-GCM, using audited libraries |
| Paper format | JSON, rendered by the centre app |
| Encrypted paper storage | Public storage, with its hash on-chain |

## Build Order

### MVP

- TEE builder on Confidential Space, with a reproducible image, an on-chain digest and attestation checks
- Sepolia contracts (`ExamRegistry` and commitments)
- `K` split with a drand timelock, an 8-of-10 threshold and timelocked shares
- TEE share release
- Centre app
- Verifier page

### Stretch

- Distributed key generation (DKG) with a threshold public key, so the TEE never holds `K_priv`
- A second clock independent of drand, such as a key the TEE releases only after a finalised Sepolia block
- A light client or ZK proof, so the TEE can verify chain data directly
- World ID for setters
- Native setter app signed with a developer key

## License

[MIT](LICENSE)
