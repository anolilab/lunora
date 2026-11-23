# Plan 655: App-declared auth tables are root-only on export and import too

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/runtime/src/data-movement-admin-routes.ts packages/runtime/src/import-stream.ts packages/runtime/src/export-sections.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 651 (same branch)
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Commit `f918649b5` on branch `security/auth-admin-plane-gaps` made exporting or importing the built-in **auth section** require the root admin token (403 `ADMIN_ROOT_REQUIRED` for a named token), because those tables hold credentials and grants that outlive a named token's revocation. Its executor noted one gap: an app that declares its auth tables itself with `authTables(...)` (auth data kept in the app's own `.global()` tables rather than the separate auth store) exports and imports them as **ordinary table rows**, so the gate never sees them. A named token can still export password hashes and import an admin user in that topology. **Owner decision (2026-11-21): gate them too.**

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

| Purpose                       | Command                                                                                  | Expected on success |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                                         | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/runtime..." run build`                                           | exit 0              |
| One test file                 | `pnpm --filter "@lunora/runtime" exec vitest run __tests__/admin-import-replace.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/runtime" run test`                                               | all pass            |
| Types                         | `pnpm --filter "@lunora/runtime" run lint:types`                                         | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/runtime" run lint:eslint`                                        | exit 0, 0 warnings  |

## Design (decided)

Read `git show f918649b5` first, then how `authTables(...)` marks its tables (`rg -n "authTables" packages/auth/src packages/server/src packages/codegen/src | head -30`) and how the data-movement routes learn the schema's table list (the worker option codegen supplies, see `create-worker.ts` near `buildDataMovementAdminRoutes`). The routes need the set of app-declared auth table names; derive it from metadata that already reaches the worker if there is any (a table flag or a list codegen already emits). Then: an **export** whose resolved table list includes one of them, and an **import** (all entry points, incl. staged commit via the manifest's table list) carrying rows for one of them, call `assertRootAdmin` exactly where `f918649b5` checks the auth section. A whole-deployment export by a named token must not silently include them: either it is refused (403, with a message naming the tables and saying to list tables explicitly or use the root token) or they are left out — choose **refused**, so a backup is never silently incomplete. Sync/apply paths (`rg -n "applyGlobals|sync" packages/runtime/src/data-movement-admin-routes.ts | head`) that move the same rows get the same check.

## Steps

1. Tests first in `packages/runtime/__tests__/admin-import-replace.test.ts` beside the plan-651 cases, with a schema that declares `authTables`: named token export naming such a table → 403; whole-deployment export → 403; import/commit carrying its rows → 403 and nothing written; other tables unaffected; root works. Red at baseline. 2. Implement. 3. Docs: extend the sentence plan 651 added in `production-checklist.mdx` and `packages/cli/docs/index.mdx`. 4. Build, test, types, eslint for `@lunora/runtime` (and any package whose emitted metadata you extended).

## Git workflow

- Branch: `security/auth-admin-plane-gaps (EXISTING branch with plans 651 and 653, already pushed — check it out, add one commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(runtime): keep app-declared auth tables root-only`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- No metadata identifying `authTables(...)` tables reaches the worker and adding it needs a codegen emitter change with golden-fixture churn beyond one new field: STOP and report the smallest change.
- `authTables(...)` does not exist on this base or already routes through the auth section: report NOT REPRODUCED.
