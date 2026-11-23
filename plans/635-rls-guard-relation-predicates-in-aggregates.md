# Plan 635: Relation predicates inside `count` / `aggregate` / `groupBy` cannot read a protected, unpoliced child under `.rls("required")`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/shard-engine/src/rls-guard.ts packages/server/src/rls/middleware.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** TODO

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MEDIUM
- **Depends on**: plan 625 (same branch)
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Plan 625 (commit `642a66ee6` on branch `security/rls-shape-guards-intersect`) closed a leak: under `.rls("required")`, a protected table with no read policy could be read as a relation child. It gates `findMany` / `findFirst` / `findFirstOrThrow`. Its executor reported three gaps left open: (1) on the guarded path without `rls()`, a relation predicate inside the `where` of `count`, `aggregate` or `groupBy` still reads the child table unfiltered — a caller can learn whether protected child rows exist (an existence/count oracle); (2) no test covers a `.global()` child; (3) a `mask()` wrapper placed ahead of `rls()` copies the writer and drops the hidden gate key.

## Current state

Read commit `642a66ee6` first (`git show 642a66ee6`). In `packages/shard-engine/src/rls-guard.ts`, `RELATION_READ_METHODS` is `new Set(["findFirst", "findFirstOrThrow", "findMany"])` and `withRelationGate` injects `relationBaseWhere: relationGate` when the args carry `with` or `where` and no filter of their own. The regression tests are in `packages/testing/__tests__/rls-relation-children.test.ts`.

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

| Purpose                       | Command                                                                 | Expected on success |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                        | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/shard-engine..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/shard-engine" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/shard-engine" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/shard-engine" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/shard-engine" run lint:eslint`                  | exit 0, 0 warnings  |

## Steps

1. Tests first, in `packages/testing/__tests__/rls-relation-children.test.ts`: for a `.public()` parent read without `rls()`, a `count`, an `aggregate` and a `groupBy` whose `where` uses a relation predicate (`some` / `every` / `none`) on the protected unpoliced child must throw `RlsRequiredError`; the same with the parent behind an `rls()` read policy. Add a `.global()` protected child case for `with` and for a relation predicate if the test harness supports global tables (if it cannot, say so and skip that case — do not fake it). **Verify**: which fail at baseline; report each.
2. Fix gap 1: extend the gate to the methods whose `where` can carry a relation predicate — confirm how each receives `relationBaseWhere` (`rg -n "relationBaseWhere" packages/shard-engine/src packages/server/src`) before adding it; add only methods the engine actually reads the filter from. If the engine does not pass `relationBaseWhere` into relation predicates for one of them at all, that is an engine gap: fix it there only if it is a one-site change, else STOP for that method and report.
3. Gap 3 (`mask()`): write a test with `mask()` ahead of `rls()`. If the gate is lost, make the mask wrapper forward the hidden gate key the same way it should forward the existing unwrap key (`RLS_UNWRAP_SYMBOL`); if forwarding the unwrap key would change mask semantics, forward only the gate key and say why.
4. Build, test, types, eslint for `@lunora/shard-engine`, `@lunora/server`, `@lunora/testing`.

## Scope

**In scope**: `rls-guard.ts`, the mask wrapper (find with `rg -ln "mask\(" packages/server/src`), the relation-predicate reader if step 2 needs it, the test file. **Out of scope**: policy semantics for tables with a read policy; shapes (plan 624).

## Git workflow

- Branch: `security/rls-relation-predicates-aggregates (cut from origin/security/rls-shape-guards-intersect, NOT from origin/alpha — it builds on plan 625)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(shard-engine): gate relation predicates in aggregates`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## STOP conditions

- A fix needs a public type change (api snapshot diff): STOP and report the signature.
- Gating `count`/`aggregate`/`groupBy` breaks an existing test that documents the current behaviour with a reason: STOP and report it.
