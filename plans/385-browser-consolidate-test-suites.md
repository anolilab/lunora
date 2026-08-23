# Plan 385: Consolidate `@lunora/browser`'s split test suites into `__tests__/`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/browser`
> On any drift, compare the "Current state" excerpts against live code; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / tech-debt
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`packages/browser` is the only package in the monorepo with tests inside `src/` (`ls -d packages/*/src/__tests__` → exactly one hit), and its suite for one module is split across two files with zero describe-name overlap: `src/__tests__/create-browser.test.ts` (~600 lines: URL validation, DNS-rebinding re-check, allowlist, clamping) and `__tests__/create-browser.test.ts` (~500 lines: operation timeouts, SSRF redirect/sub-resource guards, session reuse). These are the package's SSRF guards — a new redirect/rebinding case lands in whichever file the author opened, and the other rots. The src-side file also reaches across the boundary (`import { stubDohFetch } from "../../__tests__/_helpers/stub-doh"`), and `src/**/*.test.ts` in the vitest include means a source-tree glob picks up test code.

## Current state

- `packages/browser/src/__tests__/create-browser.test.ts` — 31 `it`s (guards: url validation, rebinding, allowlist, clamping).
- `packages/browser/__tests__/create-browser.test.ts` — 22 `it`s (timeouts, SSRF redirect/sub-resource, session reuse); helpers at `packages/browser/__tests__/_helpers/stub-doh.ts`.
- `packages/browser/vitest.config.ts:35`:
    ```ts
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    ```
    and `coverage.include: ["src"]` at `:15` (coverage include is fine once no tests live under src).

## Commands you will need

| Purpose    | Command                                           | Expected on success                                                                                      |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Install    | `pnpm install`                                    | exit 0                                                                                                   |
| Build deps | `pnpm --filter "@lunora/browser..." run build`    | exit 0                                                                                                   |
| Tests      | `pnpm --filter "@lunora/browser" run test`        | all pass, **53 tests** (31+22 — count them before moving: `pnpm --filter "@lunora/browser" run test 2>&1 | tail -5`) |
| Typecheck  | `pnpm --filter "@lunora/browser" run lint:types`  | exit 0                                                                                                   |
| Lint       | `pnpm --filter "@lunora/browser" run lint:eslint` | exit 0                                                                                                   |

## Scope

**In scope**:

- `packages/browser/src/__tests__/create-browser.test.ts` → move to `packages/browser/__tests__/create-browser.guards.test.ts`
- `packages/browser/vitest.config.ts` (drop the `src/**/*.test.ts` include)
- Import-path fixes inside the moved file only

**Out of scope**:

- Merging the two files' contents into one — a rename keeps the diff reviewable; renaming describes/merging can be a follow-up.
- Any change to the SSRF guard source code.
- `playwright-projection.test-d.ts` — type-level test, already in the right place.

## Git workflow

- Branch: `improve/wave22-browser`
- Commit: `test(browser): move src suite to __tests__`

## Steps

### Step 1: Record the baseline count

Run the test suite; note the exact total test count and that all pass.

**Verify**: `pnpm --filter "@lunora/browser" run test` → all pass; record N.

### Step 2: Move the file

`git mv packages/browser/src/__tests__/create-browser.test.ts packages/browser/__tests__/create-browser.guards.test.ts`. Fix its relative imports: the source-module import gains one `../` → `../src/...` (match how the sibling `__tests__/create-browser.test.ts` imports the module — copy its specifier), and the `stub-doh` helper import becomes `./_helpers/stub-doh`. Remove the now-empty `src/__tests__/` directory.

**Verify**: `pnpm --filter "@lunora/browser" run test` → all pass, same count N.

### Step 3: Tighten the vitest include

Change `include` to `["__tests__/**/*.test.ts"]`.

**Verify**: `pnpm --filter "@lunora/browser" run test` → same count N (proves nothing was dropped by the glob change); `ls packages/browser/src/__tests__ 2>&1` → "No such file or directory".

## Test plan

No new tests — the invariant is the unchanged test count N across all three steps. If any test's behavior changes from the move (module resolution, helper state), that's a STOP, not a fix-in-place.

## Done criteria

- [ ] `ls -d packages/*/src/__tests__` → no matches repo-wide
- [ ] Test count identical to the Step 1 baseline, all passing
- [ ] `grep -n "src/\*\*/\*.test" packages/browser/vitest.config.ts` → no matches
- [ ] No files outside the in-scope list modified (`git status` — the move shows as R)

## STOP conditions

- The two files turn out to contain duplicate test names covering the same behavior with conflicting expectations (report the pairs; reconciliation needs a human call on which expectation is correct).
- The moved file's tests fail for any reason other than an import path you can mechanically fix.

## Maintenance notes

- Follow-up (deliberately deferred): merge overlapping describes across the two files and dedupe fixture setup. Reviewer: confirm the coverage report still covers `src` identically (the coverage include never targeted the test files).
