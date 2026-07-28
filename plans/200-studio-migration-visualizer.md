# Plan 200 — Studio migration & schema-version visualizer

- **Category**: feat (competitive parity — Prisma Studio `migrations` view)
- **Priority**: P2
- **Effort**: L · **Risk**: MED
- **Status**: DONE (Phases 1–4 shipped; one Phase-2 item partial — see below)
- **Baseline**: `865a9a4c` (2026-07-28)
- **Goal**: give Studio a migration history that can be _seen_ — a timeline of
  applied schema versions, a visual diff of what each one changed, and the data
  migrations that ran alongside it. Closes the largest gap vs
  [prisma/studio](https://github.com/prisma/studio)'s `migrations` view.

## Context (verified)

**What Studio has today.** `packages/studio/src/features/database/migrations.tsx:41`
(`MigrationsPanel`, 267 lines) renders a flat run-state table — id, direction,
status, processed, changed, updatedAt, error — from
`__lunora_admin__:migrationStatus`, plus a form that runs a migration by id with
a direction toggle and a dry-run checkbox (`__lunora_admin__:runMigration`).
There is no history, no diff, and no per-migration detail.

**What Prisma does** (`Architecture/migrations-view.md`, `ui/studio/views/migrations/`):
reads a `prisma_contract.ledger` table — one row per applied migration holding an
`origin_core_hash` → `destination_core_hash` edge into a content-addressed store
of full schema snapshots — and renders a timeline list plus a React Flow + ELK
diff canvas (touched models as status-colored cards with `+`/`−`/`~` field
glyphs, relation neighbors dimmed as context, an "All models" toggle), over two
detail panels: the migration's verbatim SQL, and a schema-text diff. Selection
lives in a URL param so a diff is shareable. **The database ledger is the single
source of truth** — Studio never reads migration files from disk.

**What we already own.** Three of the four pieces exist:

| Piece                              | Where                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural schema snapshot         | `packages/codegen/src/schema-drift.ts` — `SchemaSnapshot` v1: per table, `fields{kind, optional}` / `indexes{fields, unique}` / `relations{field, kind, table}` / shard mode, plus declared migration ids |
| Diff engine with classification    | same file — `diffSchemaSnapshots(baseline, current)` → `SchemaDrift` with `DriftChange[]` classified `safe` \| `breaking`                                                                                 |
| A React Flow canvas + layout       | `packages/studio/src/features/schema/{schema-diagram.tsx,database-schema-node.tsx,layout.ts,diagram-export.ts}`; `@xyflow/react` is already a `packages/studio` dependency                                |
| **A ledger — snapshots over time** | **missing** — `packages/cli/src/util/schema-drift-gate.ts` keeps exactly ONE committed baseline at `lunora/.lunora-schema.json` and overwrites it                                                         |

**The semantic difference that must not be papered over.** Prisma's ledger tracks
DDL migrations. Lunora has two separate things:

1. **Schema versions** — `defineSchema` is applied to each DO's SQLite at cold
   start by `runShardMigrations(sql, schema)`
   (`packages/do/src/ctx-db-migrations.ts:210`, every statement `IF NOT EXISTS`,
   idempotent). Nobody records that a version _changed_.
2. **Data migrations** — hand-written `defineMigration` declarations run by
   `packages/do/src/data-migration.ts` (per-shard, resumable, progress persisted
   to the reserved `__lunora_migrations` table). This is what the current panel
   shows.

The visualizer must show schema versions on the timeline and **correlate** the
data migrations that ran between two versions — not pretend one is the other.

## Design

**The DO is the ledger** (Prisma's principle, ported). Not `lunora/.lunora-schema.json`:
a file on the developer's disk is invisible to a deployed Studio, and Studio
already reaches everything through admin RPCs. A reserved
`__lunora_schema_history` table makes the feature work in production, per shard,
with no new transport.

**Codegen emits the snapshot; the DO stores it.** `schema-drift.ts` builds its
snapshot from `SchemaIR` (AST-derived, build-time) while the DO holds a runtime
`SchemaLike` — different shapes. Rather than reimplement (and let two builders
drift), codegen emits the already-computed snapshot + its hash as a constant into
`_generated/`, the worker threads it to the DO, and `runShardMigrations` appends
a ledger row when the hash differs from the last one. One builder, guaranteed
consistent with the deploy gate.

**The diff engine moves to `shared/`.** `diffSchemaSnapshots` lives in
`@lunora/codegen`, a build-time package Studio cannot import. The snapshot types
and the pure diff are zero-dependency, and are needed by two packages that must
not gain a dependency edge — the documented use case for the top-level `shared/`
folder (bundler-inlined, no runtime edge). See `CLAUDE.md` § "Top-level `shared/`".

## Phase 1 — The ledger

- [x] Extract `SchemaSnapshot` / `FieldSnapshot` / `IndexSnapshot` /
      `RelationSnapshot` / `TableSnapshot` + `diffSchemaSnapshots` + the
      `safe`/`breaking` classification into `shared/schema-snapshot.ts`
      (zero-dep, named exports only, no `.js` extensions). `@lunora/codegen`
      imports it by relative path; `schema-drift.ts` keeps only the
      `SchemaIR` → `SchemaSnapshot` builder and the gate policy.
- [x] Consumer tsconfigs importing `shared/*` must drop `outDir`/`rootDir`
      (TS6059) — add the breadcrumb comment the other such tsconfigs carry.
- [x] Codegen emits `SCHEMA_SNAPSHOT` + `SCHEMA_SNAPSHOT_HASH` (stable hash of
      the serialized snapshot) into `_generated/`, wired through the worker entry
      to `ShardDO` the way the schema itself is.
- [x] Reserved `__lunora_schema_history` table in the DO:
      `(hash TEXT PRIMARY KEY, seq INTEGER, snapshot_json TEXT, applied_at INTEGER)`.
      `runShardMigrations` appends one row when `hash !== last(hash)` — content
      addressed, so a rollback to a prior schema re-links rather than duplicating.
      Best-effort and non-fatal: a failure to record must never block a cold start.
- [x] Retention cap (mirror `QUERY_METRICS_MAX_STATEMENTS`'s bounded-table
      discipline) — keep the most recent N versions, N configurable, prune oldest.
- [x] Regenerate codegen golden fixtures + example `_generated` (see the
      "Codegen fixture regen" memory).

## Phase 2 — Read path

- [x] `__lunora_admin__:schemaHistory` RPC (landed in `shard-do.ts`'s
      `readAdminOp` dispatch next to `runSql`, not
      `introspection-admin-routes.ts` — that is where the sibling read resolvers
      live) → `{ versions: [{ hash, seq,
appliedAt }] }` (list) and a by-hash detail returning the snapshot. **List and
      detail must be separate calls** — snapshots are large, and Prisma's view
      gates its nav item on a one-row `EXISTS` probe for exactly this reason.
- [x] Add to `ADMIN_FUNCTIONS` in `packages/studio/src/lib/admin.ts` with types.
- [~] PARTIAL — `hasSchemaHistory` (the one-row `EXISTS` probe) ships in
  `@lunora/do`, and a shard with no ledger renders the empty state, so a stale
  deep link is safe. The nav item itself is NOT yet gated on the probe: the
  Migrations tab already existed for data migrations and still has content
  without any schema history, so hiding it would be a regression. Wire the
  probe if the tab ever becomes schema-history-only.
- [x] Older workers without the table: the RPC is absent → the panel degrades to
      today's run-state table (the `declaredIndexes`/`shardTraffic` best-effort
      pattern in `features/advisors/insights-panel.tsx`).

## Phase 3 — The visual diff

- [x] `features/database/schema-history.tsx`: version timeline (left) + diff
      canvas (right), selection in a URL param so a diff is shareable.
- [x] Diff-styled variant of `SchemaDiagram`: added / removed / changed / unchanged
      node status, `+`/`−`/`~` field glyphs, before → after pills for changed
      fields, added/removed relation edges emphasized, unchanged neighbors dimmed
      as context, an "All tables" toggle. Reuse `layout.ts`; **do not key the
      canvas by version id** — stable node ids (`table:<name>`) let surviving
      nodes animate to new positions instead of remounting (Prisma's explicit
      MUST NOT, learned the hard way).
- [x] A table's status is table-anchored: only field/index changes mark it
      `changed`. A relation-only change surfaces through the edge, so the amber
      signal stays synonymous with "this table's shape changed".
- [x] Detail panel under the canvas: the `DriftChange[]` list with its
      `safe`/`breaking` classification — the same verdict `lunora deploy` gates
      on, so the UI and the gate can never tell different stories.

## Phase 4 — Correlate data migrations

- [x] Join the existing `migrationStatus` rows onto the timeline by
      `appliedAt` window: under each schema version, the data migrations that ran
      after it, with their processed/changed counts and status.
- [x] Flag the footgun the deploy gate already knows about: a `breaking` version
      with no data migration recorded in its window.
- [x] Keep the run form (it is the panel's only _action_) — move it into the
      version detail rather than the page root.

## Exit criteria

- A dev who changes `defineSchema`, restarts, and opens Studio sees two versions
  on the timeline and a canvas showing exactly what changed.
- The classification shown matches `lunora deploy`'s gate verdict for the same
  pair of snapshots (one shared implementation, asserted by a test).
- Unit tests: ledger append/dedup-by-hash/prune; diff → canvas node status
  mapping; the empty/absent/legacy-worker states.
- A database with no history hides the nav item; a stale URL shows the empty state.
- No regression in `runShardMigrations` cold-start cost — the added work is one
  hash comparison against one indexed row.

## Implementation notes (2026-07-28)

- **`shared/` inlining worked** — the STOP condition did not fire. `@lunora/codegen`
  and `@lunora/studio` both import `shared/schema-snapshot.ts` by relative path;
  both tsconfigs already dropped `outDir`/`rootDir` for prior shared helpers.
- **Snapshot size** did not force the second STOP either: the `simple` fixture's
  schema (5 tables) serializes to ~3 KB, embedded in the generated shard as one
  string literal. Recomputing it in the DO instead would need a second snapshot
  builder over the runtime `SchemaLike`, and two builders would eventually
  disagree with the deploy gate — the bundle bytes are the cheaper trade.
- **`DriftChange` gained an optional `table` field** so the canvas can group
  changes per table without parsing `summary` prose. Two `toStrictEqual`
  assertions in `codegen/__tests__/schema-drift.test.ts` were updated.
- **Phase 4 correlation is page-level, not merged.** The Migrations route now
  renders "Schema versions" above "Data migrations". They stay two sections
  because they are two different things — merging them into one timeline would
  imply a causal link the data does not carry.
- **Deviation from Phase 3:** the diff renders on the EXISTING `SchemaDiagram`
  via a new optional `nodeClasses` prop (per-table CSS classes) rather than a
  forked canvas. Same layout, same export, one component to maintain. Stable
  node ids come for free, so switching versions swaps arrays in place — the
  "MUST NOT key the canvas by version id" rule holds by construction.

## Review corrections (thermo pass, 2026-07-28)

- **The examples' regeneration silently dropped every schema advisory.** All 8
  `_generated/shard.ts` were regenerated against a stale `@lunora/advisor` dist
  and emitted `LUNORA_ADVISORIES: AdvisoryFinding[] = []`, blanking their Studio
  Advisors pages — the entire −1272-line half of the diff. Rebuilt and
  regenerated; the net per-example diff is now `+4/−1`, exactly the snapshot.
- **`sortKeys` broke the studio bundle.** A generic arrow (`<T>(…) =>`) in a
  `.ts` file parses as JSX under packem's Babel config. It was fine inside
  `@lunora/codegen`; moving it to `shared/` put it in the studio bundle, which
  had not built since. `tsc`, ESLint and 4000+ tests all passed regardless — only
  `pnpm run build:packages` catches this class of break, so run it.
- **`TABLE_ANCHORED` lived in the Studio**, a hand-maintained set of change-type
  names 5 directories from the union it tracked, with zero compile-time pressure.
  Adding a variant would silently render an affected table as untouched — the
  exact UI-vs-gate divergence the `shared/` extraction exists to prevent. The
  diff engine now stamps `scope: "table" | "schema"` at construction.
- **The re-export shim in `schema-drift.ts` had already caused drift** — `emit.ts`
  imported from `shared/` while `run-codegen.ts` went through the shim. Shim
  deleted; the package barrel is the one place that re-exports both.
- **`historyQuery.error` was swallowed**, so an unreachable RPC rendered "No
  schema versions recorded yet" — asserting something about the database the
  Studio did not know. Failures now surface as failures.
- The three new admin reads moved out of `shard-do.ts`'s 64-arm dispatch chain
  into a lookup table (`schema-history-reads.ts`), and the untranslated
  `<h2>` headings moved into a real `MigrationsRoutePanel` component that can
  call `useT()`.

## STOP conditions

- **If `shared/` cannot be inlined into the `packages/studio` bundle** (packem
  config, or the browser build rejecting the out-of-package path): stop and
  report. The fallback is a real `@lunora/schema-snapshot` package — a design
  change (new published package, new dependency edge), not an improvisation.
- **If snapshot size makes the ledger table impractical** for a wide schema
  (measure before Phase 3): stop and report. Options are storing a compressed
  snapshot, or storing only the diff per version with a periodic full snapshot —
  both change the read path.

## Non-goals

- Generating or applying DDL migrations. Lunora applies `defineSchema` at
  runtime; this plan visualizes what changed, it does not become a migration tool.
- Editing schema from the diff view (`SchemaEditorOverlay` already owns additive
  authoring, loopback-only).
- Cross-shard history reconciliation — the ledger is per shard, like every other
  reserved table. The panel shows the selected shard's history.
