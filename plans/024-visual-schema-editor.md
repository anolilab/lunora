# Plan 024: Visual schema editor (local-dev authoring over `schema.ts` + codegen)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This is a multi-item feature plan (like plans 022
> and 023): each numbered item under "Item breakdown" is its own PR. Execute
> them in order; later items soft-depend on the seam built in earlier ones.
> When an item is done, update its checkbox and the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 05a1e9fc..HEAD -- packages/config/src/studio-host packages/vite/src/studio-plugin.ts packages/cli/src/util/studio-server.ts packages/studio/src/features/schema packages/studio/scripts/build-standalone.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 (high-value DX; the single most-requested studio affordance
  d1-manager has that Cirrus lacks)
- **Effort**: L (new local write-back endpoint on two dev hosts + a shared
  ts-morph mutation layer + studio editor UI + capability-flag plumbing)
- **Risk**: MEDIUM. The editor mutates the developer's `cirrus/schema.ts` source
  and re-runs codegen. Additive edits are safe; **destructive edits change the
  DO's persisted SQLite shape and must route through migrations, never silent
  DDL.** The whole feature is local-dev-only and capability-gated, so a static /
  remote deploy is unaffected.
- **Depends on**: none. Reuses the established `StudioHtmlConfig` capability-flag
  pattern (plan-era `dataEditable` / `runAsIdentity`) and the existing schema
  diagram (plans 020/021).
- **Category**: feature / borrow (d1-manager)
- **Planned at**: commit `05a1e9fc`, 2026-06-15

## Verdict on the borrow

**Source**: `d1-manager` (MIT, copy-eligible) — see `ECOSYSTEM-BORROW.md` and
plan 022. d1-manager gives D1 a visual table/column authoring UI: click to add a
table, add columns with types, see the schema as a canvas, and it issues the
`CREATE TABLE` / `ALTER TABLE` DDL live against the database.

**What we borrow**: the _interaction model_ only — visual table/column authoring
laid over the schema diagram. **What we do NOT borrow**: the live-DDL mechanism.
d1-manager edits the database directly; Cirrus's source of truth is
`cirrus/schema.ts` → `@cirrus/codegen` → `_generated/*`, and the DO's SQLite
shape is derived from the generated schema. There is **no live DDL** in Cirrus
and this plan does not add any. The editor instead:

1. edits `cirrus/schema.ts` **source** via ts-morph (AST edits that preserve
   formatting/comments — the same approach `vis generate cirrus-table` already
   uses), then
2. re-runs codegen, so the generated types + DO shape follow.

Because both steps need the project's filesystem and toolchain, the editor is
**local-dev-only** and runs on the Node dev host (the `@cirrus/vite` `/__cirrus`
middleware and the `cirrus dev` studio server), **never on the worker**. A
deployed worker has no source tree and must not be writable; a static studio
deploy leaves the capability off and the diagram stays read-only (today's
behaviour, plans 020/021).

## Why this matters

The schema diagram (plans 020/021) is read-only: it visualises tables, typed
columns, and FK edges, but a developer who wants to add a column still hand-edits
`schema.ts`. d1-manager's authoring UI is the headline feature that makes its
studio feel like a database tool rather than a viewer. Cirrus can offer the same
ergonomics **without** abandoning codegen-as-source-of-truth — by writing back to
source and regenerating. That keeps types, the client API, and the DO shape in
lock-step (which live DDL would silently desync) while giving the diagram a
"click to add table / add column" affordance.

## Design decisions (already scoped)

- **Local-only, capability-gated.** A new `schemaEditable` flag in
  `StudioHtmlConfig`, injected as `window.__CIRRUS_SCHEMA_EDITABLE__=true` **only
  by the loopback dev hosts** (mirroring `dataEditable` / `runAsIdentity`). The
  studio renders the editor controls only when the flag is set; otherwise the
  diagram is read-only. The flag is necessary but not sufficient — the actual
  write goes to a local endpoint that only the dev hosts mount, so a remote
  studio pointed at a deployed worker has nowhere to send the edit even if the
  flag were forced on.
- **Source-of-truth = `cirrus/schema.ts`.** The editor reads the _source_ schema
  shape (validators, `shardBy`, indexes) — not the DO's runtime columns the
  diagram probes — and writes back to source. Reading source live needs the file,
  so it goes through the same local endpoint (a `GET`), not the worker.
- **Write path = ts-morph + codegen, on the dev host.** A new shared handler in
  `@cirrus/config/studio-host` applies the requested mutation with ts-morph
  (extending the existing `_helpers/insert-table.ts` / `parse-schema.ts`
  approach into a package module) and then calls `runCodegen` from
  `@cirrus/codegen`. The handler returns the new parsed schema + any codegen
  diagnostics.
- **Additive vs destructive.** Only **additive** edits apply directly:
    - add a table,
    - add an **optional** column to a table (`v.optional(...)`),
    - add an index.

    **Destructive** edits — rename column, drop column, drop table, change a
    column's validator/type, or make a column required — change the persisted
    SQLite shape and need a data migration. The editor **must refuse to silently
    apply these**; it routes them to the migrations workflow
    (`features/database/migrations.tsx` + `cirrus migrate`) by scaffolding a
    migration stub and surfacing it, then lets the developer run it. This is a hard
    STOP condition if attempted any other way.

- **No live DDL, ever.** Nothing in this plan issues SQL DDL to a DO or to D1.
- **Scope of the editor UI**: lives next to the existing schema diagram
  (`packages/studio/src/features/schema/`), as an authoring overlay on the
  read-only diagram. It is not a separate top-level tab.

## Current state

### Capability-flag seam (the pattern to extend)

`packages/config/src/studio-host/types.ts` — `StudioHtmlConfig` declares the
loopback-only flags (`dataEditable`, `runAsIdentity`, `rulesInstalled`). Each is
injected as a `window.__CIRRUS_*__` global.

`packages/config/src/studio-host/render-html.ts` (lines 22–43) — pushes the
inline-script assignments; e.g.:

```ts
if (config.dataEditable === true) {
    settings.push("window.__CIRRUS_DATA_EDITABLE__=true;");
}
if (config.runAsIdentity === true) {
    settings.push("window.__CIRRUS_RUN_AS_IDENTITY__=true;");
}
```

`packages/config/src/studio-host/index.ts` — re-exports `renderStudioHtml`,
`StudioHtmlConfig`, `resolveAdminToken`, `loadStudioAssets`, `studioAssetsStamp`.

`packages/studio/scripts/build-standalone.mjs` (lines 27–41) — the synthetic
boot entry reads the globals and forwards them as props:

```js
"  studio: { dataEditable: g.__CIRRUS_DATA_EDITABLE__ === true, runAsIdentity: g.__CIRRUS_RUN_AS_IDENTITY__ === true },",
"  rulesInstalled: g.__CIRRUS_RULES_INSTALLED__ !== false,",
```

The prop then flows `mountStudio` → `StudioApp` (`app/app.tsx`) → `Studio`
(`app/studio.tsx`, which already destructures `dataEditable` / `runAsIdentity`
and passes them to feature components, e.g. `TableEditor editable={dataEditable}`
and `FunctionRunner runAsIdentity={runAsIdentity}`).

### Dev hosts that inject the flags + mount routes

`packages/vite/src/studio-plugin.ts` — Connect middleware owns `/__cirrus` and
everything under it (`STUDIO_PATH = "/__cirrus"`). `createStudioHandler` builds
the HTML once with `renderStudioHtml({ … dataEditable: true, runAsIdentity: true,
… })` (lines 139–149) because the route 403s on a non-loopback bind
(`isNonLoopbackBind`, lines 97–103). Static asset paths are
`/__cirrus/studio.js` and `/__cirrus/styles.css`; every other sub-path is the SPA
history fallback. **There is no `POST` handling and no local-action endpoint
today** — this is where the schema-edit endpoint is added.

`packages/cli/src/util/studio-server.ts` — `node:http` server. **Reverse-proxies
`/_cirrus/*` (HTTP + WS) to the worker** (`PROXY_PREFIX = "/_cirrus"`), serves
`/studio.js` + `/styles.css`, SPA-fallbacks the rest. `renderStudioHtml({ …
dataEditable: isLoopback, runAsIdentity: isLoopback, … })` (lines 122–130). A new
local endpoint here must use a prefix that does **not** collide with
`/_cirrus/*` (which is proxied to the worker) — use the studio mount-relative
path so it is unambiguous.

### Codegen entry

`packages/vite/src/codegen-plugin.ts` (line 4, 108) — imports `runCodegen` from
`@cirrus/codegen` and calls
`runCodegen({ apiSpec, cirrusDirectory, project, projectRoot })`. The same entry
the schema-edit handler will call after a successful ts-morph mutation.
`CodegenDiagnosticError` is the typed error to catch and surface.

### Existing ts-morph schema helpers (to promote into a package module)

`.vis/templates/_helpers/insert-table.ts` — `insertTableIntoSchema(source,
tableName)`: finds the `defineSchema({ … })` call, guards duplicates /
non-object-arg / missing call, `addPropertyAssignment` a new
`<name>: defineTable({ … })`. Returns a tagged result.

`.vis/templates/_helpers/parse-schema.ts` — `parseSchemaTables(source)`:
enumerates tables, `shardBy(field)`, and column names from `defineTable({ … })`.
**These are the seed** — but they live under `.vis/templates/_helpers` (vis
template scope) and only cover _table_ add + a shallow parse. This plan needs a
proper module under `@cirrus/config` (or a new tiny internal module) that also:
adds an optional column, adds an index, and parses column **validator
expressions** (not just names). Do NOT import from `.vis/templates` at runtime —
that directory is template tooling, not a published surface. Re-implement (or
move) the logic into the package, citing these as the reference.

### Schema feature (the editor's home)

`packages/studio/src/features/schema/` — `schema-viewer.tsx` (probes the DO for
live columns per shard, plans 020/021), `schema-diagram.tsx` (React Flow canvas),
`database-schema-node.tsx` (per-table node), `layout.ts`. The editor overlay
attaches here. `migrations.tsx` lives in `features/database/` and drives the
`__cirrus_admin__:runMigration` RPC — this is the destructive-edit handoff
target.

## Commands you will need

| Purpose       | Command                                             | Expected |
| ------------- | --------------------------------------------------- | -------- |
| Build deps    | `pnpm run build:packages`                           | exit 0   |
| config tests  | `pnpm --filter "@cirrus/config" run test`           | all pass |
| config types  | `pnpm --filter "@cirrus/config" run lint:types`     | exit 0   |
| vite tests    | `pnpm --filter "@cirrus/vite" run test`             | all pass |
| vite types    | `pnpm --filter "@cirrus/vite" run lint:types`       | exit 0   |
| cli types     | `pnpm --filter "@cirrus/cli" run lint:types`        | exit 0   |
| studio build  | `pnpm --filter "@cirrus/studio..." run build`       | exit 0   |
| studio tests  | `pnpm --filter "@cirrus/studio" run test -- schema` | all pass |
| studio types  | `pnpm --filter "@cirrus/studio" run lint:types`     | exit 0   |
| eslint (each) | `pnpm --filter "<pkg>" run lint:eslint`             | exit 0   |

Build dependencies once (`pnpm run build:packages`) before any filtered
test/types — repo convention (plan 016). Note: workerd-dependent DO/runtime
tests cannot run in the sandbox; this feature touches none of them (the write
path is Node + studio React only).

## Scope

**In scope** (the files items below may add/modify):

- `packages/config/src/studio-host/types.ts` — add `schemaEditable?: boolean` to
  `StudioHtmlConfig`.
- `packages/config/src/studio-host/render-html.ts` — inject
  `window.__CIRRUS_SCHEMA_EDITABLE__=true` when set.
- A new shared schema-mutation module (Item 2) — ts-morph add-table /
  add-optional-column / add-index + a validator-aware parser; classifies an edit
  request as additive vs destructive.
- A new shared schema-edit request handler (Item 3) callable from both dev hosts:
  `GET` current parsed schema; `POST` an **additive** edit → ts-morph + codegen;
  reject destructive edits with a typed "needs migration" response.
- `packages/vite/src/studio-plugin.ts` — mount the local schema-edit endpoint
  under `/__cirrus` (loopback-gated already), inject `schemaEditable: true`.
- `packages/cli/src/util/studio-server.ts` — mount the same endpoint (distinct
  from the `/_cirrus/*` worker proxy), inject `schemaEditable: isLoopback`.
- `packages/studio/scripts/build-standalone.mjs` — forward
  `schemaEditable: g.__CIRRUS_SCHEMA_EDITABLE__ === true`.
- `packages/studio/src/app/{app,studio}.tsx` — thread `schemaEditable` to the
  schema feature.
- `packages/studio/src/features/schema/*` — the authoring overlay + the client
  that calls the local endpoint.
- `packages/studio/src/locales/en.ts` — new strings.
- Tests alongside each.

**Out of scope** (do NOT touch):

- Any DO / worker / runtime code. No live DDL. No new admin RPC. The worker is
  not involved in the edit path.
- The `.vis/templates/_helpers/*` files (reference only; do not import at
  runtime, do not refactor them as part of this plan).
- The actual migration _execution_ engine — this plan only hands destructive
  edits **off** to the existing `migrations.tsx` / `cirrus migrate` surface; it
  does not build new migration machinery.
- Renaming/typing edits applied directly (those are the migration handoff, Item
  5, which scaffolds a stub — it does not apply the change to live data).

## Git workflow

- One branch per item, e.g. `feat/schema-editor-capability-flag`,
  `feat/schema-editor-mutation-core`, etc.
- Conventional commits, e.g.
  `feat(config): add schemaEditable studio capability flag`.
- Do NOT push or open a PR unless the operator instructed it.

## Item breakdown

Execute in order. Each is a shippable PR; later items soft-depend on the seam in
earlier ones.

- [x] **Item 1 — `schemaEditable` capability flag (config + boot + studio prop
      plumbing).** Add `schemaEditable?: boolean` to `StudioHtmlConfig`; inject
      `window.__CIRRUS_SCHEMA_EDITABLE__=true` in `render-html.ts`; read it in
      `build-standalone.mjs`; thread `schemaEditable` through `app.tsx` → `studio.tsx`
      to the schema feature (default `false`). No behaviour yet — the flag just
      arrives. Mirror the `dataEditable` plumbing exactly. **Tests**:
      `render-html.test.ts` asserts the assignment is emitted iff `schemaEditable`;
      studio test that the prop reaches the schema feature.
- [x] **Item 2 — shared schema-mutation core (ts-morph).** New module (e.g.
      `packages/config/src/schema-edit/mutate.ts` + `parse.ts`) that: parses
      `schema.ts` into `{ table, columns: {name, validator}[], shardBy, indexes }[]`
      (validator-aware, extending `parse-schema.ts`); and applies an additive edit
      (`addTable`, `addOptionalColumn`, `addIndex`) preserving formatting (extending
      `insert-table.ts`). Plus `classifyEdit(request)` → `"additive" | "destructive"`
      with the destructive set (rename/drop/type-change/required). Pure string-in /
      string-out (in-memory ts-morph project), unit-tested with fixtures. No I/O, no
      codegen here.
- [x] **Item 3 — local schema-edit endpoint (shared handler + both dev hosts).**
      A shared request handler in `@cirrus/config/studio-host` that, given the
      project root: `GET` → parse `cirrus/schema.ts` and return the structured
      schema; `POST` additive → apply via Item 2, write the file atomically, run
      `runCodegen`, return the new schema + diagnostics; `POST` destructive →
      `409`-style typed response `{ needsMigration: true, … }` (no file write). Mount
      it in `studio-plugin.ts` (under `/__cirrus`, already loopback-gated) and in
      `studio-server.ts` (a path that does NOT start with `/_cirrus`, since that is
      proxied to the worker — use the studio mount-relative path). Inject
      `schemaEditable` `true` (vite) / `isLoopback` (cli). **Tests**: handler unit
      tests with a temp project dir (additive applies + regenerates; destructive
      rejected without writing); a vite-plugin test that the route is mounted and
      403s on non-loopback bind like the rest of `/__cirrus`.
- [x] **Item 4 — studio authoring overlay (additive edits).** In
      `features/schema/`, when `schemaEditable`, render add-table / add-column /
      add-index controls over the diagram; a small client that calls the local
      endpoint (Item 3) — NOT the worker admin RPC. On success, refresh the diagram
      (re-probe). Column-type palette uses the `v.*` validators. Optimistic-free:
      show the codegen result/diagnostics. When the flag is off, nothing renders
      (today's read-only diagram). **Tests**: overlay renders only when
      `schemaEditable`; a mocked endpoint success path adds a table to the rendered
      schema; a diagnostics path surfaces the error.
- [x] **Item 5 — destructive-edit → migration handoff.** When the user requests
      a rename/drop/type-change/required edit, the overlay does NOT call the additive
      endpoint; instead it scaffolds a migration (surface the `needsMigration`
      response from Item 3, which can include a suggested migration stub) and links
      to the Migrations panel (`features/database/migrations.tsx`) / instructs
      `cirrus migrate`. Explicit copy: "this changes stored data — review the
      migration before applying." **Tests**: a destructive request never hits the
      additive write path and shows the migration handoff UI.

## Steps (Item 1 — do this first, in full)

> Items 2–5 are scoped above; expand each into steps when you start it, following
> the same verify-after-every-change discipline. Item 1 is fully spelled out here
> because it establishes the seam and is the smallest safe first PR.

### Step 1.1: Add the flag to `StudioHtmlConfig`

In `packages/config/src/studio-host/types.ts`, add after `runAsIdentity` (keep
the existing doc-comment style):

```ts
/**
 * Enable the visual schema editor (add table / column / index, written back to
 * `cirrus/schema.ts` + codegen). Injected as `window.__CIRRUS_SCHEMA_EDITABLE__`.
 * Like {@link StudioHtmlConfig.dataEditable}, only the loopback-only dev hosts
 * set this — editing source + running codegen needs the project's filesystem and
 * toolchain, so a static deploy leaves it off and the diagram stays read-only.
 */
readonly schemaEditable?: boolean;
```

### Step 1.2: Inject the global in `render-html.ts`

After the `runAsIdentity` block (line ~37):

```ts
if (config.schemaEditable === true) {
    // eslint-disable-next-line no-secrets/no-secrets -- a static JS assignment string, not a credential
    settings.push("window.__CIRRUS_SCHEMA_EDITABLE__=true;");
}
```

**Verify**: `pnpm --filter "@cirrus/config" run lint:types` → exit 0.

### Step 1.3: Read the global in the boot entry

In `packages/studio/scripts/build-standalone.mjs`, extend the `studio:` object
literal (line ~36) to include the new flag:

```js
"  studio: { dataEditable: g.__CIRRUS_DATA_EDITABLE__ === true, runAsIdentity: g.__CIRRUS_RUN_AS_IDENTITY__ === true, schemaEditable: g.__CIRRUS_SCHEMA_EDITABLE__ === true },",
```

### Step 1.4: Thread the prop through the studio app

Mirror `dataEditable` exactly in `packages/studio/src/app/studio.tsx` (the
`StudioProps`-ish interface around lines 110/150, the destructure at ~766/771,
and the `useMemo` wiring at ~861/878/888) and in `packages/studio/src/app/app.tsx`
(~311/316). For now, pass `schemaEditable` down to wherever the schema feature is
rendered (default `false`). If the schema feature doesn't yet accept a prop, add
an optional `schemaEditable?: boolean` to its props as a no-op placeholder (Item
4 consumes it).

**Verify**:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run lint:types` → exit 0

### Step 1.5: Tests for Item 1

- `packages/config/__tests__/studio-host/render-html.test.ts`: add a case that
  `schemaEditable: true` emits `window.__CIRRUS_SCHEMA_EDITABLE__=true;` and that
  it is absent when unset/false (match the existing `dataEditable` test).
- Studio: a test that the prop arrives at the schema feature (mirror the existing
  `dataEditable` prop test if one exists; otherwise assert the `Studio`
  memo/props include it).

**Verify**:

- `pnpm --filter "@cirrus/config" run test` → pass
- `pnpm --filter "@cirrus/studio" run test -- schema` → pass

### Step 1.6: Full gate (Item 1)

**Verify** all of:

- `pnpm run build:packages` → exit 0
- `pnpm --filter "@cirrus/config" run test` and `… run lint:types` → exit 0
- `pnpm --filter "@cirrus/studio..." run build` → exit 0
- `pnpm --filter "@cirrus/studio" run lint:types` and `… run lint:eslint` → exit 0
- `git grep -n "schemaEditable\|__CIRRUS_SCHEMA_EDITABLE__" packages/config/src packages/studio/src packages/studio/scripts`
  shows the flag threaded config → boot → app.

## Test plan

- **Item 1**: `render-html` emits the global iff `schemaEditable`; prop reaches
  the schema feature.
- **Item 2**: ts-morph fixtures — add table / add optional column / add index
  round-trip and preserve formatting; `classifyEdit` labels the destructive set
  correctly; duplicate/missing-`defineSchema` guarded like `insert-table.ts`.
- **Item 3**: temp-project handler tests — additive applies + regenerates +
  returns new schema; destructive rejected with `needsMigration` and **no file
  write**; route is loopback-gated on both hosts; CLI path does not collide with
  `/_cirrus/*`.
- **Item 4**: overlay renders only when `schemaEditable`; success adds a table to
  the diagram; codegen diagnostics surface.
- **Item 5**: destructive request never writes; shows the migration handoff.

## Done criteria

Machine-checkable. ALL must hold when the plan is complete (per-item subsets gate
each PR):

- [x] `pnpm run build:packages` exits 0
- [x] `pnpm --filter "@cirrus/config" run test` + `lint:types` exit 0
- [x] `pnpm --filter "@cirrus/vite" run test` + `lint:types` exit 0
- [x] `pnpm --filter "@cirrus/cli" run lint:types` exits 0
- [x] `pnpm --filter "@cirrus/studio..." run build` exits 0
- [x] `pnpm --filter "@cirrus/studio" run test -- schema` exits 0 (all 490
      studio tests pass; the schema/overlay suites are green)
- [x] `pnpm --filter "@cirrus/studio" run lint:types` exits 0; `lint:eslint` is
      clean on every file this plan touched. The studio `eslint .` aggregate
      still exits 1 from 3 PRE-EXISTING errors in untouched files
      (`features/data/data-browser.tsx`, `features/data/hooks/use-mask-policies.ts`,
      `lib/mask-preview.ts`) — debt that predates this plan, to be cleared in a
      separate refactor commit per repo convention.
- [x] `git grep -n "__CIRRUS_SCHEMA_EDITABLE__"` shows it injected (render-html),
      read (build-standalone), and gated in the studio overlay
- [x] No new admin RPC, no DDL: `git grep -n "ALTER TABLE\|CREATE TABLE" packages`
      shows no new occurrences from this plan
- [x] `plans/README.md` status row for 024 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match the live code (drift since
  `05a1e9fc`) — especially if the boot-entry / capability-flag seam in
  `build-standalone.mjs` or `render-html.ts` has changed shape.
- An additive edit cannot be expressed as a safe ts-morph mutation that
  round-trips the existing file's formatting (e.g. the project's `schema.ts` uses
  an aliased `defineSchema` import, which `insert-table.ts` already documents as
  unsupported) — surface it as an unsupported-edit response; do NOT fall back to
  a regex rewrite of source.
- The work would require issuing live DDL, a new worker/DO admin op, or making a
  deployed worker's schema writable — that contradicts the codegen-source-of-truth
  design; STOP.
- A destructive edit (rename/drop/type-change/required) would be applied directly
  to `schema.ts` + codegen without the migration handoff — STOP; destructive
  edits route through Item 5 only.
- The CLI local endpoint path would collide with the `/_cirrus/*` worker proxy —
  pick a non-colliding path under the studio mount; do NOT proxy schema edits to
  the worker.

## Maintenance notes

- The flag is **loopback-only** by construction (both dev hosts already 403 /
  read-only on non-loopback binds). If a future host sets `schemaEditable` on a
  non-loopback bind, that is a security regression — keep the injection tied to
  the same condition as `dataEditable`/`runAsIdentity`.
- The ts-morph mutation core (Item 2) intentionally re-implements the logic that
  `.vis/templates/_helpers/{insert-table,parse-schema}.ts` prototype. If those
  templates and this module drift, prefer consolidating the templates onto the
  package module (templates may import a published `@cirrus/config` surface);
  do not make the package import from `.vis/templates`.
- Additive-only direct apply is a deliberate safety boundary. Expanding the
  additive set (e.g. "add a non-optional column with a default") requires proving
  the DO's derived SQLite shape change is backfillable without a migration —
  treat any such expansion as a new design decision, not a tweak.
- This plan borrows d1-manager's **interaction model** under MIT (copy-eligible),
  but copies **no** DDL mechanism — the write path is Cirrus-native
  (source + codegen). Keep that distinction in any future doc/marketing.
