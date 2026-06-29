# Plan 074: Extract a shared bounded socket-pool helper (dedup the poke/refresh worker pools)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/do/src/shard-do.ts`
> If it changed, compare the "Current state" excerpts against the live code; on a
> mismatch, treat it as a STOP condition (this plan assumes plans 072 and 073 have
> already reshaped these methods — see Depends on).

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans 072 and 073 (both land changes in
  `pokeShapeSubscribers` / `refreshSubscriptions`; do this extraction last so it
  consolidates the _final_ shape of the boilerplate rather than churning twice)
- **Category**: tech-debt
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

The DO runs two near-identical bounded worker-pool loops to fan a flush out over
the shard's WebSockets — one in `refreshSubscriptions` (query subscriptions) and
one in `pokeShapeSubscribers` (shape pokes). Both hand-roll the same
`concurrency = 8` + shared-cursor + `Promise.all(Array.from(...))` structure. The
duplication is a maintenance hazard: a fix to the fan-out policy (e.g. tuning
concurrency, adding backpressure) must be made in two places and they have
already drifted slightly (one worker is `async`, one is sync-wrapped). Extracting
a single `runSocketPool(sockets, processOne, concurrency)` helper removes the
drift and gives one place to evolve the policy.

## Current state

- `packages/do/src/shard-do.ts` — `refreshSubscriptions`, the **async** pool
  (around lines 5769–5788):

    ```ts
    // Bounded fan-out: at most 8 sockets refresh in parallel. ...
    const concurrency = 8;
    let cursor = 0;
    const worker = async (): Promise<void> => {
        let socket = sockets[cursor];
        cursor += 1;
        while (socket !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- each worker drains the shared cursor sequentially; parallelism comes from running `concurrency` workers
            await refreshOne(socket);
            socket = sockets[cursor];
            cursor += 1;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sockets.length) }, () => worker()));
    ```

- `packages/do/src/shard-do.ts` — `pokeShapeSubscribers`, the **sync-bodied**
  pool wrapped to a promise (around lines 6075–6098):

    ```ts
    const concurrency = 8;
    let index = 0;
    const worker = (): void => {
        let socket = sockets[index];
        index += 1;
        while (socket !== undefined) {
            pokeOne(socket);
            socket = sockets[index];
            index += 1;
        }
    };
    // The poke build + send is synchronous ... the bounded shape keeps the
    // structure aligned with `refreshSubscriptions` for when an async drain gate
    // is added.
    await Promise.all(
        Array.from({ length: Math.min(concurrency, sockets.length) }, () => {
            worker();
            return Promise.resolve();
        }),
    );
    ```

    The only real difference is that `refreshOne` is async (awaited) and `pokeOne`
    is synchronous. A helper that accepts a `processOne` returning `void | Promise<void>`
    unifies both — the sync case naturally needs no `await`.

## Commands you will need

| Purpose          | Command                                     | Expected on success |
| ---------------- | ------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)   |
| Tests            | `pnpm --filter "@lunora/do" run test`       | all pass            |
| Typecheck        | `pnpm --filter "@lunora/do" run lint:types` | exit 0              |
| Lint             | `pnpm run lint:eslint`                      | exit 0              |

## Scope

**In scope**:

- `packages/do/src/shard-do.ts` — add a private `runSocketPool` helper (or a
  module-local function), replace both hand-rolled pools with calls to it.
- Optionally a small focused unit test for the helper if it can be exercised in
  isolation (only if it's exported/extractable without widening the public API —
  otherwise rely on the existing poke/refresh integration tests).

**Out of scope**:

- The `refreshOne` / `pokeOne` bodies and the memo/advance logic — unchanged.
- The `concurrency = 8` value and the fan-out semantics — preserve exactly
  (same bounded parallelism, same shared-cursor draining order).
- `getWebSockets()` call-site count: if both methods currently call it once per
  flush, leave that as-is; do NOT change how `sockets` is obtained unless it's a
  trivial no-behavior-change consolidation you can prove.

## Git workflow

- Branch: `advisor/074-do-extract-socket-pool-helper`.
- Commit style: `refactor(do): extract shared bounded socket-pool helper`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Confirm 072 and 073 have landed

This extraction assumes the final shape of `pokeShapeSubscribers` (072) and
`refreshSubscriptions` (073). Confirm those plans are DONE in `plans/README.md`
and the excerpts above still match. If either is not landed, STOP — extracting
now means redoing it after they reshape these methods.

### Step 2: Add the helper

Add a helper with this contract (signature illustrative — match the file's style):

```ts
private async runSocketPool(
    sockets: readonly WebSocket[],
    processOne: (ws: WebSocket) => void | Promise<void>,
    concurrency = 8,
): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
        let socket = sockets[cursor];
        cursor += 1;
        while (socket !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- shared-cursor drain; parallelism from N workers
            await processOne(socket);
            socket = sockets[cursor];
            cursor += 1;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, sockets.length) }, () => worker()));
}
```

`await processOne(socket)` is correct for both cases: awaiting a non-promise is a
no-op, so the synchronous `pokeOne` path keeps running eagerly.

**Verify**: `pnpm --filter "@lunora/do" run lint:types` → exit 0.

### Step 3: Replace both call sites

- In `refreshSubscriptions`: `await this.runSocketPool(sockets, refreshOne);`
- In `pokeShapeSubscribers`: `await this.runSocketPool(sockets, pokeOne);`

Preserve the explanatory comments (move the "bounded fan-out / SQLite is
single-threaded" rationale to the helper's doc).

**Verify**: `pnpm --filter "@lunora/do" run test` → all pass (the existing
poke/refresh integration + plan 069/070/071 tests are the behavioral safety net).

## Test plan

- No behavior change is intended — the existing
  `subscription-refresh.integration.test.ts`, `shard-do.shape-poke.test.ts`, and
  the plan 070/071 matrices are the regression net. They must stay green.
- If the helper is unit-testable in isolation, add one small test asserting it
  processes every socket exactly once with bounded concurrency (e.g. a counter +
  a max-in-flight assertion). Skip if it would require widening the API.
- Verification: `pnpm --filter "@lunora/do" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/do" run test` exits 0.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] The `concurrency = 8` / shared-cursor pool structure appears **once** (in
      the helper), not twice — `grep -n "Math.min(concurrency, sockets.length)" packages/do/src/shard-do.ts`
      returns a single match.
- [ ] No files outside `packages/do/src/shard-do.ts` (and an optional test) are
      modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Plans 072 and/or 073 are not yet DONE (the methods will be reshaped — don't
  extract against a moving target).
- The two pools no longer match the "Current state" excerpts (they may have been
  unified or changed by 072/073 already — re-assess whether this plan is still
  needed).
- Unifying the sync + async cases changes any observed poke/refresh ordering or
  timing in a test.

## Maintenance notes

- This is the one place to evolve the DO's per-flush fan-out policy (concurrency,
  backpressure, drain gates). The poke path's comment about "for when an async
  drain gate is added" now applies to the shared helper.
- Keep the `processOne` return type `void | Promise<void>` so a future async poke
  path needs no signature change.
