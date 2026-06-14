# Plan 026: Datasette-style faceting + shareable canned queries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Two independent items (see "Item breakdown"); each
> is its own PR. When an item is done, update its checkbox and the status row for
> this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 05a1e9fc..HEAD -- packages/studio/src/features/data packages/studio/src/lib/admin.ts packages/do/src/introspect.ts packages/studio/src/app/studio.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (cheap, high-polish data-exploration win)
- **Effort**: M (one bind-safe read-only worker op + a facet sidebar; plus a
  studio-only URL/saved-query layer)
- **Risk**: LOW. Faceting is a new **read-only** introspection op (`GROUP BY` with
  bound params, mirroring the existing `readTablePage` builder); canned queries are
  pure studio state (URL search params + localStorage). No writes, no schema
  change, no auth change.
- **Depends on**: none. Builds directly on the existing data browser
  (`readTablePage`, `FilterClause`).
- **Category**: feature / borrow (Datasette)
- **Planned at**: commit `05a1e9fc`, 2026-06-15

## Verdict on the borrow

**Source**: Datasette (Apache-2.0 — **copy-eligible**). Datasette's two signature
data-exploration affordances are **facets** (per-column value/count summaries you
click to filter) and **canned/shareable queries** (every view is a URL; named
saved queries). Apache-2.0 permits literal copying, but there is no Python code to
vendor into a TS studio — we re-implement the _UX_ (facet sidebar, click-to-filter,
shareable-URL state, saved queries) against Cirrus's own data layer. So: borrow
the idea + UX, build native.

## Why this matters

The data browser (`packages/studio/src/features/data/`) already has filtering
(eq/ne/lt/lte/gt/gte/contains), full-text search, ordering, and offset
pagination — but **no aggregate/group-by/distinct capability anywhere** (grep
confirms: no `GROUP BY`/`COUNT(*)`/facet in `packages/do` or the studio). And the
data-browser state (filters, search, order, shard) is **ephemeral** — only `?table=`
and `?schema=` live in the URL today, so a view can't be shared or saved. Faceting
turns "what values does `status` actually have?" from a guess into one glance;
shareable canned queries turn "here's the bug, filter `status=error` on shard X"
into a link. Both are low-risk, high-polish wins that make the browser feel like a
real data tool.

## Design decisions (already scoped)

- **Faceting = one new bind-safe read op.** `__cirrus_admin__:facetColumn`
  (table + column [+ the active filters/search so facets reflect the current view])
  → `[{ value, count }]` via `SELECT column, COUNT(*) … GROUP BY column ORDER BY
count DESC LIMIT N`. Built with the **same bound-parameter SQL builder** as
  `readTablePage` (`packages/do/src/introspect.ts`) — never string-interpolate the
  column name; validate it against the table's known columns (the builder already
  knows them). Read-only; bearer-gated like every admin op.
- **Click-to-filter reuses `FilterClause`.** Clicking a facet value adds an `eq`
  `FilterClause` for that column/value — no new filter machinery.
- **Canned/shareable queries = studio state only.** Serialize the data-browser
  view (table, tier, shard, filters, search, orderBy) into TanStack Router search
  params so the URL _is_ the shareable query. Saved/named queries persist in
  `localStorage`, mirroring `lib/shard-history.ts`'s `sessionStorage` helper
  (use `localStorage` so saved queries survive a restart). No worker involvement.
- **Facets are opt-in per column.** Don't auto-facet every column (cost on wide
  tables); the user toggles a column into the facet sidebar (Datasette's model).
- **Bounded + honest.** Facet results are capped (e.g. top 30 values) and the UI
  says so when truncated — no silent caps (repo convention).

## Current state

### Data browser + filters

`packages/studio/src/features/data/` — `data-browser.tsx`, `data-filters.tsx`
(`EditableFilter = { column, operator, value }`, `FilterOperator = "eq" | "ne" |
"lt" | "lte" | "gt" | "gte" | "contains"` at lines 14–22; `toFilterClauses`
converter at lines 30–37), `hooks/use-data-browser.tsx` (all reads/writes),
`table-editor.tsx` (tier router), `table-list-sidebar.tsx`.

`hooks/use-data-browser.tsx` — page fetch (lines 271–282) via
`client.query(READ_TABLE_PAGE, { table, offset, limit, search, filters, orderBy,
refs }, callOptions(shardKey))`; live channel via `useLiveAdmin(...)` (lines
308–327); shard debounced 400ms (line ~195).

### Admin RPC + response shapes

`packages/studio/src/lib/admin.ts` — `ADMIN_FUNCTIONS.readTablePage =
"__cirrus_admin__:readTablePage"` (line ~46), `listTables` (line ~45),
`describeTable(s)`. `TablePage = { columns: string[]; rows: Record<string,
unknown>[]; total: number; refs?: Record<string,string> }`. `FilterClause =
{ column, operator, value? }` (bound server-side — "never injects SQL").

`packages/do/src/introspect.ts` — `ReadTablePageOptions` (lines ~571–606):
`{ table, filters?, search?, offset?, limit?, orderBy?, refs? }`; the server-side
SQL builder windows + counts with bound params. **This is the file the new
`facetColumn` op and its SQL builder go in** — reuse the existing WHERE/filter
compilation so facets honour the active filters.

### URL routing + persistence

`table-editor.tsx` (lines 78–80) — TanStack Router; `useSearch({ strict: false })`
reads `search["schema"]` (tier) and `search["table"]`. `navigate({ search: { …,
table }, to: "/data" })` pushes table selection — **so search-param state is
already the studio's shareable mechanism; extend it with filter/search/order/shard.**
`app/studio.tsx` (lines ~839–851) — router setup; `basePath` from
`window.__CIRRUS_BASE_PATH__`.

`packages/studio/src/lib/shard-history.ts` — `loadRecentShards()` /
`recordShard(shardKey)` persist a max-10 MRU list in `sessionStorage` under
`"cirrus-studio-recent-shards"`, degrading gracefully when storage is
unavailable. **This is the exact pattern to copy for a `saved-queries.ts` helper
(localStorage).**

### Locale convention

`packages/studio/src/locales/en.ts` — English strings as ids, `{braces}` for
params (e.g. `"Showing the first {max} of {count} rows."`). No facet/aggregate
strings exist yet.

## Commands you will need

| Purpose      | Command                                             | Expected |
| ------------ | --------------------------------------------------- | -------- |
| Build deps   | `pnpm run build:packages`                           | exit 0   |
| do build     | `pnpm --filter "@cirrus/do..." run build`           | exit 0   |
| do tests     | `pnpm --filter "@cirrus/do" run test -- introspect` | pass\*   |
| studio build | `pnpm --filter "@cirrus/studio..." run build`       | exit 0   |
| studio tests | `pnpm --filter "@cirrus/studio" run test -- data`   | all pass |
| studio types | `pnpm --filter "@cirrus/studio" run lint:types`     | exit 0   |
| eslint       | `pnpm --filter "@cirrus/studio" run lint:eslint`    | exit 0   |

\* The DO's workerd integration tests cannot run in the sandbox (connect
timeouts). Verify the `facetColumn` SQL builder with a **plain-Node unit test** of
the builder function (mirror however `readTablePage`'s builder is unit-tested), and
verify the column-name validation rejects unknown columns. Do not rely on a
workerd run.

## Scope

**In scope**:

- `packages/do/src/introspect.ts` — add `facetColumn` admin op + its bound-param
  `GROUP BY` SQL builder, reusing the existing filter/WHERE compilation and the
  table's known-column validation. (Item 1)
- `packages/studio/src/lib/admin.ts` — add `ADMIN_FUNCTIONS.facetColumn` + the
  result type `{ value: unknown; count: number }[]` (+ a `truncated` flag). (Item 1)
- `packages/studio/src/features/data/` — facet sidebar + click-to-filter; serialize
  view state to URL search params; a saved-queries panel. (Items 1–2)
- `packages/studio/src/lib/saved-queries.ts` — localStorage helper (mirror
  `shard-history.ts`). (Item 2)
- `packages/studio/src/locales/en.ts` — new strings.
- Tests alongside each.

**Out of scope** (do NOT touch):

- Any write path / schema change / auth change.
- The `global-data-browser` (D1 tier) faceting — Item 1 targets the shard tier
  first; D1 facets are a follow-up, noted but not built.
- Adding facets to columns automatically (opt-in only).
- String-interpolating a column name into SQL — column must be validated against
  the table's columns and bound/whitelisted, never concatenated.

## Git workflow

- One branch per item, e.g. `feat/data-faceting`, `feat/canned-queries`.
- Conventional commits, e.g. `feat(do): add facetColumn admin op` /
  `feat(studio): shareable data-browser queries`.
- Do NOT push or open a PR unless the operator instructed it.

## Item breakdown

- [ ] **Item 1 — Faceting.** Add the `facetColumn` read-only admin op (DO
      introspect, bound params, reuses the active filters/search so facets reflect the
      current view, validates the column against known columns, caps at top-N with a
      `truncated` flag). Add the studio admin-function entry + result type. Add a facet
      sidebar to the shard data browser: the user toggles a column to facet, sees
      value/count rows, and clicks a value to add an `eq` `FilterClause`. **Tests**:
      DO builder unit test (correct `GROUP BY` SQL, bound params, unknown-column
      rejected, cap applied); studio test that a mocked facet result renders and a
      click adds the filter.
- [ ] **Item 2 — Shareable canned queries.** Serialize the data-browser view
      (table, tier, shard, filters, search, orderBy) into TanStack Router search params
      so the URL is the shareable query; hydrate state from the URL on load (so a
      pasted link reconstructs the view). Add a "Copy link" affordance and a
      saved-queries panel backed by a new `lib/saved-queries.ts` localStorage helper
      (name + serialized state; mirror `shard-history.ts`). **Tests**: round-trip
      serialize→URL→hydrate reproduces the view; saved-queries helper persists/loads/
      dedupes and degrades when storage is unavailable.

## Steps (Item 1 — do this first, in full)

### Step 1.1: DO facet op + SQL builder

In `packages/do/src/introspect.ts`, add a `facetColumn` constant alongside
`readTablePage`, and a builder that produces (with bound params):

```sql
SELECT "<col>" AS value, COUNT(*) AS count
FROM "<table>"
<the same WHERE the active filters/search compile to>
GROUP BY "<col>"
ORDER BY count DESC
LIMIT <N + 1>   -- fetch one extra to detect truncation
```

- Validate `column` against the table's known columns (the builder already has
  them for `readTablePage`); reject unknown → typed error, never interpolate.
- The table name is already validated/quoted the same way `readTablePage` does it
  — reuse that, do not invent a new path.
- Return `{ values: { value, count }[]; truncated: boolean }` (drop the extra row;
  set `truncated` if it existed).

Wire it into the read-only admin dispatch next to `readTablePage`/`describeTable`
in `shard-do.ts` (`handleAdminRpc` / `readAdminOp`).

**Verify**: a plain-Node unit test of the builder — correct SQL string + bound
params for a filtered facet; unknown column rejected; `LIMIT N+1`→`truncated`
logic. (`pnpm --filter "@cirrus/do" run test -- introspect`; do NOT depend on a
workerd run.)

### Step 1.2: Studio admin entry + result type

In `packages/studio/src/lib/admin.ts`, add `facetColumn:
"__cirrus_admin__:facetColumn"` and `interface FacetResult { values: { value:
unknown; count: number }[]; truncated: boolean }`.

### Step 1.3: Facet sidebar

In `features/data/`, add a facet panel: a per-column toggle (from the page's
`columns`) that, when on, fetches `facetColumn` for that column with the **current**
filters/search/shard (so facets track the view) and renders value/count rows.
Clicking a value appends an `eq` `EditableFilter`/`FilterClause` (reuse
`data-filters.tsx`). Show "top {n} values" + a truncated note when `truncated`.
Mirror the existing live-fetch pattern (`callOptions(shardKey)`).

**Verify**:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run lint:types` → exit 0

### Step 1.4: Locale + tests

Add facet strings to `en.ts` (`"Facets"`, `"Top {n} values"`, `"Showing the {n}
most common values."`, etc.). Studio test: a mocked `facetColumn` result renders
value/count rows; clicking a value adds the `eq` filter to the query args.

**Verify**: `pnpm --filter "@cirrus/studio" run test -- data` → pass.

### Step 1.5: Full gate (Item 1)

**Verify** all of:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/do" run test -- introspect` → pass (builder unit test)
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run test -- data` → pass
- `pnpm --filter "@cirrus/studio" run lint:types` + `lint:eslint` → exit 0
- `git grep -n "facetColumn" packages/do/src packages/studio/src` shows the op
  threaded DO → studio.

## Test plan

- **Item 1**: DO builder unit test (SQL shape, bound params, unknown-column
  rejection, `truncated`); studio facet render + click-to-filter.
- **Item 2**: view-state serialize→URL→hydrate round-trip; `saved-queries`
  persist/load/dedupe + graceful degrade.

## Done criteria

Machine-checkable. ALL must hold when complete (per-item subsets gate each PR):

- [ ] `pnpm run build:packages` exits 0
- [ ] `pnpm --filter "@cirrus/do" run test -- introspect` exits 0 (builder unit
      test; not a workerd run)
- [ ] `pnpm --filter "@cirrus/studio..." run build` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run test -- data` exits 0
- [ ] `pnpm --filter "@cirrus/studio" run lint:types` + `lint:eslint` exit 0
- [ ] `git grep -n "facetColumn" packages/do/src packages/studio/src` shows it
      threaded DO → studio
- [ ] No write/schema/auth change:
      `git grep -n "ALTER TABLE\|CREATE TABLE\|INSERT INTO\|UPDATE \|DELETE FROM" packages/do/src/introspect.ts`
      shows no new mutating SQL from this plan (facet is `SELECT … GROUP BY` only)
- [ ] `plans/README.md` status row for 026 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match the live code (drift since
  `05a1e9fc`) — especially `ReadTablePageOptions` / the filter-WHERE builder shape,
  since `facetColumn` reuses it.
- The facet builder cannot reuse the existing column validation / WHERE
  compilation and would require a separate, hand-rolled SQL path with its own
  quoting — STOP rather than introduce a second SQL-building code path that could
  diverge on escaping.
- A column name would reach SQL without validation/binding — STOP; that's an
  injection surface.
- Serializing view state to the URL would break the existing `?table=`/`?schema=`
  contract or the router's basepath handling — STOP and report.

## Maintenance notes

- Facets reuse `readTablePage`'s WHERE compilation on purpose — if that builder
  changes (new operators, new escaping), the facet op inherits it. Keep them on the
  one shared path; never fork the SQL builder.
- `saved-queries.ts` mirrors `shard-history.ts` but uses `localStorage` (survive
  restart) vs `sessionStorage`. Keep the graceful-degrade behaviour identical.
- D1 (`global`) tier faceting is intentionally deferred — the shard tier proves the
  UX first. When added, route through the D1 adapter's read path, not the DO op.
- Datasette is Apache-2.0 (copy-eligible) but nothing is literally vendored — the
  facet/canned-query UX is re-implemented in TS. Keep that note for provenance.
