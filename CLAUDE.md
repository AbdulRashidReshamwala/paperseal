# Paper Seal

`README.md` is the source of truth for behaviour. `docs/ARCHITECTURE.md` maps it onto this repo. `spec/` holds everything shared across languages.

## Rules

- Change `spec/` first for anything that crosses a language boundary, then update Go, Solidity and TypeScript in the same change.
- Never write custom cryptography. Use the audited libraries already chosen per stack.
- Unfinished code returns a not-implemented error. Never fake a check, signature or decryption so a flow appears to work.
- Implementation work is split across subagents, one per directory. Keep an agent's edits inside its own directory.

## Commands

- `make build` and `make test` run everything.
- `make abi` regenerates the `ExamRegistry` ABI for `packages/chain`.
- `pnpm --filter @paperseal/<name> dev|build|test` targets one web package.
