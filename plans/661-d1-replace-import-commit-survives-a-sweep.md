# Plan 661: A staged replace-import cannot wipe its tables if its staged rows expire mid-commit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/d1/src/import-staging.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

A replace import of `.global()` tables stages its rows in a D1 staging table, then on commit writes them and **prunes** every target row that is not among the staged ones. `packages/d1/src/import-staging.ts`: the commit checks once, at its start, that the session still holds staged rows (`holdsStagedRows`, ~368). `sweep()` (~178-187) runs at the start of every stage or commit call **of any session** and deletes staged rows of every session whose `expires_at` has passed. The commit never extends `expires_at` before it writes and prunes (~351-400); only staging (~256) and the final marker (~393) do. The prune (~320-322) is:

```ts
`SELECT "id" FROM ${quoteIdentifier(table)} WHERE "id" NOT IN (SELECT id FROM "${STAGE_TABLE}" WHERE session = ? AND tbl = ?) LIMIT ?`;
```

If another session's request sweeps this session's staged rows while the commit is still running, that subquery is empty, every target row matches, and the commit hard-deletes each table in scope — including the rows it just wrote — then records `committed` and reports success. The window is narrow (the staged rows' 24 h expiry has to run out during the commit) but the outcome is silent loss of whole tables.

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

| Purpose                       | Command                                                                            | Expected on success |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                   | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/d1..." run build`                                          | exit 0              |
| One test file                 | `pnpm --filter "@lunora/d1" exec vitest run __tests__/admin-export-import.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/d1" run test`                                              | all pass            |
| Types                         | `pnpm --filter "@lunora/d1" run lint:types`                                        | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/d1" run lint:eslint`                                       | exit 0, 0 warnings  |

## Design (decided)

Two cheap guards, both:

1. **Extend the lease first.** As the first write of the commit, push the session's staged rows' `expires_at` forward (the same statement staging uses), so a concurrent sweep cannot take them during the commit.
2. **Never prune against an empty stage.** Before each table's prune, re-check that the session still holds staged rows for that table **or** that the table was staged as deliberately empty (find how an intentionally empty table is represented in the manifest/stage — a replace that means "this table is now empty" must still work). If the staged rows are gone unexpectedly, abort with the existing `IMPORT_SESSION_EXPIRED` error before deleting anything for that table, and do not write the `committed` marker.

## Steps

1. Tests first in `packages/d1/__tests__/admin-export-import.test.ts` (next to the "expired before commit" cases ~817-855): start a commit, and between its start and a table's prune make another session's call sweep with the clock past the first session's expiry (inject the clock the way those tests do; hook the executor to interleave) → target rows are **not** deleted, the commit fails with `IMPORT_SESSION_EXPIRED`, no `committed` marker; a normal commit and a replace with a deliberately empty table still work. Red at baseline. 2. Implement. 3. Build `@lunora/d1...`, test, types, eslint.

## Git workflow

- Branch: `fix/d1-replace-import-sweep-guard`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `fix(d1): keep a swept replace import from wiping tables`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- An intentionally empty staged table cannot be told apart from a swept one with the data the stage keeps: implement guard 1 only, and report what marker guard 2 would need.

## Maintenance notes

- Reviewer: run `pnpm run test:workerd d1`.
