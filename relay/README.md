# @paperseal/relay

The Arkiv writer of [spec/arkiv.md](../spec/arkiv.md) "Writers", which the code calls the relay. It reads one exam's public unlock evidence from storage and/or the TEE and mirrors it to Arkiv's Rabdi testnet through [`@paperseal/arkiv`](../packages/arkiv). Arkiv is only a mirror: the relay copies signed evidence and checks no signature, and readers check every row's `body` and only trust rows whose `$creator` is a published writer. A relay can stay silent, but it can't make a check pass.

## Commands

Run from the repo root. `cli.mjs` loads the TypeScript through Vite, like `e2e/live/cli.mjs`, so there is no build step.

```sh
# One pass: the release token first, then the release log.
node relay/cli.mjs mirror --exam <examId> --registry <ExamRegistry> [--storage <url>] [--tee <url>]

# The same pass every N seconds (default 10), writing only new snapshots, until the TEE says
# released or failed, or Ctrl+C. TEE and storage errors are printed and the loop goes on.
node relay/cli.mjs watch --exam <examId> --registry <ExamRegistry> [--storage <url>] [--tee <url>] [--every 10]

# Read-only: this exam's rows from one writer, newest first. Default writer: the relay's keystore address.
node relay/cli.mjs status --exam <examId> [--writer <address>]

# Offline self-test: argument parsing, storage URLs, payload preparation, cast arguments.
node relay/cli.mjs dry-check
```

`mirror` and `watch` need at least one of `--storage` and `--tee`. For example, against the demo deployment:

```sh
node relay/cli.mjs mirror \
  --exam 0x422205bde8135878ece4ccb921496e30076b32e14f48fb2886e3fa3f5181f295 \
  --registry 0x6a9f017F374630EcB84e8E3816B1eE9F8Fa2dBE8 \
  --storage https://storage.googleapis.com/paperseal-demo-paperseal-exams
```

Each pass prints one line per piece of evidence: `written` (new row, with its entity key, transaction hash and explorer links from `arkiv.network.explorer`), `skipped` (this writer already has it), `held` (not written yet; a later pass may write it), `refused` (not this exam's evidence) or `failed` (the write failed). `mirror` exits 1 if anything was refused or failed.

`pnpm --filter @paperseal/relay test|typecheck|lint` run the unit tests (no network), `tsc` and ESLint.

## What a pass does

1. **Storage** (`--storage`): reads `<url>/<examId>/release-log.json` and `<url>/<examId>/release-token.jwt`, the way `apps/verifier` builds object URLs. A 404 means the file isn't there yet.
2. **TEE** (`--tee`): reads `GET /v1/status`, the exact bytes of `GET /v1/release/log`, and, once the TEE has a log for this exam, `GET /v1/attestation`.
3. Every log must have `examId` equal to `--exam`, or it is refused, along with the storage token beside it. A TEE whose status shows another exam's approved list is ignored entirely.
4. **Tokens first.** The storage token's instance key is the storage log's `instancePublicKey`, as spec/api.md "Storage" says. The TEE's token is mirrored only when the attestation's `instancePublicKey` is the key that signed the TEE's log, so it is the Unlock instance's token. Otherwise it is held.
5. **Then logs.** A log is written only once a token for its signer is on Arkiv from this writer, because readers ignore a log whose signer no token attests. A newer TEE log and an older storage log are both written: readers show the verified log with the most entries.

`@paperseal/arkiv` skips a row this writer already has (the same `examId`, `registry` and `entriesHash`, or the same `instanceKeyHash`). `watch` also remembers what it confirmed, so it doesn't query Arkiv for the same rows every few seconds. `watch` stops only when a TEE that shows this exam says `released` or `failed`, after a pass with no failed writes (or three more tries).

Rows are created `readonly`, extendable by anyone, and live `lifetimeDays` (180) from `spec/arkiv.json`. `chainId` is `chain.chainId` from `spec/constants.json`.

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `RELAY_KEYSTORE` | `paperseal-board` | Foundry keystore name under `~/.foundry/keystores` |
| `RELAY_PASSWORD_FILE` | `~/.paperseal/board-keystore-password` | Password file path, passed to cast and never read by the relay |
| `ARKIV_ACCESS_KEY` | unset | Arkiv Hub access key. Without it, `ARKIV_ACCESS_KEY=` in `~/.paperseal/arkiv-relay.env` is used if present, else the public RPC, which is rate limited |

cast is found on `PATH`, else at `~/.foundry/bin/cast`. `status` and `dry-check` need no key. `status` without `--writer` runs `cast wallet address`, which prints only the address.

## Safety

- **Only already-public, signed evidence is mirrored**: the release log (`GET /v1/release/log` or `release-log.json`) and the Unlock instance's PKI attestation token (`release-token.jwt` or `GET /v1/attestation`). The relay reads nothing else, so it can't mirror anything else. Questions (even encrypted), setter receipts, keys or submission times, invite secrets, shares and anything not already public never go on Arkiv, because Arkiv is public and permanent.
- **The signing key stays in memory.** `mirror` and `watch` run `cast wallet private-key --account <name> --password-file <path>` with stdin closed, and pass its output straight to viem's `privateKeyToAccount`. The key is never printed, logged or written to disk. cast's stdout is never shown, even on failure, and anything key-shaped is cut from its stderr. The relay never opens the password file.
- **The access key is not printed.** It rides in the RPC URL's path, so every line the relay prints, errors included, is redacted for it.
- The relay sends Arkiv transactions only from `mirror` and `watch`. Use a dedicated writer address, fund it with Rabdi testnet tGLM, and publish it next to the board's other settings so readers trust its rows.
- Two relays, or two runs of one, at once may both write a row. Readers ignore the duplicate.
