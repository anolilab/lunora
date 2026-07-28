# Plan 205 — Studio data-grid parity + URL state

- **Category**: dx/perf (competitive parity — Prisma Studio `table` view)
- **Priority**: P2
- **Effort**: M–L · **Risk**: LOW
- **Status**: TODO
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: close the remaining data-browser gaps vs Prisma Studio — user column
  pinning, search-match highlighting, typed search predicates, column
  virtualization, back-relation columns — and finish shareable URL state.

## Context (verified)

`packages/studio/src/features/data/` is the largest feature area in Studio
(~4.5k lines across 18 files) and is **ahead** of Prisma on several axes worth
naming, so they are protected as non-goals rather than churned: cascade preview
(`cascade-preview.tsx`), staged edits (`staged-edits.tsx`), row generation
(`generate-rows-dialog.tsx`), shard explorer (`shard-explorer.tsx`), facets
(`data-facets.tsx`), mask policies (`hooks/use-mask-policies.ts`), and export to
CSV / JSON / **SQL** (`grid-features.tsx:418` — Prisma exports CSV/JSON only).

Confirmed gaps:

| Gap                           | Evidence                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No user column pinning        | column 0 is hard-pinned (`data-browser-grid.tsx:747` `const pinned = colIndex === 0`, styled by `pinnedDataCellStyle:82`); `grid-features.tsx:222` offers visibility toggles but no pin |
| Rows virtualized, not columns | one `useVirtualizer` over rows (`data-browser-grid.tsx:929`); a wide table renders every column cell                                                                                    |
| No search-match highlight     | no `highlight` in the data feature; Prisma's spec makes a yellow match background mandatory                                                                                             |
| Substring search only         | server-side `search` on the browsed table; Prisma plans typed predicates (numeric/boolean/UUID equality, date-range at supplied precision) under a hard timeout                         |
| No back-relation columns      | FK traversal exists forward (`data-browser.tsx:66-69`, `onSelectTable` with a pre-filled search) but reverse relations are not surfaced as columns                                      |
| Partial URL state             | `initialSearch` / `initialFilters` / `initialOrderBy` / `onViewChange` (`data-browser.tsx:52-76`) hydrate a view, but not every control round-trips                                     |

Prisma's corresponding specs: `Architecture/table-query-controls.md`,
`full-table-search.md`, `wide-grid-performance.md`, `column-header.md`,
`navigation-url-state.md`.

## Phase 1 — Column pinning + header controls

- [ ] Replace the hard `colIndex === 0` pin with a pinned-column _set_, defaulting
      to the primary-key column (preserving today's behaviour) and extendable from
      a header menu — pin left / unpin, alongside the existing visibility toggle.
- [ ] Persist pins per table in Studio UI state so they survive navigation.
- [ ] Keep sticky offsets correct for multiple pinned columns during horizontal
      scroll (today's single-column `pinnedDataCellStyle` assumes offset 0).

## Phase 2 — Search that shows its work

- [ ] Highlight matched substrings in rendered cells (Prisma makes this
      mandatory, and it is the difference between "these rows matched" and
      "these rows matched _here_"). Highlighting is presentational only — it must
      not alter the masked-value path (`use-mask-policies.ts`); **a masked cell is
      never highlighted**, because a highlight on a mask leaks the match position.
- [ ] Typed predicates server-side in `readTablePage`'s search: when the term
      parses as a number / boolean / date (`YYYY[-MM[-DD]]`, and datetime at the
      supplied precision), add equality/range predicates alongside the substring
      match, instead of stringifying every column.
- [ ] Guardrails, ported from Prisma's operational rules: a hard statement
      timeout, one in-flight search per browser (abort the previous), a cap on the
      number of text predicates, and a distinct timeout error that says the search
      was expensive rather than a generic failure.
- [ ] Debounce URL writes (~350ms) and reset pagination on a new term.

## Phase 3 — Wide-table performance

- [ ] Horizontal virtualization alongside the existing row virtualizer, with the
      pinned set always rendered.
- [ ] Precompute the per-row display model once per page rather than per cell
      render; keep expensive cell affordances (detail dialog, copy) mounted on
      demand.
- [ ] A perf budget test in the existing studio unit project — render an N-column
      × M-row grid and assert a bounded number of mounted cells. Without an
      assertion this regresses the first time someone adds a cell feature.

## Phase 4 — Back-relation columns

- [ ] Surface reverse relations as virtual columns (count, or a peek at related
      rows) using the relation metadata `describeTables` already returns, with
      click-through reusing the existing forward-traversal path.
- [ ] Off by default per table; opt-in from the columns menu. Reverse relations
      can be expensive to resolve, and a default-on version would make every wide
      table slow to satisfy a feature most sessions do not use.

## Phase 5 — Finish URL state

- [ ] Every data-browser control round-trips through the URL: shard, table,
      search, filters, sort, page, pinned columns, hidden columns.
- [ ] Same treatment for the SQL view's active tab and the query-insights range
      selector (plan 203 Phase 4).
- [ ] One place owns the parse/serialize so a new control cannot half-implement
      it; a test asserts a round trip for the full control set.

## Exit criteria

- Pinning a second column keeps both frozen and correctly offset while scrolling
  a 60-column table horizontally.
- Searching `2026-07` on a table with a datetime column matches that month by
  range, not by string accident.
- A match is visibly highlighted in the cell that matched; a masked cell is not.
- A 200-column × 1000-row table scrolls smoothly, with the perf-budget test
  asserting the bounded mounted-cell count.
- Copying the URL after filtering, sorting, pinning, and paging reproduces the
  exact view in a fresh tab.
- No regression in the protected features listed above (cascade preview, staged
  edits, facets, masking, exports) — each keeps its existing tests green.

## Open decision — infinite scroll

Prisma uses windowed infinite scroll; we paginate (`grid-pagination.tsx`) and
have facets. **Do not port this by default.** Pagination gives a stable position,
an exact count, and predictable export semantics, which suit an admin tool;
infinite scroll suits browsing. Evaluate and record a decision at the end of
Phase 3 — if pagination stays, say so in the plan record so it is not re-raised
as a gap next time.

## Non-goals

- Reworking staged edits, cascade preview, generation, facets, masking, or the
  export menu — all are ahead of the comparison target.
- Adopting a different table library. `@tanstack/react-table` +
  `@tanstack/react-virtual` are already in place and sufficient for every phase.
