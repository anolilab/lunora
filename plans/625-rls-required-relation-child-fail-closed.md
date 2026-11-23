# Plan 625: Under `.rls("required")`, a protected table without a read policy stays closed when loaded as a relation (investigate, then fix)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/server/src/rls/middleware.ts packages/shard-engine/src/rls-guard.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE (leak confirmed and fixed), pushed: `security/rls-shape-guards-intersect`; follow-up in 635; PR #1637

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

With `.rls("required")` a non-public table that has no read policy must not be readable: a direct read throws `RlsRequiredError` (secure by default). The suspicion is that the same table can still be read as a child: `ctx.db.parent.findMany({ with: { child: true } })` or `_count`. The relation filter the RLS middleware hands the engine returns "no predicate" for such a table, and "no predicate" may be read as "unrestricted". This plan first proves or disproves that with a test, and fixes it only if it is real. **Half of this finding is unconfirmed**: the filter side was read by the plan author; the engine side was not.

## Current state

`packages/server/src/rls/middleware.ts` (~lines 993-1016):

```ts
/**
 * Route a READ to the writer that should service it. Uses `raw` (bypassing the
 * secure-by-default guard) only when the table has an active `on:"read"` policy
 * — i.e. `readBase(table).restricts` is true — because that read is authorized
 * and filtered by the policy `baseWhere`. Otherwise it routes to the guarded
 * `base`: a protected table that appears in the bundle only via a WRITE policy
 * has no read policy, so it must fail closed under `.rls("required")` rather
 * than returning every row unfiltered, while a `.public()` table passes
 * through. This keeps read routing in fail-closed parity with `guardWriter` and
 * `shape-read-base.ts`; writes route via `gateById`/insert, not this router.
 */
const route = (tableName: string): RlsDatabase => (readBase(tableName).restricts ? raw : base);

/**
 * The read filter for a TARGET table, attached to every read so `@lunora/do`'s
 * `resolveWith` can enforce a child table's read policy when it's loaded as a
 * `with` relation (or `_count`). It returns the SAME `baseWhere` a top-level
 * read of that table would get — so a relation read matches a direct read,
 * closing the RLS bypass where `findMany({ with: { child: true } })` would
 * otherwise return the child's rows unfiltered. `undefined` for tables with
 * no restricting policy.
 */
const relationReadFilter = (table: string): undefined | WhereInput => readBase(table).baseWhere;
```

`readBase(table)` returns `{ baseWhere: undefined, restricts: false }` for a table no step has a read policy for. `relationReadFilter` is passed as `relationBaseWhere` on every read option bag (`rg -n "relationBaseWhere" packages` to find the consumer in the engine).

`packages/shard-engine/src/rls-guard.ts` `guardWriter` (~line 347): returns the raw writer unless `schema.rlsMode === "required"`; otherwise `guardTable(name)` throws `RlsRequiredError` for a known, non-public table. It takes a `relationEdges` parameter — read how it uses it: that is the unconfirmed half.

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

| Purpose                       | Command                                                                | Expected on success |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                       | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/server..." run build`                          | exit 0              |
| One test file                 | `pnpm --filter "@lunora/server" exec vitest run __tests__/rls.test.ts` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/server" run test`                              | all pass            |
| Types                         | `pnpm --filter "@lunora/server" run lint:types`                        | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/server" run lint:eslint`                       | exit 0, 0 warnings  |

## Steps

1. Read the consumer of `relationBaseWhere` and `guardWriter`'s handling of `with` / `_count` (`relationEdges`). Write down, with file:line, what happens when a parent read is routed to `raw` (the parent has a read policy) and a requested child table is protected with no read policy.
2. Write the test first, in `packages/server/__tests__/rls.test.ts` next to the existing relation-filter tests (see the one near "must still be filtered by `relationReadFilter`"): schema in required mode; `parent` with a read policy that admits the row; `child` non-public with **no** read policy and existing rows; a `.public()` child as a control. Assert that `findMany(parent, { with: { child: true } })`, the `_count` form, and a nested `with` (grandchild) do **not** return the protected child's rows, and that the public child still loads.
3. Run it.
    - **It passes without a source change**: the engine already fails closed. Keep the test as a regression pin, commit it as `test(server): pin relation reads of unpoliced tables under required rls`, and report NOT REPRODUCED with the file:line that closes it. Done.
    - **It fails** (child rows come back): continue.
4. Fix. Decided rule: a relation read of a protected, unpoliced table under required mode behaves like the direct read — it throws `RlsRequiredError` naming the child table — provided the filter is only invoked for relations the caller actually requested. If it is invoked eagerly for every edge, return the FALSE predicate for that table instead (the child loads empty) and say which you chose and why. Put the decision where the mode and table publicity are already known; do not thread new parameters through more than two call sites.
5. Build, test, types, eslint for `@lunora/server` and `@lunora/shard-engine` (and `@lunora/do` if you touched it).

## Scope

**In scope**: `packages/server/src/rls/middleware.ts`, `packages/shard-engine/src/rls-guard.ts`, the engine's relation resolver, and tests. **Out of scope**: `shape-read-base.ts` (plan 624); policy semantics for tables that do have a read policy; public tables.

## Git workflow

- Branch: `security/rls-shape-guards-intersect (same branch as plan 624, separate commit)`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(server): keep unpoliced relation children closed`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Done criteria

- [ ] Test from step 2 exists and passes; if a fix was needed, it was seen red without it
- [ ] `pnpm --filter "@lunora/server" run test`, `lint:types`, `lint:eslint` exit 0 (same for any other touched package)

## STOP conditions

- The fix would need a change to a public type in `@lunora/server` or `@lunora/shard-engine` (api snapshot diff): STOP and report the proposed signature.
- The same gap exists on the D1 writer (`packages/sql-store`) and cannot be closed by the same change: fix the shard path, STOP, and report the D1 gap with file:line.

## Maintenance notes

- Reviewer: run `pnpm run test:workerd` before merging.
