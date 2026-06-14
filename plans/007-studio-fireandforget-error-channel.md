# Plan 007: Studio `fireAndForget` surfaces errors instead of silently swallowing them

> **Executor instructions**: Follow step by step; verify each step; obey STOP
> conditions; update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/studio/src/lib/internal.ts`
> Reconcile excerpt on change; mismatch ⇒ STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt / bug
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

`fireAndForget` swallows every rejection. It's used ~50 times, including for
state-changing operations (migration runs, deletes, imports). When one of those
fails, the user sees nothing — the operation silently no-ops. Adding an optional
error sink (and routing the critical call sites through it to the studio's
existing error/toast surface) turns invisible failures into visible ones without
changing the ergonomics of the genuinely fire-and-forget navigation cases.

## Current state

`packages/studio/src/lib/internal.ts:56-61`:

```ts
export const fireAndForget = (promise: Promise<unknown>): void => {
    promise.catch(() => {
        /* loaders surface their own errors into panel state */
    });
};
```

Before writing code, discover:
1. The studio's existing user-facing error surface (toast / notification / error
   state). Run `grep -rn "toast\|notify\|setError\|ErrorBanner" packages/studio/src | head`
   to find the convention. Use whatever already exists — do not introduce a new
   notification system.
2. The critical (state-changing) call sites:
   `grep -rn "fireAndForget(" packages/studio/src` then identify the ones whose
   promise performs a mutation/migration/import/delete (as opposed to navigation
   or a refresh that already writes its own error into panel state).

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Build deps (once) | `pnpm run build:packages` | exit 0 |
| Typecheck | `pnpm --filter "@cirrus/studio" run lint:types` | exit 0 |
| Tests | `pnpm --filter "@cirrus/studio" run test` | all pass |

## Scope

**In scope**:
- `packages/studio/src/lib/internal.ts` (add the optional sink)
- The handful of critical call sites you identify in discovery (mutations/
  migrations/imports/deletes) — pass an `onError`.
- The studio test file covering `internal.ts` (or a new one).

**Out of scope**:
- Navigation / panel-refresh `fireAndForget` sites that already surface errors in
  panel state — leave them.
- Building a new toast/notification system — reuse the existing one.
- The data-browser stale-overwrite/abort-on-unmount concern (a separate, larger
  change) — do NOT attempt it here.

## Steps

### Step 1: Add an optional error sink, preserving the default

```ts
export const fireAndForget = (promise: Promise<unknown>, onError?: (error: unknown) => void): void => {
    promise.catch((error: unknown) => {
        onError?.(error);
        /* default: loaders surface their own errors into panel state */
    });
};
```

Backward compatible — existing call sites pass no second arg and behave exactly
as before.

**Verify**: `pnpm --filter "@cirrus/studio" run lint:types` → exit 0.

### Step 2: Route critical call sites through the error surface

For each critical site found in discovery, pass an `onError` that reports through
the existing studio error/toast surface, e.g.:

```ts
fireAndForget(runMigration(id), (error) => showError(`Migration failed: ${messageOf(error)}`));
```

Use the actual surface and message-extraction helper the studio already uses
(find them in discovery). Do not change unrelated sites.

**Verify**: `pnpm --filter "@cirrus/studio" run lint:types` → exit 0.

### Step 3: Test

Add a test asserting `fireAndForget(rejectingPromise, onError)` invokes `onError`
with the rejection, and that `fireAndForget(rejectingPromise)` (no sink) does not
throw. Model on the existing studio lib tests.

**Verify**: `pnpm --filter "@cirrus/studio" run test` → all pass.

## Done criteria

- [ ] `fireAndForget` accepts an optional `onError`, default behavior unchanged
- [ ] Critical (state-changing) call sites report failures to the existing error surface
- [ ] `pnpm --filter "@cirrus/studio" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run test` exits 0 with new test
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- `fireAndForget` no longer matches the excerpt.
- The studio has no existing error/toast surface to route into (report — do not
  invent one).
- Discovery reveals far more than a handful of critical sites and routing them
  balloons scope — report and propose a follow-up.

## Maintenance notes

- New state-changing `fireAndForget` calls should pass `onError`. Consider a lint
  note or comment by the definition.
- Reviewer: confirm only state-changing sites were rewired; navigation sites
  intentionally stay silent.
- Deferred: aborting in-flight data-browser fetches on unmount/shard-switch
  (separate plan).
