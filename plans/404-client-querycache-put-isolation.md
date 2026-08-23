# Plan 404: Keep one throwing queryCache.put from dropping the whole coalesced cache batch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/src/lunora-client.ts packages/client/src/query-cache.ts`
> On any change, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition. (`lunora-client.ts` is large
> and busy — check the `flushQueryCacheWrites` method specifically.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`flushQueryCacheWrites` batches debounced cache writes and fires them with `Promise.allSettled` under an explicit comment: "a quota error on one key must not drop the others." But the mapper calls `queryCache.put(key, entry)` directly — a **synchronously** throwing `put` escapes `.map()` before `allSettled` ever runs, and the caller is `.catch(() => undefined)`, so the entire batch is silently lost. This is reachable with the in-repo default: `createInMemoryQueryCache.put` calls `structuredClone` synchronously, which throws on any non-cloneable value. `QueryCacheAdapter` is public API, so any third-party adapter that validates input synchronously has the same effect.

## Current state

- `packages/client/src/lunora-client.ts` — `flushQueryCacheWrites` (around `:4000-4017`):
    ```ts
    const batch = [...this.pendingCacheWrites.entries()];
    this.pendingCacheWrites.clear();
    // Writes are independent; fire them together and swallow individual
    // failures (a quota error on one key must not drop the others).
    await Promise.allSettled(batch.map(([key, entry]) => queryCache.put(key, entry)));
    ```
    Caller at `:3995`: `this.flushQueryCacheWrites().catch(() => undefined);`
- `packages/client/src/query-cache.ts:30-32,59-64` — the in-memory adapter's `put` runs `clone` → `structuredClone(entry.value)` before returning a promise.
- Error reporting seam: the client's persistence-error hook is `this.onPersistenceError` (`lunora-client.ts:841`, wired at `:1035` from `options.offlineQueue?.onPersistenceError`), used via `reportPersistenceError(this.onPersistenceError, "remove", error, id)` at `:5606`. Read `reportPersistenceError`'s signature (in `offline-queue.ts` or wherever it's exported) before using it — cache writes may or may not fit its `PersistenceErrorContext` shape; if it doesn't fit, keep the swallow-but-isolate behavior and skip reporting (the isolation is the bug fix; reporting is nice-to-have).

## Commands you will need

| Purpose    | Command                                          | Expected on success |
| ---------- | ------------------------------------------------ | ------------------- |
| Install    | `pnpm install`                                   | exit 0              |
| Build deps | `pnpm --filter "@lunora/client..." run build`    | exit 0              |
| Tests      | `pnpm --filter "@lunora/client" run test`        | all pass            |
| Typecheck  | `pnpm --filter "@lunora/client" run lint:types`  | exit 0              |
| Lint       | `pnpm --filter "@lunora/client" run lint:eslint` | exit 0              |

## Scope

**In scope**:

- `packages/client/src/lunora-client.ts` (only `flushQueryCacheWrites`)
- The existing test file covering the query cache flush (grep `flushQueryCacheWrites\|pendingCacheWrites\|queryCache` under `packages/client/__tests__/` to find it)

**Out of scope**:

- `query-cache.ts` adapters — a sync-validating adapter is legal; the caller must be robust to it.
- The debounce/coalescing logic.

## Git workflow

- Branch: `improve/wave22-client`
- Commit: `fix(client): isolate per-key query cache write failures`

## Steps

### Step 1: Defer each put into promise-land

```ts
await Promise.allSettled(batch.map(([key, entry]) => Promise.resolve().then(() => queryCache.put(key, entry))));
```

Keep the existing comment and extend it with one line: sync throws from `put` must be captured per-entry too.

**Verify**: `pnpm --filter "@lunora/client" run lint:types` → exit 0.

### Step 2: Regression test

In the existing query-cache flush test file: install a stub adapter whose `put` throws **synchronously** for one specific key and resolves for others; trigger two cache writes and the flush; assert the good key was stored. Model the client/stub setup on whichever existing test already drives `queryCache` writes.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass including the new case.

## Test plan

- The Step 2 case; existing suite green.

## Done criteria

- [ ] A synchronously-throwing `put` no longer prevents sibling writes (new test proves it)
- [ ] `pnpm --filter "@lunora/client" run test`, `lint:types`, `lint:eslint` all exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- `flushQueryCacheWrites` no longer matches the excerpt (drift).
- No existing test seam can observe cache writes without large new scaffolding — report what exists.

## Maintenance notes

- If reporting is wanted later, thread these failures through the same `reportPersistenceError` channel the offline queue uses (verify the context type fits first) — deferred out of this plan because isolation, not observability, is the defect.
