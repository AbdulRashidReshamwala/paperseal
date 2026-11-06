# Presentation points

The story in one line: **students were cheated by the system meant to protect them. Paper Seal is a system nobody has to trust, because anyone can verify it.**

Theme to use where it fits: **no one can leak a paper they have never seen.**

## Part 1. The problem

### 1.1 Students sit the exam twice
- NEET-UG 2026: exam on 3 May, about 22.7 lakh candidates. Cancelled on 12 May. Re-exam on 21 June.
- 22 lakh students had to give an exam they had already given.
- Evidence: a "guess paper" circulated before the exam matched over 100 of 180 real questions.

### 1.2 What it does to students
- They lose hope in the system.
- They feel depressed and cheated by the system that was meant to protect them.
- It was done for the gain of a few. Families paid bribes to get the paper, and insiders and coaching owners were arrested.
- Tone: sympathetic. No invented student quotes. Handle the reported suicides carefully, with a source, or leave them out.

### 1.3 Not a one-off
- The leak comes from **inside** (insiders, NTA staff, teachers, coaching owners) and sometimes from **outside** (hackers).
- It repeats: the CBI reportedly found the 2025 paper compromised by the same racket.
- Numbers on hand: 41 exams across 15 Indian states in five years (about 1.4 crore applicants). Iraq had 66 internet shutdowns in 2023, mostly for exams. Algeria lost about $199M in 2019.
- **Gap:** I have no sourced example of an external hacker leak. We need one before we say it on stage.

### 1.4 What we need
- A system that protects against **both** insiders and outsiders.
- And one that anyone can **verify**.
- Vitalik slide goes here:
  - "The classic problem with any kind of security is basically: who do you trust?"
  - "The solution here is… openness and verifiability."
  - "A path that does not depend on handing over the keys to everyone's castle to one small group of people."

## Part 2. The Paper Seal pitch
- A paper-setting system that is **verifiable**.
- Built on the trust of **multiple parties**, with **no single key**.
- **Auditable**: open source, with public evidence for every step.
- Where the theme lands: nobody sees the final paper, so nobody can leak it.

## Part 3. How we do it
Each step gets **one diagram slide, then one video slide** (demo video, placeholder for now). If you meant one diagram for all the steps together, say so.

| # | Step | Points for the slide |
| --- | --- | --- |
| 1 | **Paper setters** | Many setters, not one. Each sends questions encrypted straight to the sealed machine (the TEE). Nobody knows which questions will make the paper. A cap limits each setter's share of a topic. |
| 2 | **Making the paper** | The TEE locks the question bank. A private seed picks `x` questions from each topic's bank at random, so no setter can steer or predict the choice. It builds one identical paper for every centre, pads it and encrypts it with key `K`. No human sees it. |
| 3 | **Splitting the key** | `K = K_pub ⊕ K_priv`. `K_pub` goes into a drand time lock, so the public time network releases it at `T−Δ`. `K_priv` is cut into Shamir shares. Neither half opens the paper alone. |
| 4 | **Distributing the keys** | 7 exam centres and 3 neutral parties each get one share, encrypted to a key inside their own hardware security key. Any 8 of 10 rebuild `K_priv`, and centres alone can't reach 8, so a neutral party must take part. Up to 2 can be offline. The encrypted paper goes to public storage days ahead, and its hashes go on-chain. |
| 5 | **Exam time** | At `T−Δ` drand releases `K_pub`. Key holders touch their security keys and send shares to the TEE. With 8 shares it rebuilds `K_priv` and sends it only to approved centres. A centre combines both halves, decrypts the paper and checks it against the on-chain hash. |
| 6 | **After the exam** | At the end round drand opens the paper to everyone. Anyone can check it matches what was committed and that selection followed the published rules. |

Honest limit to keep: a centre can still leak the paper after it decrypts it, so `Δ` is kept as short as possible.

## Part 4. Verification: attacks and defences
One slide with the table, then a demo video of the verifier page.

| Attack | Defence |
| --- | --- |
| The setter-side or TEE code is malicious | The code is open source, so it can be audited. A reproducible build means anyone can rebuild the same image and compare its digest. |
| The wrong version of the code is running | The TEE's attestation proves which image runs. Its digest and exam settings sit on-chain before onboarding, and the apps refuse to talk to a TEE that doesn't match. |
| An insider tries to read the paper early | Nobody holds the whole key. `K_pub` stays time-locked, and `K_priv` needs 8 of 10 holders. |
| Key holders collude | Centres alone can't reach 8, so a neutral party must join. Even all of `K_priv` is useless without `K_pub`. |
| A setter tries to rig the selection | The selection seed is created inside the TEE after the bank locks. Per-setter caps apply, and setter names are never published. |
| The board swaps the approved list | The list is posted once on-chain. The TEE reads it back over TLS, and the contract rejects a Build with a different hash. |
| An outside hacker steals the encrypted paper | Useless without both key halves. It can't be opened before the time seal releases. |
| A fake centre asks for the key | Only centres on the approved list, registered with a hardware key, receive `K_priv`. |

Be upfront about what is not covered: a centre leaking after decrypt, drand being compromised, and a tampered web app (see "Trust Assumptions" in the README).

## Slide order (proposed, to confirm)
1. Students: re-giving exams they already gave
2. What it does to them
3. Not a one-off: inside and outside
4. We need a system we can verify (Vitalik)
5. Paper Seal in one line
6. Steps 1 to 5: a diagram slide, then a video slide, for each step
7. Verification: attacks and defences
8. Close

## Open questions
- Is each step's diagram + video slide meant per step (about 10 slides) or once overall?
- Where does the external-hacker example come from?
- Talk length, so we can size the deck.
- Which demo videos exist yet, so we know what the placeholders stand for.
