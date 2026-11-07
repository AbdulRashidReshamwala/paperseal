# Friction

What got in our way with `@arkiv-network/sdk` 1.0.1 and the Rabdi testnet at ETHGlobal Mumbai, 2026-11-06. Each item says what we expected, what happened, and how to reproduce it.

1. **`createdBy()` takes one address, and a second call replaces the first.**
   - Expected: to read rows from several trusted writers by chaining it or passing a list.
   - Happened: only the last address counted, with no warning.
   - Reproduce: `select().from(schema).createdBy(a).createdBy(b)` returns only `b`'s rows.
   - Workaround: `where(or(eq('$creator', addr(a)), eq('$creator', addr(b))))` ([`reader.ts`](../packages/arkiv/src/reader.ts)).
   - Ask: a `createdByAny([...])`.
2. **The paging in the docs isn't in 1.0.1.**
   - Expected: `next`, `for await` and `atBlock` from the paginate page.
   - Happened: none of them exist in the published SDK.
   - Workaround: we page by offset, which can shift if rows are added during a read.
   - Ask: ship the cursor API, or take it out of the docs.
3. **A query by schema silently drops rows without the `arkiv.schema` tag.**
   - It happens even when you only select `$key`. It's correct on a real node, but it surprised us in tests with a fake transport.
   - Ask: a note on the schema page.
4. **Value syntax differs by type in raw queries.**
   - Happened: `str('…')` needs quotes, but `addr(…)` refuses them with `addr takes a 0x-prefixed address`.
   - Reproduce: run `arkiv_query` with `$creator = addr('0x1E62…')`.
   - Ask: accept both, or show `addr(0x…)` next to `str('…')` in the docs.
5. **A public verifier page has no private way to use an access key.**
   - CORS is open, which is great. But every viewer of a public page shares one key that anyone can read, or the public rate limit.
   - Ask: an anonymous read quota per site, for public-good readers like ours.
6. **`rabdi({ accessKey: "" })` prints a warning on every run.** Fine in a browser, noisy in a CLI. An option to turn it off would help.
7. **The explorer's entity link isn't documented.** We guessed `/entity/<key>`, and it works. The page itself is excellent: it shows flags, lifetime and every field with its type.
