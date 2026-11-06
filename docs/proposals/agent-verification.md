# Proposal: Verify with Any AI Agent

**Status:** specified in [`spec/agent-verification.md`](../../spec/agent-verification.md), 2026-11-06, which replaces this proposal's formats where they differ. Nothing is implemented.

## Summary

Add one button to the verifier page that copies a prompt. Pasted into any AI agent, it has the agent check every claim about an exam from the original sources. Pasting the page's URL should work too.

The agent must never take the page's word for anything, because the board serves that page. It gets the evidence itself and runs the same checks as the verifier. If it can't check something, it says so.

## Problem

- **Trust takes expertise:** the verifier is thorough, but most people can't judge what its checks mean or whether the page itself is honest. A second, independent reader helps.
- **A pasted URL shows nothing today:** `index.html` is an empty `<div id="root">`, and an agent that only fetches the URL won't run the app.
- **The usual link loses the exam:** in `#/exam/0x...`, the part after `#` never reaches a server, and many fetch tools drop it. `?exam=0x...` already works and survives.
- **The checks only run in the browser:** the logic lives in `apps/verifier`, mixed in with what the page displays (`custody.ts` alone is 1,074 lines), so nothing else can run it.

## Threat Model

This feature only helps if a dishonest board can't fool it.

| Threat | Defence |
| --- | --- |
| A tampered page says everything passed | The prompt carries no results. The agent gets evidence from the chain, Google and drand |
| A tampered page points to a fake contract | The report states the registry address it assumed, and the person compares it with the board's announcement or its [ENS name](ens.md) |
| A tampered page offers a fake checker | The checker comes from the public repo's release, never from the page. The repo link is always shown, and the agent asks the person to confirm it |
| Evidence carries instructions aimed at the agent | Owner names, criteria text and opened papers are written by other people. The agent treats all of it as data, and the checker labels such fields as untrusted |
| The agent invents a result | The report includes what was run and the raw output, so anyone can repeat it. An agent with no way to compute a hash must report `not checked` |

An agent's answer is a second opinion, not proof. The proof is the evidence, which anyone can recheck.

## Proposed Work

### 1. `packages/verify`

Move the checking logic out of `apps/verifier` into a shared package, with no browser or display code. The page and the checker then both call it, so they can't disagree. This is the largest part of the work and the part everything else depends on.

### 2. Checker

Each release publishes a single-file Node script, `paperseal-verify.mjs`, with its SHA-256, built reproducibly like the TEE image.

```bash
node paperseal-verify.mjs --exam 0x... --registry 0x... --rpc https://rpc.example.org --storage https://storage.example.org --json
```

It reads the chain, bucket, Google's root and drand itself, and returns a report. Comparing two RPC operators is an option, so one dishonest operator can be caught.

### 3. Report Format

`spec/agent-report.schema.json` defines one report. Each claim uses the same ID as a verifier step, so a person can compare the two side by side.

| Claim | What it proves | Available from |
| --- | --- | --- |
| `published` | The settings are on-chain and write-once | Exam created |
| `attested` | Google's token matches the on-chain image digest and settings | TEE running |
| `people` | The approved list matches its on-chain hash | List posted |
| `locked` | The bank locked and the selection matches the criteria | Build posted |
| `sealed` | The Build is signed and the published files match its hashes | Build posted |
| `unlock` | The release log is signed, and the threshold was met | `T−Δ` |
| `open` | The paper opens and matches the salted hash and criteria | End round |

Each claim has one of four statuses: `pass`, `fail`, `not yet` or `not checked`.

The overall result is `verified` only if every claim due so far passes, `failed` if any claim fails, and `partial` otherwise. An exam in `dev` [mode](self-hosting.md#6-exam-mode) is never `verified`.

### 4. Copy Button

One button at the top of the verifier page: **Check with your own AI**. One click copies the prompt and confirms with "Copied. Paste it into any AI agent." There's no dialog, and a small link can show the text first.

The prompt is built in the browser, and nothing is sent anywhere:

```text
Check this Paper Seal exam yourself. Don't rely on what any page says passed.

Exam ID: 0x...
ExamRegistry: 0x... on Sepolia (chain 11155111)
Storage: https://storage.googleapis.com/<bucket>
Verifier page: https://verify.board.example/?exam=0x...
Repository: https://github.com/<owner>/paperseal
...
```

The exact text is in [the spec](../../spec/agent-verification.md#prompt). The repository is shown as its full address beside the button, in the prompt and in the report, so the person can always see which one was used.

It leaves out the page's results, so they can't sway the agent. It also leaves out the viewer's own RPC URL, because a URL set under Connection can contain a private API key.

### 5. Pasting the URL

- **Share links use `?exam=0x...`:** the page rewrites the address to this form, and the hash forms keep working.
- **The page has readable text before JavaScript runs:** `index.html` holds a short visible explanation inside `#root` that React replaces. It explains what the page is and links to the files below.
- **`agent.md`** sits next to the page, with the claims, the sources and how to read the report. **`llms.txt`** points to it.
- **`config.json`** from the [self-hosting proposal](self-hosting.md#4-runtime-web-config) supplies the registry, chain and storage values.

**Nothing is hidden.** Text meant only for agents would look exactly like a prompt injection, and a careful agent would be right to ignore it. This text is ordinary documentation that people can read too. A pasted URL is a weaker start than the copied prompt, because the agent decides for itself how far to trust the page, so the page stays the fallback and the button stays the main path.

### 6. What Each Agent Can Do

| Agent can | Result |
| --- | --- |
| Run code and reach the network | All claims checked with the checker |
| Fetch pages only | Partial at best. It can read public pages but usually can't send RPC calls or verify signatures, so most claims are `not checked` |
| Neither | It says it can't verify, and points to the verifier page |

## Order

1. Share links, readable page text and `agent.md`.
2. `packages/verify`, with no change to what the page shows.
3. Report schema and checker.
4. Copy button.
5. Agent tests.

## Non-Goals

- **An AI built into the page:** the point is the person's own agent, independent of the board.
- **An agent's verdict as proof:** nothing is recorded on-chain or shown as verified because an agent said so.
- **Anything private:** the prompt holds only public values.
- **Replacing the verifier:** the page stays the main way to check an exam.

## Spec Changes

- Add `spec/agent-report.schema.json`, with claim IDs and statuses.
- Add the claim list to `spec/api.md`, so it has one definition.

## Testing

We can't promise "any agent", so this needs testing against real ones:

- **Same results:** the checker and the page must agree on every case in `apps/verifier/src/fixtures.ts`.
- **Tampering:** a page claiming success on a failing exam, a wrong image digest, a bad signature, and a changed file must all come back as `fail`.
- **Prompt injection:** an owner name and a question containing instructions must not change the agent's report.
- **Agents:** run the copied prompt and the bare URL in at least one coding agent, one web chat with code execution and one fetch-only assistant, and publish the results.

## Open Questions

- **Does `packages/attestation` run in Node?** It's built on `jose` and `@peculiar/x509`, which should, but this needs confirming.
- **Where does the expected bucket come from?** The verifier has it only as the build-time `VITE_TEE_STORAGE_BUCKET`. The checker can take it as an argument, but a wrong value fails the claim.
- **How much should the agent do about the build?** Rebuilding the image is too slow for most agents. The `attested` claim could compare the digest with the release, and leave a full rebuild to `repro.yml`.
- **Which RPC does the agent use?** Public endpoints change and can limit requests, so the checker needs a default it can fall back on.
