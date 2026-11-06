# Friction

What got in our way building on `@arkiv-network/sdk` 1.0.1 and Rabdi at ETHGlobal Mumbai, 2026-11-06. Each item says what we expected, what happened and how to reproduce it.

1. **`createdBy()` takes one address, and calling it again replaces it.**
   - Expected: chaining it, or passing an array, to read rows from any of several trusted writers.
   - Happened: the second call silently replaced the first.
   - Reproduce: `select().from(schema).createdBy(a).createdBy(b)` returns only `b`'s rows.
   - Workaround: `where(or(eq('$creator', addr(a)), eq('$creator', addr(b))))` ([`packages/arkiv/src/reader.ts`](../packages/arkiv/src/reader.ts)). A `createdByAny([...])` would help any app with more than one writer.
2. **The paging in the docs doesn't exist in 1.0.1.**
   - Expected: the paginate page's `next`, `for await` and `atBlock`.
   - Happened: none of them are in the published SDK.
   - Workaround: key-based paging needs `onMismatch: "throw"`, which lets one malformed row stop the whole read, so we page by offset over `asc('$key')`. That offset can shift if rows are created mid-walk.
   - Ask: ship the cursor API, or remove it from the docs.
3. **A named-schema query silently drops rows that lack the `arkiv.schema` tag.** This happens even when you only select `$key`. It's right on a real node, but it surprised us in tests with a stub transport. A note on the schema page would save the next team an hour.
4. **Value syntax differs by type in raw queries.**
   - Happened: `str('…')` takes quotes, but `addr(…)` refuses them, with `addr takes a 0x-prefixed address`.
   - Reproduce: run `arkiv_query` with `$creator = addr('0x1E62…')`.
   - Ask: accept both forms, or show `addr(0x…)` in the query-language examples next to `str('…')`.
5. **The public RPC is rate limited by design, so a static verifier page needs a key that anyone can read.** CORS is open (`access-control-allow-origin: *`), which is great, but every viewer of a public verifier shares one origin-locked key or the public limit. Anonymous read quotas per origin would suit public-good readers like ours.
6. **`rabdi({ accessKey: "" })` prints a console warning on every run.** That's fine in a browser, but noisy in a CLI. An option to silence it would help.
7. **The explorer's entity URL isn't documented.** We guessed `/entity/<key>`, and it works. The page itself is excellent: it shows the flags, the lifetime and every attribute with its type.
