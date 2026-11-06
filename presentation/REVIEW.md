# Deck review findings

Two read-only reviews of the 22-slide deck: one for audience and flow, one for accuracy against the README. Slide numbers follow file order.

## Must fix (accuracy)
1. **Slide 21, "The clock":** says a failure is "delayed, not exposed". README: an outage delays, but a compromised drand plus 8 holders could open the paper early. Say both.
2. **Slide 12, K_pub:** "opens at exam time". README: it opens at T−Δ, shortly before the exam.
3. **Slides 18, 19, "BLOCKED" stamps:** too strong. Audit doesn't block bugs, the board's web app can swap keys, holders can pool shares unlogged, setters know their own questions. Use "MITIGATED" or "HARDER".
4. **Slide 19, "key holders collude":** what stops early opening is the K_pub time lock, not neutrality. Say "holders could pool shares, but K_priv alone opens nothing before T−Δ."
5. **Slide 6 headline:** "No one can leak a paper they've never seen" is absolute. Centre staff see it after unlock. Safer: "No single person ever holds the paper or the key before the exam."
6. **Slide 16, "every release is logged in public":** only share releases are logged. Leaks after decryption are untraceable.

## Should fix (clarity)
- **Jargon:** "sealed machine" (never explained), K / K_pub / K_priv (say "clock half / people half"), "time lock", "8 of 10" (show 10 people, 8 lit), "neutral parties" (who?), "approved centres" (who approves?), "on-chain", "attestation", "reproducible build".
- **Slide 14:** "ten people" is ten parties. Add that any 3 absent holders block the unlock.
- **Slide 8:** setters know their own questions. Say "no human sees the whole bank." Add the per-setter cap.
- **Slide 18:** "setter's code" should be "the paper-building code" (tampered setter apps are out of scope). The on-chain item is the image digest.
- **Slide 20:** the paper itself can only be checked after the exam.
- **Slide 15 caption:** hardware keys are registered earlier, not at the split.
- **Slide 7:** "Share" should read Distribute and Unlock.

## Missing
- Onboarding and the approved list posted on-chain.
- Hardware security keys.
- The setter app checking the machine's attestation before sending questions.
- The signed receipt ("sealed ✓") and the signed Build on-chain.
- What happens at the end round: anyone can open the paper and check its hash.
- A fourth honest-limits card: "the board and Google" (web app, attestation), plus that the hackathon build is a simulated-key prototype.
- What exists today, and what is built versus planned.

## Flow
- **Too long:** 22 slides and 5 videos for 5 to 7 minutes. Aim for about 15: merge slides 2 and 3, fold 19 into 18, show fewer videos or short clips, trim the overview.
- **Problem to solution:** the Vitalik quote is long and lands right after the emotional slides. Keep one line large, "openness and verifiability", add a bridge on slide 4 ("every fix so far asks you to trust someone"), and have slide 6 answer "who do you trust?" with "nobody has to".
- **Slide 6 chips:** four abstract nouns with no payoff.
- **Energy drops:** slides 12 to 15 (key split and keys) are the densest stretch, then two table-like slides in a row (18, 19).
- **Quotes on slide 3:** an anonymous post and a reader comment are weaker than the named PTI quotes.

## Judge questions the deck doesn't answer
Who runs the TEE and what if the chip vendor is compromised; who are the neutral parties and who picks them; what if 3 holders don't show up; what does a drand delay mean on exam day; can the board stuff the approved list; what is Δ; scale (22 lakh students, thousands of centres, not 7); is anything live; why a blockchain.

## Keep
Slides 1 to 3 (concrete, sourced), the inside/outside split, the dark-to-light change, "Don't trust it. Check it.", the honest-limits slide, "centres alone can't reach 8", the "Step N of 5" labels.
