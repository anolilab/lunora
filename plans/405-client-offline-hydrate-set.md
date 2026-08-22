# Plan 405: Replace OfflineQueue.hydrate's O(n²) dedupe scan with a Set

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/client/src/offline-queue.ts`
> On any change, compare the "Current state" excerpt against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`hydrate` dedupes restored records with two nested linear scans inside the restore loop — O(n²) in the durable record count, on the boot path, on the main thread, inside the microtask that gates the client's `whenReady()`. The surrounding comment itself establishes that the durable store may legitimately hold **more** than `maxItems` (default 1000) records ("`maxItems` was lowered between sessions, or writes piled up while the app was fully offline across restarts"), which is exactly when the quadratic cost bites: ~10⁶ string comparisons at 1000 records, worse beyond.

## Current state

`packages/client/src/offline-queue.ts` (inside `hydrate`, around `:222-259`):

```ts
const restored: QueuedMutation[] = [];

for (const mutation of persisted) {
    if (this.items.some((item) => item.id === mutation.id) || restored.some((item) => item.id === mutation.id)) {
        continue;
    }
    ...
    restored.push({ ... });
}

this.items.unshift(...restored);
```

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

- `packages/client/src/offline-queue.ts` (the dedupe only)
- `packages/client/__tests__/offline-queue.test.ts` (only if no existing case covers duplicate-id hydration — check first)

**Out of scope**:

- The version gate, eviction, and restore-shape logic in the same loop — behavior must be byte-identical.

## Git workflow

- Branch: `improve/wave22-client`
- Commit: `perf(client): dedupe offline hydrate with a set`

## Steps

### Step 1: Set-based dedupe

Before the loop: `const seen = new Set(this.items.map((item) => item.id));` — in the loop, `if (seen.has(mutation.id)) { continue; }` and after passing all gates (including the version gate) `seen.add(mutation.id); restored.push({...})`. Note: add to `seen` at the same point the old code's `restored.some` check would have started matching — i.e. only for records actually pushed, so a version-gated duplicate id later in the list is still skipped by the first occurrence only if the first was pushed. Preserve the existing semantics exactly: in the old code, a record dropped by the version gate was NOT in `restored`, so a later duplicate of it was **not** deduped — replicate that by adding to `seen` only on push.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.

### Step 2: Coverage check

`grep -n "hydrate" packages/client/__tests__/offline-queue.test.ts` — if no existing case hydrates duplicate ids (both duplicate-of-in-memory and duplicate-within-persisted), add one asserting a single restored copy.

**Verify**: `pnpm --filter "@lunora/client" run test` → all pass.

## Test plan

- Existing hydrate tests must stay green (they pin the semantics); one duplicate-id case if missing.

## Done criteria

- [ ] No `.some((item) => item.id === ...)` remains inside the hydrate loop (`grep`)
- [ ] `pnpm --filter "@lunora/client" run test`, `lint:types`, `lint:eslint` all exit 0
- [ ] `git status` shows only in-scope files modified

## STOP conditions

- The loop's structure no longer matches the excerpt (drift).
- Any existing hydrate test fails — the semantics note in Step 1 was violated; re-read it, and if the old behavior is genuinely ambiguous, report rather than pick.

## Maintenance notes

- Trivial change; the only review point is the version-gate/dedupe ordering preserved per Step 1.
