# Plan 015: Vite codegen plugin cancels its debounce timer on server close

> **Executor instructions**: Follow step by step; verify; obey STOP conditions;
> update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 151a3eca..HEAD -- packages/vite/src/codegen-plugin.ts`
> Reconcile excerpt on change; mismatch ⇒ STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (latent)
- **Planned at**: commit `151a3eca`, 2026-06-14

## Why this matters

The codegen file-watcher debounce sets `closed = true` on server close and the
debounced callback early-returns when `closed`, so today nothing bad happens. But
the pending `setTimeout` is never cleared — a latent hazard: any future change
that does work before the `closed` check (or removes it) would run codegen
against a dead module graph during teardown. Clearing the timer on close removes
the footgun for the cost of two lines.

## Current state

`packages/vite/src/codegen-plugin.ts`:

- The debounce (`:305-343`): `onChange` clears+sets `debounceTimer`; the callback
  starts with `if (closed) return;`.
- The teardown (`:351+`): returns a function that registers
  `server.httpServer?.once("close", () => { closed = true; cachedProject = undefined; ... })`.
  It does **not** `clearTimeout(debounceTimer)`.

`debounceTimer` is a closure-scoped variable in the same `configureServer` scope
as the close handler, so the handler can clear it.

## Commands

| Purpose           | Command                                       | Expected |
| ----------------- | --------------------------------------------- | -------- |
| Build deps (once) | `pnpm run build:packages`                     | exit 0   |
| Typecheck         | `pnpm --filter "@cirrus/vite" run lint:types` | exit 0   |
| Tests             | `pnpm --filter "@cirrus/vite" run test`       | all pass |

## Scope

**In scope**: `packages/vite/src/codegen-plugin.ts` (the close handler) + the
codegen-plugin test file if it exercises lifecycle.
**Out of scope**: the codegen run logic, the error overlay, the studio plugin.

## Steps

### Step 1: Clear the debounce timer when the server closes

In the `httpServer.once("close", ...)` handler, before/after setting
`closed = true`, add:

```ts
if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
}
```

Keep the existing `closed = true` and `cachedProject = undefined` lines.

**Verify**: `pnpm --filter "@cirrus/vite" run lint:types` → exit 0.

### Step 2: Test (only if the suite already drives the watcher lifecycle)

If the codegen-plugin tests already simulate watcher events and close, add a test
that a pending debounce does not run after close. If the suite has no such seam,
skip the test (document that in the PR) — do not build new test infrastructure
for a two-line defensive change.

**Verify**: `pnpm --filter "@cirrus/vite" run test` → all pass.

## Done criteria

- [ ] Close handler clears the pending debounce timer
- [ ] `pnpm --filter "@cirrus/vite" run lint:types` exits 0
- [ ] `pnpm --filter "@cirrus/vite" run test` exits 0
- [ ] `git status` shows only in-scope files
- [ ] `plans/README.md` updated

## STOP conditions

- The debounce/close code no longer matches the excerpt.

## Maintenance notes

- Reviewer: confirm the `closed` early-return in the debounce callback is left in
  place (belt-and-suspenders with the timer clear).
