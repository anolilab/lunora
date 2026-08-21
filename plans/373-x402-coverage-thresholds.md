# Plan 373: Restore coverage thresholds in `@lunora/x402`'s vitest config

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md` — do
> not update it yourself.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/x402/vitest.config.ts tools/get-vitest-config.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/x402/vitest.config.ts` hand-rolls its coverage block with a comment claiming it is a "Mirror of the shared `tools/get-vitest-config` coverage block" — but the mirror omits `thresholds`, the one part with teeth. Every other package inherits `DEFAULT_COVERAGE_THRESHOLDS` (branches 70, functions 80, lines 80, statements 80) through the shared helper. So the package holding the spend policy and private-key custody resolution is the one package where deleting a test lowers no gate, and the omission is invisible because the config *looks* faithful.

## Current state

- `packages/x402/vitest.config.ts:4-22`:
  ```ts
  // Mirror of the shared `tools/get-vitest-config` coverage block. The workers
  // pool relies on `defineConfig` (not the shared helper, which would break the
  // `@cloudflare/vitest-pool-workers` projects), so coverage is wired inline here.
  const coverage = {
      ...coverageConfigDefaults,
      provider: "v8" as const,
      reporter: ["clover", "cobertura", "lcov", "text", "html"],
      include: ["src"],
      exclude: [ /* … */ ],
  };
  ```
  No `thresholds` key anywhere in the file.
- The shared block — `tools/get-vitest-config.ts:34-39,66-69`:
  ```ts
  export const DEFAULT_COVERAGE_THRESHOLDS: Required<CoverageThresholds> = {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
  };
  ...
              thresholds: {
                  ...DEFAULT_COVERAGE_THRESHOLDS,
                  ...coverageThresholds,
              },
  ```
- The config is two-project (`mocks` always on; `workerd` behind `LUNORA_WORKERD_TESTS=1`), which is WHY the shared helper isn't used — that rationale is sound and stays.
- Ratchet precedent: `packages/payment/vitest.config.ts` pins `{ branches: 68 }` where the default is unreachable today.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Build deps | `pnpm --filter "@lunora/x402..." run build` | exit 0 |
| Coverage  | `pnpm --filter "@lunora/x402" run test:coverage` | exits 0 (after thresholds set correctly) |
| Typecheck | `pnpm --filter "@lunora/x402" run lint:types` | exit 0 |

(If `test:coverage` doesn't exist in `packages/x402/package.json` scripts, use `pnpm --filter "@lunora/x402" exec vitest run --coverage`.)

## Scope

**In scope**:
- `packages/x402/vitest.config.ts`

**Out of scope**:
- `tools/get-vitest-config.ts` and every other package's config.
- Writing new tests to raise coverage — this plan installs the ratchet at today's measured level; raising it is separate work.
- The `workerd` project gating.

## Git workflow

- Branch: `improve/wave22-x402`.
- Commit: `test(x402): restore coverage thresholds`

## Steps

### Step 1: Measure current coverage

Run the coverage command (mocks project only — do NOT set `LUNORA_WORKERD_TESTS`; CI runs without it, and the threshold must gate what CI measures). Record the four totals (lines/statements/functions/branches) from the text reporter.

**Verify**: coverage report prints the four totals.

### Step 2: Add the thresholds

Import the shared defaults into the inline block:

```ts
import { DEFAULT_COVERAGE_THRESHOLDS } from "../../tools/get-vitest-config";
```

(Check how other package configs import from `tools/` — e.g. `grep -rn "get-vitest-config" packages/payment/vitest.config.ts packages/do/vitest.config.ts` — and match that path/style. If configs universally import the helper package-style rather than relative, match that instead.)

Then in the `coverage` object add:

```ts
thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS },
```

If (and only if) Step 1 measured a metric BELOW its default, pin that metric at the measured value (rounded down to an integer) as a ratchet, with a comment naming it, matching the payment precedent:

```ts
// Ratchet: measured <metric> at the time thresholds were restored; raise toward the
// shared default (see DEFAULT_COVERAGE_THRESHOLDS) as coverage improves.
thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS, branches: <measured> },
```

**Verify**: `pnpm --filter "@lunora/x402" run test:coverage` (or the exec form) → exit 0, thresholds enforced (temporarily lower one threshold above the measured value and confirm it FAILS, then restore — this proves the gate is live).

## Test plan

No new test files. The prove-the-gate-fires check in Step 2 is the verification.

## Done criteria

- [ ] `grep -n "thresholds" packages/x402/vitest.config.ts` → present, spreading `DEFAULT_COVERAGE_THRESHOLDS`
- [ ] Coverage run exits 0 at the configured thresholds
- [ ] A deliberately-too-high threshold makes the run fail (spot check, then reverted)
- [ ] `pnpm --filter "@lunora/x402" run lint:types` exits 0
- [ ] Only `packages/x402/vitest.config.ts` modified (`git status`)

## STOP conditions

- The config no longer matches the excerpt (someone added thresholds already).
- Importing from `tools/` breaks the `@cloudflare/vitest-pool-workers` project startup (the stated reason the shared helper is avoided) — fall back to hard-coding the four numbers with a comment naming `DEFAULT_COVERAGE_THRESHOLDS` as the source, and report the import failure.
- Measured coverage is drastically low (any metric under ~40%) — set the ratchet anyway but flag it prominently in your report; that gap is its own finding.

## Maintenance notes

- The inline mirror remains a divergence risk; if `tools/get-vitest-config.ts` grows another gate, this file needs it by hand. The comment at the top of the block is the reminder.
- Reviewer: confirm the thresholds apply to the run CI actually executes (mocks project, no `LUNORA_WORKERD_TESTS`).
