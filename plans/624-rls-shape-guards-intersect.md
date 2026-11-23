# Plan 624: A shape with several `rls()` guards intersects them, like a query chain does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f3a9ccf45..HEAD -- packages/server/src/rls/shape-read-base.ts packages/server/src/rls/middleware.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

**Baseline:** `f3a9ccf45` (`origin/alpha`, 2026-11-20)
**Status:** DONE, pushed: `security/rls-shape-guards-intersect` (workerd: all 23). Breaking for shapes that relied on a second guard to broaden; PR #1637

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Platform parity**: not applicable — no `ctx.*` surface, binding or capability is added or changed.

## Why this matters

Row-level security read policies are evaluated in two places. On a query chain, each `.use(rls(...))` step is an extra restriction: the per-step predicates are ANDed. On a shape (`defineShape({ use: [guardA, guardB] })`, the replication path), the per-guard predicates are ORed, and a single guard that grants unrestricted access makes the whole table unrestricted. So the same two guards that narrow a query to "rows of my tenant AND rows I own" replicate "every row" through a shape when one of them is an allow-all policy for that table. Replication then leaks rows the query path hides.

## Current state

`packages/server/src/rls/middleware.ts` (query path), the across-step rule and its helper:

```ts
/** AND together the per-step read bases of one table; `undefined` when no step contributed a predicate. */
const intersectBaseWheres = (predicates: WhereInput[]): undefined | WhereInput => {
    if (predicates.length === 0) {
        return undefined;
    }

    return predicates.length === 1 ? predicates[0] : { AND: predicates };
};
```

and inside `readBase` (~line 936): a step with no read policy for the table is skipped; a step whose `computeReadBaseWhere` returns `undefined` (unrestricted) contributes no predicate; every other step's predicate (including the FALSE sentinel for a deny) is pushed and the list is ANDed. Its doc comment says: "Across steps they AND: each `.use(rls(...))` is an additional restriction the request has to satisfy, exactly like stacking two `WHERE` clauses."

`packages/server/src/rls/shape-read-base.ts` (shape path), `resolveReadBaseWhere` (~line 211):

```ts
/** Resolve the table's read base-where (or the fail-closed sentinel), or `undefined` when unrestricted. */
const resolveReadBaseWhere = (registry: RlsReadRegistry, request: ShapeReadWhereRequest): undefined | WhereInput => {
    const groups = registry.byTable.get(request.table);

    if (!groups || groups.length === 0) {
        // No read policy for this table. Under `.rls("required")` a non-public
        // table is denied (secure-by-default, matching `guardWriter`); otherwise
        // it is unrestricted.
        return request.rlsRequired && !request.tablePublic ? FALSE_PREDICATE : undefined;
    }

    const predicates: WhereInput[] = [];

    // Each group carries one rls() middleware's read policies and its OWN
    // role→permission map; OR the grants across groups — the same broadening
    // semantics `computeReadBaseWhere` applies to policies within one middleware.
    for (const group of groups) {
        const base = evaluateGroupBaseWhere(group, request);

        // A group granting unrestricted access makes the whole table unrestricted.
        if (base === undefined) {
            return undefined;
        }

        // A group that denies (all its policies abstained/denied) can't broaden
        // access — another group may still grant, so skip it rather than fail.
        if (isFalsePredicate(base)) {
            continue;
        }

        predicates.push(base);
    }

    // Every group denied/abstained: fail closed (never reveal the whole table).
    if (predicates.length === 0) {
        return FALSE_PREDICATE;
    }

    return predicates.length === 1 ? predicates[0] : { OR: predicates };
};
```

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

| Purpose                       | Command                                                           | Expected on success |
| ----------------------------- | ----------------------------------------------------------------- | ------------------- |
| Install (fresh worktree only) | `pnpm install --frozen-lockfile`                                  | exit 0              |
| Build package + its deps      | `pnpm --filter "@lunora/server..." run build`                     | exit 0              |
| One test file                 | `pnpm --filter "@lunora/server" exec vitest run __tests__/<file>` | all pass            |
| Package tests                 | `pnpm --filter "@lunora/server" run test`                         | all pass            |
| Types                         | `pnpm --filter "@lunora/server" run lint:types`                   | exit 0              |
| ESLint                        | `pnpm --filter "@lunora/server" run lint:eslint`                  | exit 0, 0 warnings  |

## Design (decided)

Make `resolveReadBaseWhere` combine groups exactly as `readBase` combines steps:

- a group whose base is `undefined` (unrestricted) contributes **no predicate** — it no longer short-circuits the whole table to unrestricted;
- a group whose base is the FALSE sentinel **denies**: return `FALSE_PREDICATE` at once (an AND with false is false);
- otherwise push the predicate;
- no predicates left ⇒ `undefined` (every guard allowed everything); one ⇒ that predicate; several ⇒ `{ AND: predicates }`.

The no-groups branch (`rlsRequired && !tablePublic ? FALSE_PREDICATE : undefined`) is unchanged. Rewrite the comments in that function and the registry doc comment below it so they state the AND rule and why (parity with the query chain); delete the "OR the grants across groups" wording. Do not export or import `intersectBaseWheres` across the two files unless both already share a module — a three-line local combine is fine.

## Scope

**In scope**: `packages/server/src/rls/shape-read-base.ts`; its tests under `packages/server/__tests__/` (find with `rg -ln "shape-read-base|resolveShapeReadBaseWhere|buildRlsReadRegistry" packages/server/__tests__ packages/*/__tests__`); any docs that state the OR rule (`rg -n "rls" packages/server/docs apps/docs --glob '*.mdx' | rg -i "shape|replicat"`).

**Out of scope**: `middleware.ts` behaviour; `computeReadBaseWhere` (within one guard, policies still OR); codegen; `@lunora/do`.

## Git workflow

- Branch: `security/rls-shape-guards-intersect`, cut from `origin/alpha` (if a reviewer already put you on a branch in a worktree, stay on it).
- Conventional commits, enforced by a commit-msg hook. Allowed types only: `build chore ci deps docs feat fix perf refactor revert security style test translation`. Format `<type>(<scope>): <subject>`, subject imperative, lowercase, no trailing period, under ~50 chars; body lines wrap at 100. Use: `security(server): intersect rls guards on a shape`. Note any behaviour break in the commit body.
- Stage explicit paths. Never `--no-verify`. Do NOT push or open a PR.

## Steps

1. Find the existing shape tests and any that pin the OR behaviour. **Verify**: package tests pass before any change.
2. Add tests first (see Test plan). **Verify**: the new tests fail.
3. Apply the Design. **Verify**: new tests pass; update any test that pinned OR-across-guards and list each one in your report.
4. Docs/comments. **Verify**: `rg -n "OR the grants across groups" packages/server` → no matches.
5. Build, test, types, eslint for `@lunora/server`; then build + test every package whose tests import the shape registry (step 1's `rg`).

## Test plan

In the existing shape read-base test file, add: (a) two guards on one table, one allow-all and one `{ tenantId: ... }` → result is the tenant predicate, not `undefined`; (b) two restricting guards → `{ AND: [a, b] }`; (c) one guard denies (all its policies abstain) and one grants → FALSE sentinel; (d) both allow-all → `undefined`; (e) a single guard is unchanged. Red check: revert the source change, confirm (a), (b), (c) fail.

## Done criteria

- [ ] New tests pass and were seen red without the fix
- [ ] `pnpm --filter "@lunora/server" run test`, `lint:types`, `lint:eslint` exit 0
- [ ] No comment or doc still describes OR across guards for shapes

## STOP conditions

- An ADR or decision doc (`rg -il "shape" docs/adr docs/decisions plans/*.md 2>/dev/null | head`) records OR-across-guards for shapes as a deliberate decision: STOP and report the file.
- The groups in the registry do not correspond to separate `rls()` guards (for example policies from one guard are split into several groups): STOP — the AND would then change single-guard behaviour.

## Maintenance notes

- This is a behaviour break for apps that relied on a second guard to broaden a shape. Say so in the commit body.
- Reviewer: run `pnpm run test:workerd` before merging.
