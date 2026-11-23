# Plan 616: sql-store reports a missing row as NOT_FOUND, like the shard writer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 093c5e41f..HEAD -- packages/sql-store/src/ctx-db.ts packages/sql-store/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `093c5e41f` (2026-11-20)
**Status:** DONE, pushed: `fix/data-rank-notfound-collectors`; PR #1636

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `093c5e41f`, 2026-11-20
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Lunora has two implementations of `ctx.db`: the Durable Object writer (`@lunora/shard-engine`) for shard tables and the SQL writer (`@lunora/sql-store`) for `.global()` tables on D1/Postgres. When application code patches, replaces, deletes or restores a row id that does not exist, the shard writer throws `LunoraError("NOT_FOUND", "document not found: <id>")` (HTTP 404). The SQL writer throws `LunoraError("INTERNAL", ...)` for the same caller mistake, which surfaces as a 500, pollutes error budgets, and makes the same app code behave differently depending on where a table lives.

## Current state

`packages/sql-store/src/ctx-db.ts` has seven sites (line numbers at the planned commit), each reading exactly `throw new LunoraError("INTERNAL", <template string "document not found: " + id>);`:

lines 3174, 4209, 4215, 4307, 4827, 4833, 4844. List them live with: `rg -n "document not found" packages/sql-store/src/ctx-db.ts`.

Line 3174 is in `writePatch`; 4307 is in `restore`. The shard twin, for reference (do not edit): `packages/shard-engine/src/ctx-db.ts` throws `LunoraError("NOT_FOUND", ...)` with the same message in `patch` (~line 4597) and `restore` (~line 5061).

`LunoraError` comes from `@lunora/errors`; `"NOT_FOUND"` is an existing catalog code (confirm: `rg -n "NOT_FOUND" packages/errors/src | head -3`).

Tests live in `packages/sql-store/__tests__/` (`ctx-db.test.ts`, `ctx-db.round-trips.test.ts`, …) with helpers under `__tests__/_helpers`.

### Repo conventions that apply (from the repo's AGENTS.md — you have not read it, so they are inlined)

- TypeScript, ESM, `"moduleResolution": "bundler"`: relative imports have **no** file extension (`from "./foo"`, never `"./foo.js"`).
- Never mix a default export with named exports in one file. More than one export ⇒ named only.
- This is a pre-release (`1.0.0-alpha.*`) line: do **not** keep backward-compat shims or deprecated aliases; change the behaviour and update every call site.
- Comments say _why_ (a constraint or invariant), never restate the code or record history.
- An `eslint-disable` must be line-scoped, name the rule, and give a reason after `--`. Never add a file-level disable. Never skip or silence a test, type error or lint rule to get green.
- Tests are Vitest, live in the package's `__tests__/`, and **wait on a milestone, never on a clock** (no `sleep`, no real `setTimeout` waits). Existing tests start with `expect.assertions(n)`; match that.
- **A test must fail without the fix.** After writing a test, temporarily revert your fix, run the test, confirm it goes red, then restore the fix. Report that you did this.
- If you fix by hand: run Prettier before ESLint.
- Never run `pnpm -r run test`, never `pnpm run test:workerd`, never `pnpm run build:packages` (other sessions share this machine; those have crashed it). Use the single-package commands below.
- Never kill a process by name/pattern. Never `git add -A` / `git commit -a` / `git stash`; stage explicit paths.

## Commands you will need

Run everything from the repo (worktree) root. `dist/` is not committed, so build the package and its workspace dependencies once before testing or type-checking.

| Purpose                       | Command                                                                                | Expected on success |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                       | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/sql-store..." run build`                                       | exit 0              |
| One test file                 | `pnpm --filter "@lunora/sql-store" exec vitest run __tests__/ctx-db.not-found.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/sql-store" run test`                                           | all pass            |
| Types                         | `pnpm --filter "@lunora/sql-store" run lint:types`                                     | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/sql-store" run lint:eslint`                                    | exit 0, 0 warnings  |

## Scope

**In scope**: `packages/sql-store/src/ctx-db.ts` (only those throw sites); `packages/sql-store/__tests__/ctx-db.not-found.test.ts` (create); existing tests anywhere that assert the old `INTERNAL` code for this message (update the expectation only).

**Out of scope**: every other `INTERNAL` throw in the file (unknown table, not a soft-delete table, …) — those are programmer/configuration errors and stay; `packages/shard-engine/**`; message text.

## Git workflow

- Branch: `fix/541-sql-store-not-found` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Example from this repo: `fix(auth): address API key review comments`. Use: `fix(sql-store): report a missing row as NOT_FOUND`.
- Never use `--no-verify`. Do NOT push or open a PR.

## Steps

### Step 1: classify each site

For each of the seven lines, read the enclosing method (20 lines up). It is a caller error (→ `NOT_FOUND`) when the condition is "no row with this id / table could not be resolved for this id". If a site is instead an invariant ("row vanished between our own read and write inside one guarded write"), leave it `INTERNAL` and list it in your report with the reason.

### Step 2: change the code

Replace `"INTERNAL"` with `"NOT_FOUND"` at the caller-error sites. Then `rg -n "document not found" packages --glob '!**/dist/**' --glob '!**/node_modules/**' -g '*.ts'` and update any test that expects `INTERNAL` for these paths (expect a handful at most, likely in `packages/sql-store/__tests__`, `packages/d1/__tests__`, `packages/platform/src/conformance`).

**Verify**: `pnpm --filter "@lunora/sql-store" run lint:types` → exit 0.

### Step 3: test

Create `ctx-db.not-found.test.ts`, modelled on the setup at the top of `ctx-db.test.ts` (same helper to open a store and schema; include one `.softDelete()` table). One `it` per public method reached by the changed sites — at least `patch`, `replace`, `delete`, `restore` on an absent id — each asserting `await expect(...).rejects.toMatchObject({ code: "NOT_FOUND" })`.

**Verify red**: revert step 2, rerun → the new tests fail. Restore.

### Step 4: neighbours

`pnpm --filter "@lunora/sql-store" run test` → pass. Then build and test the thin wrapper: `pnpm --filter "@lunora/d1..." run build && pnpm --filter "@lunora/d1" run test` → pass.

## Done criteria

- [ ] `rg -n "document not found" packages/sql-store/src/ctx-db.ts | rg -c INTERNAL` equals the number of sites you justified keeping (0 expected; `rg -c` prints nothing and exits 1 for zero)
- [ ] sql-store and d1 tests, `lint:types`, `lint:eslint` exit 0
- [ ] `git status --short` lists only in-scope files

## STOP conditions

- The seven sites are not where listed.
- A caller in another package branches on `code === "INTERNAL"` for this message (`rg -n "document not found" packages/*/src`).
- More than ~10 tests need their expectation changed.

## Maintenance notes

- Second instance of DO/SQL twin drift found in one audit (see plan 612); plan 623 addresses the cause.
- Reviewer: run `pnpm run test:workerd` before merge (SQL path).
