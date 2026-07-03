# Plan 105: Stop re-running the full-table COUNT(*) on every data-browser page change

> **Executor instructions**: Follow step by step; run each verify. STOP
> conditions halt you. Update `plans/README.md` when done unless a reviewer owns it.
>
> **Drift check (run first)**: `git diff --stat fc9c915b..HEAD -- packages/do/src/introspect.ts packages/studio/src/features/data`

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fc9c915b`, 2026-07-03

## Why this matters

The Studio data browser's page read (`readTablePage`) always issues a
`SELECT COUNT(*) … WHERE …` alongside the page `SELECT`. On the client, `offset`
is part of the live query args, so every "Next page" / "jump to page" / search
keystroke re-invokes `readTablePage` and recomputes the same `total` for an
unchanged predicate. Worse, the search predicate is an un-indexable
`CAST(col AS TEXT) LIKE` across all columns, so the COUNT is a full scan on the
DO's single thread. Paging through a large shard table re-scans the whole
(filtered) table per click for a number that only changes when the predicate
(table / shard / filters / search) changes.

## Current state

Server (`packages/do/src/introspect.ts:1008-1024`):
```ts
    const predicate = buildTablePredicate(columns, needle, options.filters);
    const order = buildOrderBy(options.orderBy, columns);
    const whereSql = predicate === undefined ? "" : ` WHERE ${predicate.where}`;
    const orderSql = order === undefined ? "" : ` ORDER BY ${order.sql}`;
    const whereParams = predicate?.parameters ?? [];
    const orderParams = order?.params ?? [];
    const total =
        predicate === undefined
            ? countRows(sql, quoted)
            : Number(sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quoted}${whereSql}`, ...whereParams).one().c);
    const rawRows = sql.exec(`SELECT * FROM ${quoted}${whereSql}${orderSql} LIMIT ? OFFSET ?`, ...whereParams, ...orderParams, limit, offset).toArray();
    return withReferences({ ...expandDocumentRows(columns, rawRows), total });
```

Client (`packages/studio/src/features/data/hooks/use-data-browser.tsx:308-325`):
```ts
    const pageArgs = useMemo<Record<string, unknown>>(() => ({
        filters: toFilterClauses(filters),
        limit: pageSize,
        offset,                                   // <-- offset is part of the args
        orderBy: toOrderBy(sorting),
        search,
        table: selectedTable ?? "",
    }), [filters, pageSize, offset, sorting, search, selectedTable]);
    const pageQuery = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, pageArgs, {
        enabled: selectedTable !== null,
        keepPreviousData: false,
        // … live: true (the page read streams writes in)
    });
```

The read is `live` — a write into the table pushes a re-run, so a cached count
must be invalidated when the predicate's rows change. The admin query key is
`["lunora-admin", path, args, shardKey]` (`use-admin-query.ts:17`), and TanStack
hashes the args deeply.

## Preferred approach

**Server `skipCount` flag + client predicate-keyed count cache.** This keeps
correctness (live invalidation) while removing the per-offset recompute:

1. Add an optional `skipCount?: boolean` arg to `readTablePage`. When true, it
   returns rows without running the COUNT (e.g. `total: undefined`).
2. On the client, split the total off the page read. Fetch the count via a
   **separate** admin query whose args are the predicate **without** `offset`
   (`{ table, shard, filters, search }`), so paging (offset-only change) does not
   re-key it. Because it is a separate `live` query on the predicate key, a write
   into the matching rows invalidates it correctly. The page read then passes
   `skipCount: true`.

This is more moving parts but is the correct design. A simpler alternative
(client-only count memo) is possible but harder to invalidate on live writes
because the count would ride the same live channel as the page — the separate
live query is cleaner.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Build do (deps) | `pnpm --filter "@lunora/do..." run build` | exit 0 |
| Typecheck do | `pnpm --filter "@lunora/do" run lint:types` | exit 0 |
| Test do | `pnpm --filter "@lunora/do" run test -- introspect` | all pass |
| Typecheck studio | `pnpm --filter "@lunora/studio" run lint:types` | exit 0 |

**Do NOT run the studio Vitest suite** — jsdom component tests SIGTERM/hang in
this sandbox (see the repo memory). Verify studio changes with `lint:types` +
`lint:eslint` only.

## Scope

**In scope**:
- `packages/do/src/introspect.ts` — `readTablePage` gains `skipCount` and skips
  the COUNT when set; the admin RPC arg schema for `readTablePage` (find where its
  args are validated — grep for `readTablePage` in `packages/do/src` and the admin
  route wiring) must accept the new optional field.
- `packages/studio/src/features/data/hooks/use-data-browser.tsx` — split the count
  into a separate predicate-keyed live query; pass `skipCount: true` on the page
  read; feed `total` from the count query.
- Wherever `TablePage`'s `total` type lives (may become `number | undefined`) and
  its consumers in the data feature.

**Out of scope**:
- Changing the search predicate from `CAST … LIKE` to something indexable — that
  is a separate, larger change (would need FTS or per-column typed search). Note
  it as a follow-up.
- Any other admin read.
- The `keepPreviousData: false` decision (documented, identity-aware — leave it).

## Git workflow

- Branch: `advisor/105-data-browser-count-cache`
- Commit(s): `perf(do): let readTablePage skip the COUNT` + `perf(studio): key the row-count query off the predicate, not the offset` (two logical units).
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Server — `skipCount`

Add `skipCount?: boolean` to `readTablePage`'s options and its arg validator.
When `skipCount === true`, do not run the COUNT; return the page with
`total: undefined` (or omit it — pick one and type it consistently). All existing
callers (that don't pass `skipCount`) keep today's behavior (COUNT runs).

**Verify**: `pnpm --filter "@lunora/do" run test -- introspect` → existing tests
pass; add a test that `skipCount: true` returns rows and no COUNT was executed
(assert `total` is `undefined`/absent; if the test harness can count SQL calls,
assert the COUNT query wasn't issued).

### Step 2: Client — separate predicate-keyed count query

In `use-data-browser.tsx`:
- Build `countArgs` = `pageArgs` **without** `offset` (and without `limit` if the
  count ignores it — it does). Memoize on `[filters, sorting?, search,
  selectedTable]` (drop `offset`, `pageSize`).
- Add a second `useAdminQuery<{ total: number }>(ADMIN_FUNCTIONS.readTableCount
  ?? readTablePage-with-count, countArgs, { enabled, live: true, shardKey })`.
  Prefer reusing `readTablePage` with `skipCount: false` + `limit: 0`/`offset: 0`
  purely for the count IF that returns the total cheaply; otherwise consider a
  dedicated `readTableCount` admin fn. Reusing `readTablePage` avoids a new admin
  route — but confirm `limit: 0` returns a valid count and empty rows. If a
  dedicated count fn is cleaner, that is acceptable but expands scope to the admin
  route registry.
- Make the page query pass `skipCount: true` and read `total` from the count
  query instead of the page result.

**Verify**: `pnpm --filter "@lunora/studio" run lint:types` → exit 0;
`pnpm --filter "@lunora/studio" run lint:eslint` → exit 0.

### Step 3: Confirm live invalidation still holds

Reason through (and note in the PR description): a write into a row matching the
predicate pushes a re-run on the count query's live key (same predicate), so the
total updates; paging changes only `offset`, which is not in the count key, so no
COUNT re-runs on page navigation. Filters/search/table/shard changes re-key the
count query, so it refetches — correct.

**Verify**: `pnpm --filter "@lunora/do" run test -- introspect` → all pass.

## Test plan

- Server: in the introspect test file, add:
  - `skipCount: true` → page rows returned, `total` undefined/absent, COUNT not run.
  - default (no `skipCount`) → `total` present (regression — unchanged behavior).
- Client: no runnable jsdom test in this sandbox. Instead, verify via
  `lint:types` that the count query and page query type-check, and manually
  reason about the invalidation (documented in the PR). If a non-jsdom unit test
  of the arg-building (`countArgs` excludes `offset`) is extractable as a pure
  function, add it.
- Verification: `pnpm --filter "@lunora/do" run test -- introspect` → all pass;
  studio `lint:types` + `lint:eslint` exit 0.

## Done criteria

- [ ] `readTablePage` accepts `skipCount` and skips the COUNT when set; existing behavior unchanged when unset.
- [ ] The data browser fetches the total via a query keyed on the predicate (no `offset`), so page navigation issues no COUNT.
- [ ] Live writes still update the displayed total (reasoned + documented).
- [ ] `pnpm --filter "@lunora/do" run test -- introspect` passes with new `skipCount` cases; `pnpm --filter "@lunora/do" run lint:types` exits 0.
- [ ] `pnpm --filter "@lunora/studio" run lint:types` + `run lint:eslint` exit 0. (Studio Vitest NOT run — sandbox hang.)
- [ ] `git status` shows only in-scope files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Reusing `readTablePage` with `limit: 0` for the count does NOT return a correct
  total (e.g. the count is computed from returned rows, not a COUNT query) — then
  a dedicated count path is needed; if that expands into new admin-route
  registration you're unsure about, STOP and report the options.
- You cannot convince yourself the separate count query invalidates on live
  writes correctly — STOP; a wrong total that silently drifts is worse than the
  redundant COUNT. Report the concern.
- The studio data feature's `total` is consumed in a way (pagination math) that
  breaks when it is transiently `undefined` (during the count query's first load)
  — handle the loading state (fall back to the current page's row count or a
  skeleton) rather than shipping a broken paginator.

## Maintenance notes

- Follow-up (deferred, noted): the `CAST(col AS TEXT) LIKE` all-columns search is
  inherently unindexable; a real fix is FTS or typed per-column search. Out of
  scope here — this plan only removes the redundant re-COUNT, not the scan cost of
  a single count.
- A reviewer should scrutinize the live-invalidation reasoning most — that is the
  correctness risk. Confirm the count query's key excludes `offset`/`pageSize` but
  includes every predicate input (table, shard, filters, search).
