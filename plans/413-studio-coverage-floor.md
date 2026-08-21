# Plan 413: Restore a coverage floor over the studio's node-testable half

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/studio/vitest.config.ts package.json packages/studio/package.json`
> On any change, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`@lunora/studio` (~40k LOC, an admin UI over live data — the largest package in this wave's scope) has its coverage thresholds pinned to `{ branches: 0, functions: 0, lines: 0, statements: 0 }` and is excluded from both root coverage scripts. The recorded reason is that a full component run stalls under v8 coverage — but the same config already defines a pure-node `unit` project of DOM-free files (`unitTestFiles`, `vitest.config.ts:15`, wired as `test: { name: "unit", environment: "node", include: unitTestFiles }` at `:68`), which is not the half that stalls. Result: the pure-logic modules (`sql-diagnostics`, `data-view-params`, `ws-token-provider`, `operation-log`, `mask-preview`) can silently lose all their tests without any gate noticing. Repo default is branches 70 / functions 80 / lines 80 / statements 80 (`tools/get-vitest-config.ts:34-39`); wave-21 plan 321 restored floors to six other packages and left this one at zero.

## Current state

- `packages/studio/vitest.config.ts:95-98`:
  ```ts
  // coverage stalls. The suite is green and fast without coverage. Zeroed
  // until it can finish under coverage.
  { branches: 0, functions: 0, lines: 0, statements: 0 },
  ```
- Root `package.json:65,67` — both coverage scripts exclude the package: `--query "project!=lunora-e2e&&project!=studio&&project!=lunora-playground"`.
- The `unit` project: `vitest.config.ts:15` (`unitTestFiles` list), `:68` (node-env project), `:86` (the component project excludes `unitTestFiles`).

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/studio..." run build` | exit 0 |
| Unit coverage (measure) | `pnpm --filter "@lunora/studio" exec vitest run --project unit --coverage` | completes without stalling; prints the coverage table |
| Tests     | `pnpm --filter "@lunora/studio" run test` | all pass |
| Typecheck | `pnpm --filter "@lunora/studio" run lint:types` | exit 0 |

## Scope

**In scope**:
- `packages/studio/vitest.config.ts` (project-scoped thresholds)
- `packages/studio/package.json` (a `test:coverage` script scoped to `--project unit`, if one doesn't exist — check first)
- Root `package.json` (remove `project!=studio` from the two coverage queries **only if** studio's `test:coverage` is now the unit-scoped one — the vis target must not re-trigger the stalling full run)

**Out of scope**:
- Writing new tests. This plan installs the ratchet at today's measured numbers; raising them is future work.
- The component project's coverage (the documented stall) — leave it uncovered and keep the explanatory comment, updated to say the unit project IS gated.

## Git workflow

- Branch: `improve/wave22-studio`
- Commit: `test(studio): gate unit-project coverage at measured floor`

## Steps

### Step 1: Measure

Run the unit-coverage command above. Record the four percentages for the `unit` project. If the run stalls (>10 minutes) even for the unit project, STOP — the recorded stall reason covers more than assumed.

**Verify**: coverage table printed; numbers recorded.

### Step 2: Scope thresholds to the unit project

Vitest thresholds are global to a run, so gate coverage on the unit-project run: give the studio a `test:coverage` script that runs `vitest run --project unit --coverage`, and set the thresholds (measured numbers, rounded DOWN to whole percents) in the config — either in the unit project's own coverage block or guarded so the zeroed values no longer apply to the unit run (inspect how the final config argument at `:95-98` is consumed; keep the change minimal). Preserve a comment: component project deliberately ungated (stalls); unit project ratcheted at measured floor 2026-08-21.

**Verify**: `pnpm --filter "@lunora/studio" run test:coverage` → exits 0. Then temporarily lower one threshold source file's coverage… (don't actually — instead verify the gate is live by setting one threshold 1 point above measured, confirming failure, then restoring; note this check in your report).

### Step 3: Root scripts

Remove `project!=studio` from `test:coverage` and `test:affected:coverage` queries in root `package.json` so CI's coverage lane includes the unit-scoped studio run.

**Verify**: `pnpm run lint:package-json` → exit 0. `grep -c "project!=studio" package.json` → 0.

## Test plan

No new tests; the deliverable is the live gate (Step 2's above/below verification).

## Done criteria

- [ ] `pnpm --filter "@lunora/studio" run test:coverage` exits 0 and enforces non-zero thresholds
- [ ] `grep -c "project!=studio" package.json` → 0
- [ ] `pnpm --filter "@lunora/studio" run test` exits 0 (plain run unaffected)
- [ ] `pnpm run lint:package-json` exits 0
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

- The unit project also stalls under coverage (Step 1).
- Scoping thresholds per-project is impossible without forking the shared `tools/get-vitest-config` helper — report the config-shape problem instead of duplicating the helper.
- The root vis `test:coverage` target for studio cannot be pointed at the unit-scoped script without affecting the plain `test` target.

## Maintenance notes

- The floor is a ratchet: raise it when unit tests are added, never lower it to admit a regression.
- Reviewer: confirm CI's coverage job actually executes the studio row now (check the vis query semantics, not just the package script).
