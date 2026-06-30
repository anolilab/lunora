# Plan 066: Stop re-serializing the synced base on every diff-emit tick

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f779358..HEAD -- packages/db/src/internals.ts`
> If it changed, compare the "Current state" excerpt against the live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `9f779358`, 2026-06-29

## Why this matters

`makeDiffEmit` is the hot path that turns a fresh server snapshot into TanStack DB
sync writes on every sync tick. For each row it compares the previous and next
values with `JSON.stringify(previous) !== JSON.stringify(value)`. The `previous`
side is the row already stored in the `synced` map — re-serialized from scratch
on every tick even though it never changed since it was stored. For a collection
of N rows that's N redundant `JSON.stringify` calls per emit, on the per-keystroke
sync path. Caching the serialized form of each synced row alongside the row turns
the comparison into "serialize the new value once, compare against the stored
string," halving the stringify work and removing the redundant one entirely.

## Current state

- `packages/db/src/internals.ts` — `makeDiffEmit` (around lines 151–178). The
  `synced` map holds `Map<string, T>` (server snapshots), and the comparison
  re-stringifies both sides each call:

    ```ts
    export const makeDiffEmit =
        <T extends object>(synced: Map<string, T>, writer: SyncWriter<T>) =>
        (next: Map<string, T>): void => {
            writer.begin();

            for (const [key, value] of next) {
                const previous = synced.get(key);

                if (previous === undefined) {
                    writer.write({ type: "insert", value });
                } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
                    writer.write({ type: "update", value });
                }
            }

            for (const key of synced.keys()) {
                if (!next.has(key)) {
                    writer.write({ key, type: "delete" });
                }
            }

            writer.commit();
            synced.clear();

            for (const [key, value] of next) {
                synced.set(key, value);
            }
        };
    ```

    The docstring above the function already states the comparison is by
    `JSON.stringify` and is key-order sensitive — "safe here because `synced` only
    ever holds server snapshots, whose column order is stable across reconnects."
    That invariant is what makes a cached string sound: a stored row's serialization
    is stable, so caching it can't go stale while it sits in the map.

- `synced` is owned by the caller (`collection-options.ts` constructs it and
  passes it to `makeDiffEmit`). It is also read elsewhere? Verify before changing
  its type — see STOP conditions.

## Commands you will need

| Purpose          | Command                                     | Expected on success |
| ---------------- | ------------------------------------------- | ------------------- |
| Build deps first | `pnpm run build:packages`                   | exit 0 (run once)   |
| Typecheck        | `pnpm --filter "@lunora/db" run lint:types` | exit 0, no errors   |
| Tests            | `pnpm --filter "@lunora/db" run test`       | all pass            |
| Lint             | `pnpm run lint:eslint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `packages/db/src/internals.ts` — `makeDiffEmit` and, if you choose the
  internal-cache approach, only that function's local state.
- `packages/db/__tests__/internals.test.ts` — extend/confirm coverage.

**Out of scope** (do NOT touch):

- `packages/db/src/collection-options.ts` — only touch it if the chosen design
  _requires_ changing how `synced` is constructed; prefer a design that keeps the
  external `synced: Map<string, T>` signature so callers are unaffected
  (see Step 1). If you find you must change the signature, STOP and report.

## Git workflow

- Branch: `advisor/066-db-cache-diff-emit-serialization`.
- Commit style: `perf(db): cache synced-row serialization in makeDiffEmit`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Cache the serialized form of each synced row inside the closure

Keep the public signature `makeDiffEmit(synced: Map<string, T>, writer)` exactly
as-is (callers pass `synced`). Add a closure-local `Map<string, string>` that
caches the JSON for each key currently in `synced`, and drive the comparison off
it:

```ts
export const makeDiffEmit = <T extends object>(synced: Map<string, T>, writer: SyncWriter<T>) => {
    // Serialized form of each synced row, kept in lockstep with `synced`.
    // `synced` only ever holds server snapshots with stable column order
    // (see the comparison-safety note below), so a cached string never goes
    // stale while its row sits in the map.
    const syncedJson = new Map<string, string>();

    return (next: Map<string, T>): void => {
        writer.begin();

        const nextJson = new Map<string, string>();

        for (const [key, value] of next) {
            const valueJson = JSON.stringify(value);

            nextJson.set(key, valueJson);

            if (!synced.has(key)) {
                writer.write({ type: "insert", value });
            } else if (syncedJson.get(key) !== valueJson) {
                writer.write({ type: "update", value });
            }
        }

        for (const key of synced.keys()) {
            if (!next.has(key)) {
                writer.write({ key, type: "delete" });
            }
        }

        writer.commit();

        synced.clear();
        syncedJson.clear();

        for (const [key, value] of next) {
            synced.set(key, value);
        }

        for (const [key, valueJson] of nextJson) {
            syncedJson.set(key, valueJson);
        }
    };
};
```

Key points:

- The new value is stringified exactly once per row per tick (`valueJson`), used
  for both the comparison and to repopulate the cache. The previous value is
  never re-stringified — that's the redundant work removed.
- `synced` is still cleared and repopulated identically, so any external reader of
  `synced` sees the same contents as before.
- Preserve the existing insert/update/delete ordering and the `begin`/`commit`
  bracketing.

**Verify**: `pnpm --filter "@lunora/db" run lint:types` → exit 0.

### Step 2: Confirm the diff behavior is unchanged

Run the existing `internals.test.ts`. It should already exercise
insert/update/delete/no-op transitions. Confirm all pass unchanged. Add a test
only if there's a gap (see Test plan).

**Verify**: `pnpm --filter "@lunora/db" run test` → all pass.

## Test plan

- The behavior to lock in (likely already covered in `internals.test.ts`):
    - a new key → `insert`;
    - a key whose serialized value changed → `update`;
    - a key present with an identical value → **no write** (the cache hit path);
    - a key absent from `next` → `delete`;
    - across two consecutive emits, the second emit with identical `next` produces
      no writes (proves the cache is repopulated correctly).
- Structural pattern: model after the existing cases in
  `packages/db/__tests__/internals.test.ts`.
- Verification: `pnpm --filter "@lunora/db" run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter "@lunora/db" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/db" run test` exits 0; the no-op/no-write case is
      covered and passes.
- [ ] `pnpm run lint:eslint` exits 0.
- [ ] `grep -n "JSON.stringify(previous)" packages/db/src/internals.ts` returns
      nothing (the redundant re-serialization is gone).
- [ ] The exported signature of `makeDiffEmit` is unchanged (callers in
      `collection-options.ts` are not modified).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- `makeDiffEmit` no longer matches the "Current state" excerpt.
- You find any consumer that relies on `makeDiffEmit` re-stringifying on every
  call (there shouldn't be — it's a pure diff emitter).
- The only correct fix requires changing the public `synced: Map<string, T>`
  signature or how `collection-options.ts` constructs it.

## Maintenance notes

- The cached string is only valid because `synced` holds server snapshots with
  stable column order. If a future change ever stores client-mutated or
  reordered objects in `synced`, the cache assumption (and the existing
  `JSON.stringify` comparison itself) breaks — that's the invariant a reviewer
  should guard.
