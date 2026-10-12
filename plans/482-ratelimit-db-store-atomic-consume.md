# Plan 482: Reproduce the database rate-limit lost update on workerd, then make consume atomic

> **Executor instructions**: Follow this plan step by step. Step 1 is the
> reproduction and it must be RED before anything else changes. Do not start with
> the fix. If anything in "STOP conditions" occurs, stop and report. When done,
> update the row for plan 482 in `plans/README.md` unless a reviewer maintains the
> index.
>
> **Drift check (run first)**: `git diff --stat dcffa4d73..HEAD -- packages/ratelimit/src packages/ratelimit/__tests__ packages/ratelimit/vitest.config.ts`
> If any in-scope file changed, compare the "Current state" excerpts with the live
> code. On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `dcffa4d73`, 2026-10-11

## Why this matters

`createDbStore` (the Lunora `ctx.db` store in `@lunora/ratelimit`) implements a
limit as a read, a pure computation, and a write. The read and the write are
separate awaited storage calls, and nothing holds the pair together. If two
consumes for the same `(name, key)` interleave between the read and the write,
both compute from the same prior state and one consume is lost. A limit of 1
admits 2. The store's doc comments and the package docs say the pair is atomic
inside a Durable Object because of the input gate. That claim is probably false:
the input gate holds while a storage operation is in flight, not across a plain
JavaScript `await` between two storage operations. Login and payment-adjacent
limiters built on this store are the users who would be hit.

This plan first proves the race on the real DO-backed path, then fixes it. It
also corrects the documentation claim so the docs match the behaviour the code has.

## Current state

- `packages/ratelimit/src/rate-limiter.ts:201-211` — the consume path is a read,
  then a pure step, then a write, with awaits between them:

    ```ts
    const storageKey = storageKeyFor(name, normalizedKey);
    const prior = await this.store.get(storageKey);
    const { status, value } = evaluate(config, prior, { ... });
    if (value !== undefined) {
        await this.store.set(storageKey, value);
    }
    ```

- `packages/ratelimit/src/store.ts:191-199` — `createDatabaseStore` has no lock and no
  conditional write. `get` (`:241-255`) calls `find`, which awaits
  `db.query(table).withIndex(index, ...).first()`. `set` (`:256-269`) awaits
  `db.patch` or `db.insert`.

- `packages/ratelimit/src/store.ts:197-203` — the per-instance `idCache` is shared
  by every concurrent call through one store. A first-time race is worse than a
  stale value: `find` caches `undefined` for a missing row, and whichever `set`
  runs second can `patch` the row the first one inserted, overwriting the first
  consume's accounting with its own computed-from-empty value.

- `packages/ratelimit/src/store.ts:181-182` — the doc claims atomicity:

    > Each operation is a read-then-write; inside a mutation/action that pair runs
    > under the DO's input gate, so it is atomic against concurrent calls.

- `packages/ratelimit/src/store.ts:50-58` — the SQL store makes the same claim with
  "the DO's input gate serializes every RPC call against the storage". The SQL
  store's `exec` is synchronous, so its `await`s are microtasks only and are
  probably not an interleave point. It is a useful control, not the suspect.

- `packages/ratelimit/docs/index.mdx:254-256` — the docs Callout repeats it: "both
  SQL- and ORM-backed stores are atomic against concurrent calls without an explicit
  transaction".

- `packages/ratelimit/vitest.config.ts` — a single node project. There is **no
  workerd project in this package**, and `packages/ratelimit/package.json` has no
  `test:workerd` script. The workerd gate is the root script
  `scripts/test-workerd.sh`, which discovers packages by `name: "workerd"` in
  `packages/*/vitest.config.ts`. So this package is not run on workerd by anything
  today. Compare `packages/sql-store/vitest.config.ts` (the `cloudflareTest` project
  and `__tests__/workerd/**`).

- `packages/ratelimit/__tests__/db-store.test.ts` — the existing tests use a
  `createFakeDatabase()` with real row handling but no barrier, so they cannot see an
  interleave. They pass by construction.

- `packages/ratelimit/__tests__/store.test.ts` and `_helpers/node-sqlite.ts` — the
  SQL store under node only.

## Commands

| Purpose                                          | Command                                             | Expected on success |
| ------------------------------------------------ | --------------------------------------------------- | ------------------- |
| Single package, node                             | `pnpm --filter "@lunora/ratelimit" run test`        | all pass            |
| Workerd suite (root script, takes package names) | `pnpm run test:workerd ratelimit`                   | exit 0              |
| Typecheck                                        | `pnpm --filter "@lunora/ratelimit" run lint:types`  | exit 0              |
| Lint                                             | `pnpm --filter "@lunora/ratelimit" run lint:eslint` | exit 0              |
| Package.json order                               | `pnpm run lint:package-json`                        | exit 0              |

There is no `test:workerd` script in `packages/ratelimit/package.json`; the root
script is the entry point. Run `pnpm run test:workerd` with no arguments only if you
want the whole set. Build deps first (`pnpm --filter "@lunora/ratelimit..." run build`),
and pass `--no-cache` to the vis gates before pushing.

## Scope

**In scope** (the only files to touch):

- `packages/ratelimit/__tests__/workerd/**` (new: the DO test worker, wrangler config, and the repro suite)
- `packages/ratelimit/vitest.config.ts` (add the `workerd` project, gated like `sql-store`)
- `packages/ratelimit/src/store.ts` (the fix and the corrected doc comments)
- `packages/ratelimit/src/rate-limiter.ts` (only if the fix needs `run()` to call a store-level boundary)
- `packages/ratelimit/src/types.ts` (only the `RateLimitStore` shape if the boundary is added)
- `packages/ratelimit/__tests__/db-store.test.ts` (node regression, with a barrier)
- `packages/ratelimit/docs/index.mdx` (the Callout at `:254-256`)
- `.github/workflows/test.yml` (add the workerd matrix entry the drift guard requires)
- `api-snapshots/` for `@lunora/ratelimit` only, if `RateLimitStore` is public and changes

**Out of scope** (do NOT touch):

- `packages/server/**` — the ORM's `ctx.db` has no conditional patch. If the fix needs one, STOP (see below). Do not add it here.
- `packages/ratelimit/src/algorithms.ts` — the token-bucket and window math is not the defect.
- `packages/ratelimit/src/middleware.ts`, `plugin.ts`, `token-budget.ts`.
- `packages/advisor` lints.

## Git workflow

- Branch: `advisor/482-ratelimit-atomic-consume`, from `alpha`.
- One commit, subject `fix(ratelimit): make database store consume a single atomic step`
  (or the closest honest wording after Step 3). Body: state that the race was reproduced
  on workerd (quote the red output from Step 1), the chosen boundary, and the ORM
  limitation if it remains.
- Do NOT push and do NOT open a PR unless the operator asks.

## Steps

### Step 1: Reproduce on workerd before any fix

Build the DO-backed path so the race runs through real storage awaits:

1. Add a `workerd` project to `packages/ratelimit/vitest.config.ts`, copying the shape
   of `packages/sql-store/vitest.config.ts` (`cloudflareTest`, `__tests__/workerd/**`,
   and the `LUNORA_WORKERD_TESTS=1` gate). Keep the node project's `exclude` for
   `__tests__/workerd/**`.
2. Create `__tests__/workerd/test-worker.ts` with a minimal Durable Object. Its
   `ctx.db` stand-in is `createDbStore({ db })`, where `db` is an adapter over the
   DO's KV storage: `query().withIndex().first()` calls `ctx.storage.get(...)`,
   `patch` and `insert` call `ctx.storage.put(...)`. These must be real awaited
   storage operations. An adapter that resolves from memory would not exercise the
   input gate, and the repro would prove nothing.
3. Add a rendezvous inside the store wrapper: after each `get` resolves, the
   handler waits until a second consume has also reached `get`, with a timeout of
   about 2 s. This is a JavaScript promise, not a storage operation, so it does not
   hold the input gate, and a second request can run in the gap.
4. Write `__tests__/workerd/consume-race.workerd.test.ts`. Send two concurrent
   `limit("login", { key: "u1" })` calls with a limit of 1 per window. Assert
   exactly one `ok: true` and the stored value reflects two consumes.
5. Add a control: the same test through `createSqlStore` in the same DO. Expect it
   to pass, because the sync `exec` gives no macrotask interleave point. If it also
   fails, the premise is wrong and you must STOP.
6. Run it: `LUNORA_WORKERD_TESTS=1 pnpm run test:workerd ratelimit`.

The `db` consume test must be a plain `it`. Do NOT use `it.skip`, `it.todo`, or
`it.fails` in the final state. Its red result is the evidence.

**Verify**: the ORM-backed race test is RED with two admitted calls where one was
expected (or a rendezvous timeout, see STOP). Paste the failure into the commit body.
The SQL control is GREEN. If the ORM test is green, STOP: the race is not reproducible
on workerd and the answer is `NOT REPRODUCED` with the evidence.

### Step 2: Choose the boundary (decision, no code yet)

Two candidates:

- **A. Single conditional write** (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
  or `UPDATE ... WHERE value = ?` as compare-and-set). This needs the token-bucket
  and window arithmetic expressed in SQL, which is a second implementation of
  `algorithms.ts`. It also cannot apply to the ORM store at all: `ctx.db.patch` is
  unconditional and takes an id, with no WHERE and no RETURNING.
- **B. Transaction around the read-compute-write.** For the SQL store, wrap the
  whole `get → evaluate → set` in `ctx.storage.transactionSync`. This is possible
  only because `exec` is synchronous. For the ORM store there is no transaction
  that spans an await, so B does not fix the ORM path by itself.

**Recommendation: B, expressed as a store-level `update(storageKey, fn)` boundary.**
`RateLimiter.run()` hands the store a synchronous `(prior) => next` function and the
store runs it atomically. The SQL store does it in `transactionSync`. Reasons: it
keeps the single algorithm in `algorithms.ts`; it is the only candidate that the
SQL store can implement without duplicating arithmetic; and it makes the contract
explicit in the type, so a store that cannot be atomic says so. A is rejected as the
primary fix because it forks the algorithm and does not reach the ORM path either.

For the ORM store the boundary cannot be synchronous, so it stays non-atomic. Record
that honestly in the docs and the store type (Step 4). Do not extend `@lunora/server`
here (see STOP).

**Verify**: write the decision and its rejected alternative into the plan's commit
body before editing `store.ts`.

### Step 3: Fix the SQL store path and rerun the control

In `store.ts`, add the `update` boundary to the SQL store, implemented with
`transactionSync`. `run()` in `rate-limiter.ts` calls `update` when the store
provides it, so the in-memory store is unchanged. Keep the `get`/`set` pair for
`getValue`, `check`-free reads, and `reset`.

Do not change the ORM store's behaviour in this step.

**Verify**: `pnpm --filter "@lunora/ratelimit" run test` passes; the SQL control in
the workerd suite stays green; the race test (SQL path) stays green.

### Step 4: Correct the ORM store and the docs

1. Remove the atomicity claim from `store.ts:181-182` and `:50-58`. State what holds:
   the SQL store is atomic per call inside a DO through `transactionSync`. The ORM
   store is atomic only when its callers serialize, and a concurrent pair can lose an
   update.
2. Correct `docs/index.mdx:254-256` the same way.
3. Fix the `idCache` comment at `store.ts:197-203` so it no longer implies a single
   writer.

**Verify**: `grep -n "atomic against concurrent" packages/ratelimit/src packages/ratelimit/docs`
returns no matches that describe the ORM path.

### Step 5: Decide the ORM path with a test, not a claim

With the ORM race still red after Step 3, the ORM test becomes an explicit contract:
a concurrent pair through `createDbStore` is documented to lose an update, so the
suite asserts the loss, marked as a known limitation, and a node test checks that
`createDbStore` refuses to be the sole store when `RateLimiter` is built with
concurrency-sensitive limits. That refusal is a design decision: record it as an open
question and STOP for a review rather than inventing it here.

**Verify**: the suite is green with the ORM limitation stated, and the open question
is recorded in the commit body.

### Step 6: Full gate

```bash
pnpm --filter "@lunora/ratelimit..." run build
pnpm --filter "@lunora/ratelimit" run test
LUNORA_WORKERD_TESTS=1 pnpm run test:workerd ratelimit
pnpm --filter "@lunora/ratelimit" run lint:types
pnpm --filter "@lunora/ratelimit" run lint:eslint
pnpm run lint:package-json
pnpm run api:check
```

**Verify**: all exit 0. If `api:check` drifts for `@lunora/ratelimit` only, run
`pnpm run api:update` after the fresh build and confirm the diff is that package only.

## Test plan

- Workerd: `__tests__/workerd/consume-race.workerd.test.ts` — the ORM race (red in
  Step 1, then green on the SQL path after Step 3, with the ORM limitation explicit
  after Step 5) and the SQL control.
- Node: `db-store.test.ts` gains a barrier test on the fake DB that asserts the
  same outcome. It is a fast regression, not a substitute for the workerd suite.
- Mutation check: revert the `transactionSync` wrap and confirm the SQL path
  goes red under the rendezvous. A test that stays green on the broken code is not
  a test.

## Platform parity

Not applicable to the `ctx.*` matrix: `createDbStore` and `createSqlStore` are
library helpers, not a new `ctx.*` surface or provider binding. No
`PlatformCapabilities` row changes. The `transactionSync` boundary is a Cloudflare
DO storage call; a non-Cloudflare host implementing `SqlLike` must provide a
synchronous transaction or the store must document itself as non-atomic. State that
in the store's doc comment.

## Done criteria

- [ ] Step 1's red output for the ORM race is recorded in the commit body
- [ ] `LUNORA_WORKERD_TESTS=1 pnpm run test:workerd ratelimit` exits 0
- [ ] `pnpm --filter "@lunora/ratelimit" run test` exits 0
- [ ] `pnpm --filter "@lunora/ratelimit" run lint:types` exits 0
- [ ] `pnpm run lint:package-json` exits 0
- [ ] The atomicity claims at `store.ts:50-58`, `:181-182`, and `docs/index.mdx:254-256` describe the code
- [ ] `git status` shows only in-scope paths
- [ ] `plans/README.md` row for 482 updated (unless a reviewer owns the index)

## STOP conditions

- The ORM race test is green on workerd in Step 1. Report `NOT REPRODUCED: <evidence>`
  with the rendezvous timing and the stored value, and stop.
- The rendezvous times out in Step 1. That means the second consume never reached
  `get`, so the input gate serialized the pair. That is evidence against the race on
  this path. Report it and stop; do not weaken the rendezvous to make it pass.
- The adapter in Step 1 is backed by memory and not by real `ctx.storage` awaits.
  Fix the adapter before reading the result.
- The fix needs a conditional `patch` or RETURNING on `ctx.db`. That belongs in
  `@lunora/server`. Report it; do not add it here.
- The SQL control in Step 1 fails. The premise is wrong. Report it.
- The same verification fails twice after a reasonable fix attempt.
- **Environment**: the workerd gate may not run in a sandbox. `@cloudflare/vitest-plugin`
  needs localhost loopback, and sandboxed harnesses block it. If `pnpm run test:workerd
ratelimit` cannot boot workerd, say so explicitly in the report and do not mark the
  step done. A node-only result is not evidence for the DO path.

## Open questions (answer during execution)

1. Should the ORM store refuse concurrency-sensitive limits, or only document the
   race? (Step 5.)
2. Is a conditional `patch` on `ctx.db` worth a follow-up plan in `@lunora/server`
   so the ORM path can become atomic too?
3. Should the workerd matrix entry in `.github/workflows/test.yml` be added in this
   commit, or split into its own, since the drift guard fails the job otherwise?
