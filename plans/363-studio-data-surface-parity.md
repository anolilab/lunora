# Plan 363 — Close nine gaps in the Studio's data/SQL surface

**Baseline:** `9a0b5263a` (2026-08-18)
**Status:** IN PROGRESS — W1, W3, W6, W7, W8 shipped; W2, W4, W9, W10 open; W5 spun out to [364](364-studio-conversational-assistant.md)

## 0. Headline finding

**A Studio dashboard cannot draw anything but a bar chart, and there is no way
for an operator to ask for a different one.** `dashboards-panel.tsx:126` renders
`<SqlResultChart result={result} />` with no `axes` prop; `result-chart.tsx:120`
reads `const kind = axes !== undefined && suggestedValue !== undefined ?
axes.kind : "bar"`. The component supports bar, line and area, and the assistant
can already infer which one a result set wants (`aiChartConfig`) — but that
inference is wired into the SQL console only. The dashboard, the one surface
whose entire purpose is charting, takes the constant arm on every render.

The other eight items in this plan are smaller, but they share a shape worth
naming up front: **in six of the nine, the capability already exists somewhere in
the repo and the consumer does not reach for it.** The chart kinds exist. The
schema types exist. The signed-URL image preview exists. This is a wiring plan
more than a building plan, and it should be sized accordingly — one large
workstream (W5), the rest S or M.

## 1. Current state (audit)

| #   | Gap                                                                  | Evidence                                                                                                                                                                     |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dashboard widgets are always bar charts                              | `packages/studio/src/features/reports/dashboards-panel.tsx:126`; fallback at `packages/studio/src/components/result-chart.tsx:120`                                           |
| 2   | A dashboard has exactly one block kind                               | `Widget` = `{id, shardKey?, sql, title}` (`dashboards-panel.tsx:19`), `WidgetDraft` the same minus `id` (`:28`)                                                              |
| 3   | The row editor infers field widgets from the _value_, not the schema | `packages/studio/src/features/data/row-form.tsx:26` `inferKind(column, value)`, called at `:181`                                                                             |
| 4   | One result set per run                                               | `packages/studio/src/features/sql/hooks/use-run-sql.ts:14` — `result: SqlConsoleResult \| undefined`                                                                         |
| 5   | The assistant is three stateless RPCs, not a conversation            | `packages/studio/src/features/sql/hooks/use-sql-assistant.ts:20-22`; engine at `packages/do/src/sql-assistant.ts`                                                            |
| 6   | No paste-into-grid                                                   | `packages/studio/src/features/data/grid-features.tsx:368` is the only clipboard path, and it is copy-out                                                                     |
| 7   | SQL history is plaintext `localStorage`                              | `packages/studio/src/features/sql/hooks/use-sql-library.tsx:8-9`, `:54-55` — 25 raw statements incl. literals                                                                |
| 8   | No media preview for binary / storage-backed cells                   | nothing in `grid-features.tsx` resolves an object URL                                                                                                                        |
| 9   | Shortcuts are hardcoded; there is no preferences surface             | `packages/studio/src/app/command-palette.tsx:114` (⌘K), `use-console-shortcut.ts:24` (Ctrl+`); `features/settings/settings-panel.tsx` is 163 lines of read-only deploy facts |

Two of these need their premise corrected before anyone starts:

**#4 is not an oversight.** `shared/sql-readonly.ts:33` defines
`SQL_MULTIPLE_STATEMENTS`, and `:148-155` rejects any `;` that is not a single
trailing one. The gate is the enforcement point for the whole SQL console — raw
writes bypass the schema-aware writer and desync the FTS/aggregate/rank shadow
tables (`shared/sql-readonly.ts:4-8`). Multi-result-set support must therefore be
built as _N separately-gated calls_, never as a relaxation of the classifier.

**#3 has a second half in codegen.** Even a row form that read `ColumnMeta`
(`packages/studio/src/lib/admin.ts:422-434`) could not build an enum dropdown:
`type` is the validator IR kind as a bare string, and `packages/codegen/src/emit.ts:2759`
writes `{ name: field, optional, type: resolved.kind }` — the union's members are
dropped. `packages/codegen/src/ir.ts:39,42` shows the IR already carries
`members?: ValidatorIR[]` and each literal's source text, so the information
exists one function upstream of where it is thrown away.

## 2. Existing seams (do not reinvent)

- **`SqlResultChart`** (`packages/studio/src/components/result-chart.tsx:85`) already takes an
  optional `axes: AssistantChartConfig` and renders bar/line/area from it. W1 is
  a prop, not a component.
- **`usePersistedList`** (`packages/studio/src/lib/browser-storage.ts`) backs saved queries,
  history and dashboards alike. New widget kinds extend the stored union; they do
  not get a second store.
- **`useRunSql`** (`features/sql/hooks/use-run-sql.ts`) owns the run/cancel lifecycle
  for both the console and every dashboard tile. W4 extends this hook, not its callers.
- **`sql-assistant.ts`** (`packages/do/src/sql-assistant.ts:1-27`) establishes the shape every
  AI surface here must reuse: one `runPrompt` primitive, one retry policy, one
  untrusted fence, one deadline, degrade-don't-throw. Its own docblock says a
  second AI surface inventing its own versions is how one of those goes missing.
- **`file-gallery.tsx:40,86`** already resolves a signed URL and renders an `<img>` for
  storage objects. W8 reuses that resolver; `ColumnMeta.isStorage` tells the grid
  which columns qualify.
- **`shared/sql-readonly.ts`** is the single classifier both the DO (enforcement)
  and the Studio (lint) call. W4 calls it per split statement and nothing else.

## 3. The behavioural contract to preserve

- `classifyStatement` keeps rejecting multi-statement input. Anything W4 splits is
  submitted as separate `runSql` calls, each independently gated server-side.
- The assistant never returns a privileged statement: generated SQL stays
  unexecuted and passes the same read-only gate (`sql-assistant.ts:19-23`).
- No row values leave the deployment for chart inference — `inferChart` sends
  column names, types and row count only (`use-sql-assistant.ts:33-36`).
- Existing persisted keys (`lunora-studio-dashboards`, `-sql-queries`,
  `-sql-history`) keep loading. A widget without a `kind` reads as a chart widget;
  `loadJsonArray` already degrades a poisoned value to `[]`.
- `ColumnMeta` stays additive on the wire. A Studio talking to an older worker
  gets no `enumValues` and must fall back to today's inference, not blank out.
- `api:check` — `ColumnMeta` is exported from `@lunora/studio` and `@lunora/do`;
  W3 moves a public surface and needs `pnpm run api:update` after a fresh build.

## 4. Design decisions

**Widget `kind` is a discriminated union in the persisted record, not a second
store.** Alternative rejected: a parallel `lunora-studio-dashboard-text` key per
block type. That multiplies the ordering problem by the number of kinds, and
ordering is what W2's layout work needs to stay single-sourced.

**Chart type is operator-chosen, with the assistant as a _default_, not the only
source.** Alternative rejected: wiring `inferChart` into the dashboard and calling
it done. That leaves every deployment without an AI binding on the bar-chart
constant arm — which is exactly today's bug with an extra network call.

**`enumValues` is emitted by codegen, not derived in the browser.** Alternative
rejected: shipping the validator IR to the client and unwrapping there. The IR is
large, versioned with codegen, and the Studio would then hold a second unwrapper
to drift against `emit.ts`.

**The conversational assistant does not run on the DO admin dispatch.**
`sql-assistant.ts:70-78` puts a 15 s deadline on one inference precisely because
`binding.run` is awaited on a single-threaded DO. A multi-turn agent with tool
calls cannot live there — see W5 and the STOP condition in §8.

**History confidentiality is solved by _not persisting_, not by encrypting.**
Alternative rejected: a `QueryHistoryEncryptionService` equivalent. A browser
that holds the key next to the ciphertext has bought nothing; moving history to
`sessionStorage` with an explicit opt-in to persist is smaller and honest.

## 5. Workstreams

Numbered to match the audit table. W1, W6, W7, W8 are independent and can land in
any order; W2 depends on W1; W3 spans codegen; W4 and W5 are the two that need
design review before code.

- **W1 (S) — Done.** Shipped as `5b9e64b9c`. `SqlResultChart` gained a `kind`
  prop for an explicitly CHOSEN shape, which always wins, kept separate from
  `axes.kind` (the suggestion, still discarded when its series does not survive
  the column gate). The widget stores `chartKind` apart from `chartAxes` so
  picking a shape does not discard inferred columns. **Differs from the plan in
  one place:** "Suggest chart" went on the CARD, not the form — inference needs a
  result and the form has never run its query. Accepting a suggestion writes both
  fields, because a click is a choice. Original text follows.

    **Pass `axes` to dashboard widgets.** Add `kind` + `x`/`y` to `Widget`
    and the draft form; render `<SqlResultChart axes={…} result={result} />`. Offer
    the assistant's inference as a "suggest" button that _fills the form_, so the
    picker still works with no AI binding. Gate: a dashboard widget saved with
    `kind: "line"` renders a line chart with the assistant unavailable.

- **W2 (M) — Three more widget kinds.** `kpi` (single scalar + label, from the
  first cell of the first row), `text` (markdown), `table` (reuse the console's
  result table). Plus drag-to-reorder over the existing persisted array. Gate: a
  dashboard mixing all four kinds round-trips through `localStorage` and
  reorders.

- **W3 (M) — Done.** Shipped as `f55f0b06e` + `a6d5cdeb9` (regeneration).
  **Two corrections to this plan.** First, there are FOUR declarations of the
  `ColumnMeta` shape, not three — §6 missed
  `studio/src/features/schema/database-schema-node.tsx:17`. It is the diagram's
  own local shape and structurally compatible, so it did not need the field, but
  the parity note undercounted. Second, the column type icons named below were
  **not built** — filed as W10, with the reasoning there.

    Unplanned upside: `examples/chess` and `examples/feedback-board` already
    declare `v.union(v.literal(…))` columns, so the regeneration exercised the
    emitter end to end on real schemas rather than only the hand-built IR in the
    unit tests — `chess.games.status` emits `["active", "completed", "abandoned"]`.
    Original text follows.

    **Schema-aware row editing.** Three files move together:
    `packages/codegen/src/emit.ts:2759` adds `enumValues` when `resolved.kind` is a
    union whose every member is a literal. **`literalValue` is canonical _source
    text_, not the value** (`parse-validator.ts:326-329` — strings arrive
    JSON-stringified), so the emitter parses it back before writing the array or
    every dropdown option ships wrapped in quotes; `ColumnMeta` gains the optional field in
    `packages/studio/src/lib/admin.ts:422` and `packages/shard-engine/src/introspect.ts:284`;
    `row-form.tsx:181` takes `ColumnMeta` and falls back to `inferKind` only when
    the column is unknown. Adds a `<select>` for enums, a checkbox for a _null_
    boolean, and column type icons in the grid header. Gate: a `v.union(v.literal…)`
    column renders a dropdown; golden codegen fixtures + example `_generated`
    regenerated; `api:update` after a fresh build.

- **W4 (M) — Multi-statement scripts as N gated runs.** Split on statement
  boundaries in the editor using the comment scanner already in
  `features/sql/sql-context.ts`, classify each part with `classifyStatement`,
  submit sequentially, and tab the results. `useRunSql` returns a list; a single
  statement is a one-element list so no caller special-cases. Gate: a script whose
  second statement fails the gate shows the first result _and_ the rejection,
  and the server never receives a `;`-joined string.

- **W5 (L) — Spun out.** Its own plan, as this one required: see
  [364-studio-conversational-assistant.md](364-studio-conversational-assistant.md).
  Original text follows.

    **A conversational assistant.** The one genuinely new mechanism.
    Multi-turn chat with history, grounded in the same schema facts, able to call
    the read-only admin RPCs as tools and to _propose_ a migration the operator
    reviews before applying. **Must not run on the ShardDO admin dispatch** — needs
    its own transport (an action, or `@lunora/agent` over Workflows, which already
    exists in-repo). Design first: this workstream should produce its own plan
    before it produces code. Gate: a ten-turn conversation completes without
    holding an admin dispatch open, provable by concurrent `runSql` latency.

- **W6 (S) — Done.** Shipped as `542207504`. Went further than "reuse
  `staged-edits`": the planner (`planPastedEdits`) is a pure module-level
  function separate from the handler, because what a paste DECLINES is the part
  worth asserting. Original text follows.

    **Paste into the grid.** Clipboard TSV → staged edits, reusing
    `staged-edits.tsx` so the review-then-apply path is the existing one. Gate: a
    pasted block that would violate a column type is rejected at stage time, not at
    apply time.

- **W7 (S) — Done.** Shipped as `542207504`. One thing the plan did not
  anticipate: `usePersistedList` reloads from the new slot when the storage area
  changes, so flipping the toggle ON would have DISCARDED the tab's history —
  asking to keep it is what would have destroyed it. The toggle now seeds the
  destination before flipping. It lives next to the history list in the SQL
  sidebar rather than in settings, which is where an operator is when they think
  about it; W9 need not move it. Original text follows.

    **Stop persisting SQL history by default.** `use-sql-library.tsx:9`
    moves `HISTORY_KEY` to `sessionStorage` (`storageOf("session")` already exists),
    with a settings toggle to opt into `localStorage` and a "clear history" that
    clears both. Saved queries stay in `localStorage` — those are deliberate.
    Gate: a fresh tab after a browser restart shows no history unless opted in.

- **W8 (S) — Done.** Shipped as `542207504`, as planned. Original text follows.

    **Media preview for storage cells.** In the cell-detail popover
    (`grid-features.tsx:354-385`), when the column has `isStorage`, resolve the
    signed URL the way `file-gallery.tsx:40` does and render the image. Gate: a
    `v.storage()` column shows a thumbnail; a non-image object still shows text.

- **W9 (S) — A real settings panel + keymap.** Extend
  `features/settings/settings-panel.tsx` from read-only deploy facts to actual
  preferences, with the shortcut bindings (`command-palette.tsx:114`,
  `use-console-shortcut.ts:24`) read from that store rather than hardcoded.
  W7's history toggle lands here. Gate: a rebound palette shortcut survives a
  reload and the default is restorable.

- **W10 (S) — Column type icons in the grid header.** Split out of W3, which
  named it and did not build it. The declared type per column is already on the
  wire (`ColumnMeta.type`); the work is threading `columnMeta` from
  `data-browser.tsx` through the page and `DataBrowserTableView` to
  `GridHeaderCell`, and picking a glyph per validator kind. Deliberately last:
  three new props for decoration, and nothing here can fail a gate. Gate: a
  numeric and a string column render distinguishable header glyphs, and a column
  with no metadata renders none.

## 6. Platform parity

No `ctx.*` surface, provider binding, or deploy capability changes — the Studio is
a console over existing admin RPCs, and eight of nine workstreams are browser-side.

**W3 is the one row worth stating**, because `ColumnMeta` is host-produced:

| Feature                 | `cloudflare` | `node` | Notes                                                                                                                                                                           |
| ----------------------- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ColumnMeta.enumValues` | native       | native | Emitted by codegen from the schema IR, not read from a database catalog, so it is host-independent by construction. Both hosts serve the same generated `LUNORA_TABLE_COLUMNS`. |

The parity hazard is not the matrix but the **three copies of the `ColumnMeta`
shape** — `packages/studio/src/lib/admin.ts:422`,
`packages/shard-engine/src/introspect.ts:284`, and the inline type codegen emits at
`packages/codegen/src/emit.ts:4865`. They must move in one commit. A field added to
two of three is the drift `AGENTS.md` calls out for the `*Like` projections.

## 7. Phasing & ordering

| Phase | Work       | Gate                                                                                                                               |
| ----- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0     | W1         | A `kind: "line"` widget renders a line chart with `aiAvailable` false                                                              |
| 1     | W7, W8, W6 | Fresh-tab history empty; storage thumbnail renders; a bad paste is refused at stage time                                           |
| 2     | W3         | `pnpm run test` in codegen with regenerated fixtures + example `_generated`; `api:check` green after `api:update` on a fresh build |
| 3     | W2, W9     | Four-kind dashboard round-trips + reorders; rebound shortcut survives reload                                                       |
| 4     | W4         | Script with a gate-failing second statement shows result 1 + the rejection; no `;`-joined string reaches the server                |
| 5     | W5         | Its own plan, reviewed, before any code — **done, see [364](364-studio-conversational-assistant.md)**                              |
| 6     | W10        | A numeric and a string column render distinguishable header glyphs                                                                 |

Phase 2 is the only one that leaves `@lunora/studio`. Run `pnpm run build:packages`
before measuring anything in it (stale `dist` is the usual false failure), and
`pnpm run api:update` reads `dist/`, so build first or the snapshot is wrong.

## 8. Risks & STOP conditions

- **STOP** if W4 leads anyone to relax `classifyStatement`. The gate is the
  enforcement boundary for the entire SQL console — splitting happens above it,
  never inside it. If splitting cannot be done without touching the classifier,
  the design is wrong; re-scope to "show the rejection with a per-statement
  offset" and stop there.
- **STOP** if W5 lands anything that awaits a model on the ShardDO admin
  dispatch. `sql-assistant.ts:70-78` documents why a 15 s deadline exists there; a
  conversation cannot be given one. It needs a different transport or it does not
  ship.
- **Risk:** W3's `enumValues` reaches a Studio talking to an older worker, or an
  older Studio talking to a new one. Mitigate: optional field, and the row form
  keeps `inferKind` as the fallback for any column it has no metadata for — which
  is also the `v.any()` case, so the fallback is load-bearing regardless.
- **Risk:** W2's drag-reorder rewrites the whole persisted array on every drop.
  Mitigate: it is a handful of widgets in `localStorage`; if that stops being
  true the store is the wrong shape, not the write path.
- **Risk:** W1 and W2 both edit `dashboards-panel.tsx`'s persisted `Widget`. Land
  W1 first and let W2 extend its union rather than merging two shapes later.
- **Perf watch:** none of W1–W4, W6–W9 touch a hot path. W5 does — if it lands as
  an action, measure concurrent `runSql` p99 during a conversation; that number
  is the whole point of keeping it off the admin dispatch.

## 9. Open questions (answer during execution)

1. ~~Does a literal union survive to `emit.ts` with populated `members`?~~
   **Answered while writing this plan: yes.** `parse-validator.ts:353-358` builds
   `{kind: "union", members: […]}`, and `:323-330` builds each literal as
   `{kind: "literal", literalValue: <source text>}`. The catch is in that last
   word — see the caveat in W3.
2. Should a mixed union (`v.union(v.literal("a"), v.string())`) get a dropdown
   with a free-text escape, or fall back to plain text? Leaning fall back —
   a dropdown that silently forbids a legal value is worse than no dropdown.
3. W4: does the console show one result tab per statement, or one tab per
   _result-producing_ statement? An `EXPLAIN`-only script is the case that decides it.
4. W5: `@lunora/agent` over Workflows, or a plain action with client-held history?
   The first gets durability and HITL approvals for free; the second is far less
   machinery for a console session nobody resumes.
5. W9: are shortcut preferences per-browser (`localStorage`) or per-deployment (an
   admin RPC)? Per-browser is the smaller answer and probably the right one, but
   it means a shared ops browser has one operator's bindings.
