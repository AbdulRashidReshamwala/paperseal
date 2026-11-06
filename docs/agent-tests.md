# Agent Tests

Runs of real agents against [agent verification](../spec/agent-verification.md), as its proposal asks. Exam `0x83b3…c4c3` on registry `0xc25F…58eb` (Sepolia), finished and opened, checked on 2026-11-06 through the hosted verifier `https://34-93-7-127.sslip.io`.

Both agents were fresh Claude Code agents (Opus 5.5) with a shell and network access. Neither could read the repository's local checkout.

## Results

| Start | Method | published | people | attested | locked | sealed | unlock | open | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Copied prompt | `checker` | pass | pass | pass | pass | pass | pass | pass | partial |
| Bare URL `?exam=` | `manual` | pass | pass | pass | pass | pass | pass | not-checked | partial |

Both answers are what the spec requires. `overall` is `partial` because no exam has an on-chain mode yet (`mode: unknown`), and a `manual` report is never `verified`.

## Copied Prompt

The release with the checker wasn't published yet, so the agent was given a pre-release `paperseal-verify.mjs` and its `checkerSha256` in a note. Apart from that, it followed the prompt as written:

1. It checked the file's SHA-256 before running it.
2. It read `agent.md` as data.
3. It ran the checker with two RPCs it picked.
4. It replied with each claim, the commands and their output, and the report.

It took the `--bucket` value from the storage URL's first path segment, before running anything. The token's `env_override` then matched it. It asked the person to confirm the repository and the registry.

## Bare URL

The agent got only the page link and a note that no release has the checker yet. It used the page's readable `index.html` text, `agent.md` and `config.json` to find the sources. It refused to run code from the page or to build the checker. It then checked six claims by hand:

- **Code pin and chain:** registry code against `spec/registry.json`, and `getExam`, the approved list and the Build on two RPCs.
- **Google tokens:** their certificate chains and signatures, with openssl against Google's root.
- **Hashes:** the manifest and every stored file.
- **Signatures:** the Build and the release log.

It left `open` as `not-checked`, because opening the paper needs the timelock and HPKE steps. It also matched the on-chain commit and image digest to release v0.8.0, and noted that this is a demo exam (testnet, short schedule, simulated keys).

## What We Changed After

- **Repository case:** the report kept the repository in lowercase, which read like a mismatch with the prompt. It now keeps the case it was given.
- **RPCs read:** the report didn't show that a second RPC was read. The `published` claim now lists every RPC host as `readFrom`.

## Still Open

- **Bucket:** no field says where `--bucket` comes from. Both agents used the storage URL's first path segment, and the token's `env_override` matched it. Adding the bucket to the prompt and `config.json` would remove the guess.
- **Dead RPCs:** a second RPC that fails, such as one on a paid plan, makes every claim `not-checked`. A list of public Sepolia RPCs known to work would help.
- **Agent docs:** `agent.md` links to `api.md`, the schema and the fixtures by relative path, and none of them is served next to the page. They should be served too, or linked at the tagged GitHub version.
- **Status line:** `agent.md` says "implemented" while the repository's `main` still says "specified, not implemented". The two agree once this change is merged and released.
- **No release yet:** none has `paperseal-verify.mjs`. The next tag adds it through `repro.yml`. Until then the button is disabled on the hosted page, because the page needs `VITE_RELEASE_TAG`.
- **Other agents:** only Claude Code agents were tried. A web chat with code execution and a fetch-only assistant still need runs.
