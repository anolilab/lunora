# Plan 022: Borrow from localflare + d1-manager into Cirrus Studio

> **Executor instructions**: This is a **multi-item borrow plan** — seven
> independent work items, each shippable as its own PR. Execute one item at a
> time, top to bottom within a priority tier. For each item: read its "Source",
> "Scope", and "Steps", run its "Verify" gate, and only then move on. Honor the
> global STOP conditions. When an item lands, tick its box in "Done criteria"
> and update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 2c403598..HEAD -- packages/studio/src/features ECOSYSTEM-BORROW.md`
> If a target file changed since this plan was written, re-read it before
> editing — the "Target" pointers below are line-free on purpose (they name
> files, not line numbers) but the surrounding APIs may have moved.

## Status

- **Priority**: mixed — P0 ×1, P1 ×3, P2 ×2, P3 ×1 (per item below)
- **Effort**: L overall (S–L per item)
- **Risk**: LOW–MEDIUM (mostly additive UI; the D1-metrics item has a runtime
  sub-task in `@cirrus/do` that is MEDIUM)
- **Depends on**: nothing external. Item 1 rides the open
  `feat/studio-schema-diagram` branch. Items 2 and 4 share FK-graph code with
  the schema diagram; item 5 builds on the advisor lints item 3 touches.
- **Category**: DX / feature parity (Studio)
- **Planned at**: commit `2c403598`, 2026-06-14
- **Sources cloned for reference**:
    - d1-manager → `/home/prisis/WebstormProjects/demo/d1-manager` (MIT, © 2025–2026 Adamic)
    - localflare → `/tmp/localflare` (MIT, © 2025 Rohan Prasad)

## Why this matters

`ECOSYSTEM-BORROW.md` inventories Cloudflare-ecosystem studios worth borrowing
from. Two MIT-licensed projects on **Cirrus's exact stack** (React + Vite +
Tailwind + shadcn/ui) were missing and cover real gaps the current Studio does
not: ER-diagram export, FK-cascade tooling, schema-integrity advisors, and a
query-level metrics surface. Because both are MIT and shadcn-based, their
components are near-vendorable — the work is mostly wiring, not reinvention.

## License gate (read before copying any file)

Both sources are **MIT** → code is **copy-eligible**. Per `ECOSYSTEM-BORROW.md`:

- If you **literally vendor** a source file (or a substantial block), keep the
  upstream MIT header + copyright line in the Cirrus file (the convention we
  already follow for the TanStack `generate-labeler-config.js` script).
- If you **re-implement** the pattern (most items here), no attribution is
  required — layout/algorithm ideas aren't copyrightable. The per-item "Verdict"
  says which applies.
- Do **not** copy from any AGPL source (Outerbase / StarbaseDB) — unchanged from
  the inventory; these two new sources are the only additions.

## Commands you will need

| Purpose       | Command                                          | Expected |
| ------------- | ------------------------------------------------ | -------- |
| Build deps    | `pnpm run build:packages`                        | exit 0   |
| studio build  | `pnpm --filter "@cirrus/studio..." run build`    | exit 0   |
| studio tests  | `pnpm --filter "@cirrus/studio" run test`        | pass     |
| studio types  | `pnpm --filter "@cirrus/studio" run lint:types`  | exit 0   |
| studio eslint | `pnpm --filter "@cirrus/studio" run lint:eslint` | exit 0   |
| advisor tests | `pnpm --filter "@cirrus/advisor" run test`       | pass     |
| do tests      | `pnpm --filter "@cirrus/do" run test`            | pass     |

Build dependencies once (`pnpm run build:packages`) before any filtered
`test`/`lint:types` — repo convention (plan 016).

## What Cirrus already has — do NOT re-borrow

Confirmed at `2c403598` in `packages/studio/src/features/`:

- **Data grid** — virtualized, drag-resize, column reorder, column-visibility,
  staged-edits→commit, inline edit, pagination, filters
  (`data/data-browser-grid.tsx`, `grid-features.tsx`, `staged-edits.tsx`).
  Already ≥ both sources' grids — skip their data-grid code.
- **SQL** — editor + autocomplete + formatter + saved-query tabs (`features/sql/`).
- **ER diagram** — React Flow nodes + layout (`features/schema/`).
- **Advisors** — FK/index/duplicate-index lints (`packages/advisor/src/lints/static/`).
- **Time-travel / PITR, export/import, migrations** (`features/database/`).
- **R2 file browser** (`features/storage/`).
- **Shard metrics** — cache hit-rate, requests/errors, DB size, rolling duration
  sparkline, per-handler durations, index-hit + scan-attribution
  (`features/reports/`, `lib/admin.ts`).

The items below are scoped to the **gaps** only.

---

## Item 1 — ER diagram export (PNG / SVG / JSON)

- **Priority**: P0 · **Effort**: S · **Risk**: LOW
- **Source**: d1-manager ER-diagram export (PNG/SVG/JSON).
- **Verdict**: **ideas** — Cirrus uses React Flow, d1-manager does not, so
  re-implement using React Flow's documented export path; no attribution needed.
- **Target**: `packages/studio/src/features/schema/schema-diagram.tsx` (+ a small
  toolbar), `packages/studio/src/locales/en.ts`.

### Scope

In scope: a download control on the schema diagram that exports the current
graph. Out of scope: server-side rendering, scheduled exports.

### Steps

1. Add `html-to-image` to `@cirrus/studio` deps (catalog if a version exists;
   it's React Flow's recommended export lib). Verify it isn't already present.
2. In `schema-diagram.tsx`, add a toolbar button group "Export" with PNG / SVG /
   JSON. For PNG/SVG, use React Flow's `getNodesBounds` + `getViewportForBounds`
   to frame all nodes, then `toPng` / `toSvg` on the `.react-flow__viewport`
   element. For JSON, serialize the current `nodes`/`edges` (the same shape
   `buildNodes` produces) to a downloaded blob.
3. Add `en.ts` strings ("Export", "PNG", "SVG", "JSON") following the
   key-as-English convention.
4. Add a unit test asserting the JSON serializer returns the node/edge shape, and
   a render test that the Export control mounts (image rasterization is not
   testable in jsdom — assert the button + the JSON path only).

### Verify

`pnpm --filter "@cirrus/studio..." run build` → 0; `… run test -- schema` → pass;
`… run lint:types` → 0; `… run lint:eslint` → 0.

---

## Item 2 — Cascade-impact simulator

- **Priority**: P1 · **Effort**: M · **Risk**: LOW (read-only preview)
- **Source**: d1-manager "Cascade Impact Simulator" (preview a DELETE's cascade
  before running it).
- **Verdict**: **ideas** — re-implement the FK traversal over `defineSchema`.
- **Target**: new `packages/studio/src/features/data/cascade-preview.tsx`, wired
  into `features/data/row-detail.tsx` (the delete action); reuse the FK graph in
  `packages/studio/src/features/schema/layout.ts`.

### Scope

In scope: when the operator deletes a row, show which related rows would cascade
(or block on `restrict`) based on the schema's `onDelete` relations, as a
read-only preview before confirm. Out of scope: actually changing delete
semantics; runtime enforcement (the DO already enforces).

### Steps

1. Extract/reuse the relation graph the diagram builds (FK edges +
   `onDelete: "cascade" | "restrict" | "set null"`, already modeled in
   `packages/advisor/src/schema.ts`). Walk it from the target table.
2. For a chosen row, issue read-only count/sample queries down the cascade chain
   (bounded depth + row cap; `log`/note the cap — no silent truncation).
3. Render the impact tree in a `modal-shell` before the existing confirm-delete;
   mark `restrict` edges as blockers.
4. Tests: a pure unit test of the cascade-walk over a fixture schema (cascade,
   restrict, set-null, and a cycle → must terminate); a render test of the
   preview tree.

### Verify

`pnpm --filter "@cirrus/studio..." run build` → 0; `… run test` → pass; types +
eslint → 0.

---

## Item 3 — Circular-FK + constraint advisors

- **Priority**: P1 · **Effort**: M · **Risk**: LOW
- **Source**: d1-manager "Circular Dependency Detector (DFS)" + "Constraint
  Validator (FK / NOT NULL / UNIQUE)".
- **Verdict**: **ideas** — new lints in the existing advisor framework.
- **Target**: `packages/advisor/src/lints/static/circular-fk.ts` (new) and a
  data/runtime constraint lint; surface via
  `packages/studio/src/features/advisors/advisor-view.tsx` (no studio change if
  the advisor table already renders all registered lints — verify).

### Scope

In scope: (a) a **static** lint detecting FK cycles via DFS over the relation
graph; (b) a **constraint** lint flagging rows that violate declared FK /
NOT NULL / UNIQUE. Out of scope: auto-fixing violations.

### Steps

1. Read an existing static lint (`duplicate-index.ts`) to match the rule shape
   (id, severity, `detect(schema)` → findings) and registration.
2. Implement `circular-fk.ts`: DFS over relations, report each cycle once
   (normalize cycle ordering to dedupe). Add `Set`-based visited tracking
   (advisor convention — plan 012).
3. Implement the constraint validator as a lint that reads sampled rows (bounded)
   and checks declared constraints; reuse the advisor's existing data-read path.
4. Register both; add unit tests next to the existing lint tests (cycle fixture;
   a violating-row fixture). Confirm they appear in the Advisors table (manual or
   via the studio advisor test).

### Verify

`pnpm --filter "@cirrus/advisor" run test` → pass; `… run lint:types` → 0;
`pnpm --filter "@cirrus/studio..." run build` → 0.

---

## Item 4 — D1 / query metrics + slow-query insights

- **Priority**: P1 · **Effort**: M–L · **Risk**: MEDIUM (runtime sub-task)
- **Source**: d1-manager `MetricsDashboard.tsx`, `MetricsChart.tsx`,
  `QueryInsightsTab.tsx`.
- **Verdict**: **copy** for the studio presentation (shadcn/ui + dependency-free
  SVG charts → near-vendorable; **keep the MIT header** on any file copied
  substantially) **plus a runtime addition** in `@cirrus/do`.
- **Target**:
    - runtime: `packages/do/` (per-statement timing/rows on the SQL path) +
      `MetricsSnapshot` in `packages/studio/src/lib/admin.ts`.
    - studio: `packages/studio/src/features/reports/` — new `query-insights.tsx`,
      extend `metrics-panel.tsx` / `metrics-aggregate.ts`. Reuse the existing
      `sparkline.tsx` / `result-chart.tsx` rather than vendoring d1-manager's
      `MetricsChart` (Cirrus already has dependency-free SVG charts → no new dep).

### What this adds beyond today's shard metrics

1. **Time-windowed trend dashboard** — range selector with query-volume /
   latency / storage trend charts + up/down deltas (today: live rolling window
   only, no historical range or deltas).
2. **Percentile latency (P90/P95)** — today only per-handler max/total exists.
3. **Slow-query leaderboard** — per-statement
   `totalTime / avgTime / execCount / rowsRead / rowsWritten`, sortable, with
   performance badges. Highest-value gap; pairs with existing index-hit /
   scan-attribution data.

### Steps

**Sub-task (a) — runtime (do it first for the leaderboard):**

1. In the DO SQL path, record per-statement duration + rows-read/written
   (aggregate by normalized statement). Read the existing metrics recording
   (cache hits, durations history) and extend it — do not add a second metrics
   system.
2. Surface the aggregates on `getMetrics` and extend `MetricsSnapshot` (optional
   fields, so a pre-feature worker still parses — match the existing
   `indexHits?` / `history?` optionality in `lib/admin.ts`).
3. Add do tests for the new aggregation.

**Sub-task (b) — studio:**

4. Add `query-insights.tsx` (the slow-query leaderboard + badges) — vendor
   d1-manager's `QueryInsightsTab.tsx` structure with the MIT header; swap its
   `@/components/ui/*` imports for Cirrus's `components/ui/*` and its
   `formatLatency`/`formatNumber` helpers for the studio equivalents.
5. Extend `metrics-panel.tsx` with the time-range selector + trend deltas and
   P90/P95 readouts (reuse `sparkline.tsx`). Extend `metrics-aggregate.ts` types.
6. Add `en.ts` strings. Tests for the aggregate math (percentiles, deltas) and a
   render test of the leaderboard.

> **Ship order within the item**: the trend/percentile parts (5) can land on
> today's snapshot data alone; the leaderboard (4) needs sub-task (a). If (a)
> slips, ship (5) first and gate (4) behind the optional `MetricsSnapshot`
> fields (render the leaderboard only when present).

### Verify

`pnpm --filter "@cirrus/do" run test` → pass; `pnpm --filter "@cirrus/studio..." run build` → 0;
`… run test -- reports` (or the metrics test glob) → pass; types + eslint → 0.

---

## Item 5 — "Create all missing indexes" one-click apply

- **Priority**: P2 · **Effort**: S · **Risk**: LOW
- **Source**: d1-manager "Index analyzer → Create All Indexes".
- **Verdict**: **ideas** — Cirrus already detects unindexed FKs /
  filter-without-index in advisors; add the apply action.
- **Target**: `packages/studio/src/features/advisors/*` (an apply button on the
  relevant findings) + `packages/studio/src/features/database/migrations.tsx`
  (emit the `CREATE INDEX` migration).

### Steps

1. For advisor findings of the "missing index" family, render an apply action
   that composes the `CREATE INDEX` statement(s) from the finding's table/columns.
2. Route the apply through the existing migrations path (do not run ad-hoc DDL
   outside it). Confirm-before-apply via `confirm-button.tsx`.
3. Add `en.ts` strings; a unit test that the finding → `CREATE INDEX` SQL mapping
   is correct; a render test of the apply control.

### Verify

`pnpm --filter "@cirrus/studio..." run build` → 0; `… run test -- advisor` → pass;
types + eslint → 0.

---

## Item 6 — Faker-based seed / dummy-data generator

- **Priority**: P2 · **Effort**: M · **Risk**: LOW
- **Source**: localflare + d1-manager dummy-data generation (both use Faker).
- **Verdict**: **copy** (Faker usage patterns) — Cirrus has
  `data/hooks/use-live-shard-seed.ts` (seeding) but no per-column generator UI.
- **Target**: `packages/studio/src/features/data/` — a "Generate rows" dialog;
  infer generators from column types via the `v.*` validators.

### Steps

1. Add `@faker-js/faker` to `@cirrus/studio` deps (catalog).
2. Build a generator that maps each column's validator (`v.string`, `v.number`,
   `v.id(...)`, `v.boolean`, etc.) to a Faker producer; respect required vs
   optional and FK columns (pick an existing referenced id, or skip with a note).
3. Add a "Generate N rows" dialog in the data browser; inserts go through the
   existing mutation/insert path (reuse staged-edits/commit, not raw writes).
4. Tests: unit test of the type→generator mapping for each `v.*` kind; a render
   test of the dialog.

### Verify

`pnpm --filter "@cirrus/studio..." run build` → 0; `… run test -- data` → pass;
types + eslint → 0.

---

## Item 7 — Shard / Durable-Object state explorer

- **Priority**: P3 · **Effort**: M · **Risk**: LOW
- **Source**: localflare "Durable Objects: instance listing + state inspection".
- **Verdict**: **ideas** — re-implement over Cirrus's admin RPC.
- **Target**: `packages/studio/src/components/shard-input.tsx` +
  new `packages/studio/src/features/data/shard-explorer.tsx`; reuse
  `lib/shard-history.ts`.

### Scope

In scope: list known/recent shards and peek a shard's state (tables + row counts)
without typing the key by hand. Out of scope: KV / Queues browsers (Cirrus's
model is DO + D1; those are not first-class Studio bindings — see
`ECOSYSTEM-BORROW.md` "out of scope").

### Steps

1. Surface recent shards from `lib/shard-history.ts` as a pickable list beside
   the existing `ShardInput`.
2. On select, show the shard's table/row-count summary using the existing admin
   metrics/describe calls (no new admin op if one already returns this; otherwise
   STOP and note — adding a `@cirrus/do` op is a separate scoped change).
3. Tests: render test of the picker; the summary read is covered by existing
   admin mocks.

### Verify

`pnpm --filter "@cirrus/studio..." run build` → 0; `… run test` → pass;
types + eslint → 0.

---

## Sequencing

1. **Item 1** (P0) — rides the open `feat/studio-schema-diagram` branch.
2. **Items 2, 3, 4** (P1) — schema-integrity + observability. 2 and 4 share
   FK-graph code with the diagram; 4's runtime sub-task (a) is the longest pole —
   start it early, ship 4(b)-trends without it.
3. **Items 5, 6** (P2), then **Item 7** (P3) — independent follow-ups.

Each item is its own branch + conventional commit, e.g.
`feat(studio): export the schema diagram as png/svg/json`,
`feat(advisor): detect circular foreign-key dependencies`,
`feat(do): record per-statement query metrics`. Do NOT push or open PRs unless
the operator says so.

## Done criteria

Per item — built + verified on its own branch off `2c403598` (2026-06-14); not
yet merged into `feat/studio-schema-diagram`:

- [x] Item 1 — diagram export (PNG/SVG/JSON) — `feat/studio-diagram-export` @ `f300848b`
- [x] Item 2 — cascade-impact simulator — `feat/studio-data-tools` @ `0dd501ee`
- [x] Item 3 — circular-FK + constraint advisors — `feat/advisor-schema-integrity` @ `9c3ab4b8`
- [x] Item 4 — D1/query metrics + slow-query insights — `feat/do-query-metrics` @ `d58d0f28` (do) + `11626622` (studio). NOTE: workerd-backed `@cirrus/do` tests can't run in this sandbox; runtime verified via plain-Node unit tests + `lint:types`.
- [x] Item 5 — create-all-missing-indexes apply — `feat/advisor-schema-integrity` @ `38232066`. NOTE: applies by composing `CREATE INDEX IF NOT EXISTS` and copying to clipboard (the `runSql` admin RPC is read-only — DDL can't be auto-executed). Revisit if a write-DDL admin op is added.
- [x] Item 6 — Faker seed/dummy-data generator — `feat/studio-data-tools` @ `9168ae21`
- [x] Item 7 — shard/DO state explorer — `feat/studio-data-tools` @ `dc47527e` (no new DO op — `listTables` already returns row counts)
- [x] `ECOSYSTEM-BORROW.md` updated with localflare + d1-manager rows and dead links fixed
- [x] `plans/README.md` status row for 022 updated
- [ ] **Remaining**: merge the four branches into `feat/studio-schema-diagram` (expect trivial `en.ts` conflicts — multiple items appended keys), then remove the worktrees (`git worktree remove .worktrees/*`).

## STOP conditions

Stop and report (do not improvise) if:

- An item needs a **new `@cirrus/do` admin op** beyond what's described (items 4
  and 7 flag this) — scope and confirm the runtime change separately before
  touching the DO wire format.
- Vendoring a d1-manager file (item 4) would pull in a transitive dependency
  Cirrus doesn't already have — prefer re-implementing over adding deps; only
  `@faker-js/faker` (item 6) and `html-to-image` (item 1) are sanctioned new deps
  here.
- Any item's data-read path would need an **unbounded** scan (items 2, 3, 6) —
  keep every preview/validation/generation bounded and surface the cap; never
  silently truncate.

## Maintenance notes

- Both sources are MIT; the only attribution obligation is keeping the upstream
  header on **literally vendored** files (item 4 is the main candidate). Re-implemented
  items need none.
- KV / Queues browsers and a Drizzle ORM console were deliberately left out — see
  the "out of scope" note in `ECOSYSTEM-BORROW.md`. Revisit only if Cirrus
  surfaces those bindings as first-class Studio concepts.
  </content>
  </invoke>
