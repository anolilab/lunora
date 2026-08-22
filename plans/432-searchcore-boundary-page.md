# Plan 432: Refuse the search page that lands exactly on the scan cap instead of faking `isDone`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Your reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 207be1b63..HEAD -- packages/search-core/src/query.ts packages/search-core/__tests__`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `207be1b63`, 2026-08-21

## Why this matters

`planSearchPage`'s docblock promises to refuse paging past `MAX_SEARCH_SCAN` (1024) "rather than quietly reporting `isDone` at the cap, which would read as 'no more matches' when the truth is 'no more reachable'". The boundary case does exactly the forbidden thing: a page with `offset + numItems === 1024` passes the `>` check, `searchPageScan` clamps the fetch to 1024 (discarding the probe row that makes `hasMore` an observation), and `finishSearchPage` computes `window.length > end` = `1024 > 1024` = `false` → `isDone: true`. A client paging a >1024-match corpus sees a clean "done" on the last reachable page instead of the `BAD_REQUEST` telling it to narrow the query.

The trade-off, stated honestly: after the fix, an exact-boundary request over a corpus with ≤1024 matches — which today returns a correct final page — gets the refusal instead. That matches the module's already-documented posture (a paging client with a 1008-match corpus already gets refused at `offset 1008 + 24 > 1024` today); the boundary page simply joins the same rule, because without the probe row it cannot answer `hasMore` truthfully.

## Current state

- `packages/search-core/src/query.ts:360-366` (inside `planSearchPage`):
    ```ts
    if (offset + numberItems > MAX_SEARCH_SCAN) {
        throw new LunoraError(
            "BAD_REQUEST",
            `search pagination reaches past the ${String(MAX_SEARCH_SCAN)}-document limit (offset ${String(offset)} + ${String(numberItems)} requested) — narrow the query or the filters instead`,
        );
    }
    ```
- `:298` — `export const searchPageScan = (plan) => Math.min(plan.offset + plan.numItems + 1, MAX_SEARCH_SCAN);`
- `:377-378` (inside `finishSearchPage`) — `const end = plan.offset + plan.numItems; const hasMore = plan.numItems > 0 && window.length > end;`
- The module is **internal and bundled** into `@lunora/server`, `@lunora/do`, and `@lunora/sql-store` (devDependency + inline pattern), so consumer test suites in those packages may assert pagination behavior.

## Commands you will need

| Purpose        | Command                                                                                       | Expected on success                                |
| -------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Install        | `pnpm install`                                                                                | exit 0                                             |
| Tests          | `pnpm --filter "@lunora/search-core" run test`                                                | all pass                                           |
| Consumer tests | `pnpm --filter "@lunora/shard-engine" run test && pnpm --filter "@lunora/sql-store" run test` | all pass (both embed the shared search core paths) |
| Typecheck      | `pnpm --filter "@lunora/search-core" run lint:types`                                          | exit 0                                             |
| Lint           | `pnpm --filter "@lunora/search-core" run lint:eslint`                                         | exit 0                                             |

## Scope

**In scope**:

- `packages/search-core/src/query.ts` — the `planSearchPage` guard (one operator + message) and its docblock
- `packages/search-core/__tests__/` — the pagination test file (find it: `grep -rln "planSearchPage" packages/search-core/__tests__`)

**Out of scope**:

- `searchPageScan` / `finishSearchPage` — unchanged; once the boundary request is refused, the clamp can only trim the probe row in the already-answered case (its docblock says exactly this and becomes true again).
- `assertSearchWithinCap` (the `.collect()` guard) — separate, correct path.
- Consumer packages' code.

## Git workflow

- Branch: `improve/wave22-search-core`
- Commit: `fix(search-core): refuse the page ending at the scan cap`

## Steps

### Step 1: Flip the guard

Change `>` to `>=` in the `planSearchPage` cap check, and extend the error message to say the page must end **below** the cap so `hasMore` stays observable (keep the existing "narrow the query" guidance). Update the function docblock's cap sentence to match. Exception to preserve: `numberItems === 0` with `offset === MAX_SEARCH_SCAN`? — a zero-length page at the cap is degenerate; `>=` refuses it too, which is fine (a zero-item page is already terminal by construction), but confirm no test relies on it.

**Verify**: `pnpm --filter "@lunora/search-core" run test` → the existing exact-boundary expectation (if any) fails or none exists; adjust per Step 2.

### Step 2: Tests

In the pagination suite:

- `planSearchPage({ cursor: <encodes 1000>, numItems: 24 })` throws `BAD_REQUEST` (the exact-cap case).
- `planSearchPage({ cursor: <encodes 999>, numItems: 24 })` still resolves (1023 < 1024; probe row fits: `searchPageScan` = 1024).
- If an existing test asserted `isDone: true` at the boundary, it encoded the bug — rewrite it to expect the throw and say so in the commit body.

**Verify**: `pnpm --filter "@lunora/search-core" run test` → all pass.

### Step 3: Consumer sweep

Run the shard-engine and sql-store suites; grep both packages' tests for `MAX_SEARCH_SCAN`/`1024` pagination assertions and update any that encoded the boundary behavior (`grep -rn "1024" packages/shard-engine/__tests__ packages/sql-store/__tests__ | grep -i search`).

**Verify**: both consumer suites exit 0.

## Test plan

- The two `planSearchPage` cases above plus one `finishSearchPage` sanity case (window shorter than `end` → `isDone: true` still works for a genuinely-ended corpus). Model on the existing cursor/paging tests in the same file.

## Done criteria

- [ ] `planSearchPage` refuses `offset + numItems >= MAX_SEARCH_SCAN` (test-asserted)
- [ ] search-core, shard-engine, sql-store suites all exit 0
- [ ] `lint:types` + `lint:eslint` exit 0 on search-core
- [ ] Docblock updated; no files outside the in-scope list modified

## STOP conditions

- The "Current state" excerpts don't match.
- A consumer test failure reveals a client-visible contract (e.g. a golden fixture in `@lunora/codegen` or a documented REST shape) that depends on the boundary page succeeding — report before changing anything outside search-core.

## Maintenance notes

- This is a breaking narrowing on alpha (a previously-succeeding request now 400s); the commit body must record it for semantic-release.
- If a `cappedAtScan` flag on `SearchPage` is ever wanted (to return the page AND signal the cap), that is a wire-shape change — deferred deliberately.
