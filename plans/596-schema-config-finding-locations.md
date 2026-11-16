# Plan 596 — Schema and config findings carry a source location

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report — do
> not improvise. A reviewer dispatched you and maintains `plans/README.md`; do not edit it.
>
> **Drift check (run first)**: the branch is stacked on plan 595's branch. `git log --oneline -3`
> shows 595's commits on top of `4121b67cc`; `git diff --stat HEAD~N..HEAD` (N = 595's commit count)
> lists only 595's files. Nothing else changed under `packages/codegen/src/discover/schema` or
> `packages/advisor/src/lints/static` since `4121b67cc`.

**Baseline:** plan 595's branch tip `a75902bbb` (2026-11-12)
**Status:** DONE — APPROVED after a Step-0 STOP and reviewer clarifications (§5); PR https://github.com/anolilab/lunora/pull/1586 (commits `100010eb2`, `b4d998d68`, `74cbb5d55`, `c034e48d4`, `daf7fc8da`). Without a location: `notify_missing_push_config`; tables/indexes from installed-package extensions.
**Source:** follow-up to row 50 of the 2026-11-11 audit; second PR of the stack (595 → 596 → 597 → 588).

## Status

- **Priority**: P2 · **Effort**: M–L · **Risk**: LOW (adds fields; no rule fires differently) · **Depends on**: plan 595 · **Category**: tech-debt (enabler)

## 0. Headline

Twenty-one static lints describe a schema object (table, index, field, relation) or a config entry and
report no source location, so plan 597's directive (rule id + file + line span) cannot match them.
This plan records where each object is declared and copies it into `metadata.file` / `metadata.line`,
the keys the other 95 lints already use after plan 595. Objects with no source site in the app keep no
location and are listed (§4) — the one allowed carve-out.

## 1. Current state (audit)

Lints and their evidence (`packages/advisor/src/lints/static/<name>.ts`):

- **Schema (`context.schema`, type `AdvisorSchema` in `packages/advisor/src/types.ts`)**: commit-ordered-hard-delete,
  empty-index, external-source-on-global, fk-index (reads the schema through a helper — check), duplicate-index,
  geo-index-field-not-geopoint, external-source-incremental-no-delete-path, geo-index-unused (+ `geoIndexUsages`),
  global-table-near-column-limit, index-references-unknown-field, public-table-rls-optout-confusion,
  relation-references-unknown-table, relation-references-unknown-field, table-without-insert (+ `inserts`,
  `tableWrites`), ttl-field-not-timestamp, unindexed-relation-target, through-relation-missing-unique-index.
- **Config**: notify-missing-push-config (`context.notifyConfig`), plaintext-secret-in-wrangler-variables
  (`context.wranglerVariables`, rows already carry `file`, not `line`).
- **Declaration left over from plan 595**: topic-too-many-subscriptions (keyed to a `defineTopic` export; its evidence has no row with a location — add the topic's declaration `file`/`line` the way plan 595 did for queues, using `declarationLineOf` from `packages/codegen/src/discover/ast.ts` and `declarationSiteFields` from `packages/advisor/src/lints/helpers.ts`).
- **Write-derived**: cross-module-table-write (`inserts`, `tableWrites`, `modules`; those rows carry `file`/`line`).
- Schema discovery is AST-based: `packages/codegen/src/discover/schema/index.ts` (`parseBaseTables` over the
  `defineSchema(...)` argument, `applyExtensions` for chained `.extend(...)`), helpers in
  `discover/schema/internal/{table-builder,properties,extensions}.ts`; IR types in `packages/codegen/src/ir/schema.ts`
  (`TableIR`, index/field/relation IR). The advisor schema is built from that IR (find the converter:
  `grep -rn "AdvisorSchema" packages/codegen/src`). At runtime the Studio builds an `AdvisorSchema` without source
  (`fromServerSchema`), so every new field is optional.

## 2. Design decisions

- **One location shape**: optional `file` (relative to `lunora/`, no extension — same as call-site findings) and
  `line` (1-based start line of the node, `node.getStartLineNumber()`, leading comments excluded) on each schema IR
  object, carried into `AdvisorSchema` (`AdvisorTable`, its index, field and relation entries) and copied by each lint
  into `metadata.file`/`metadata.line` when present.
- **Which node** (record the node the IR row is actually built from, so helpers and spreads resolve naturally):
  table → the `defineTable(...)` call expression; index → the `.index(...)` / `.searchIndex(...)` / `.vectorIndex(...)` /
  `.geoIndex(...)` / `.rankIndex(...)` call (or the standalone `define*Index(...)` call); field → the property assignment
  in the `defineTable({...})` object; relation → the relation's call/property node. A table that reaches the schema through
  a `const` or a spread in another `lunora/` file gets that file and line.
- **No site in the app → no location**: objects contributed by an installed package's extension (`.extend(pkg.extension)` whose
  table definitions live under `node_modules`), and anything synthesised by codegen. Their lints keep reporting without a
  location; plan 597 reports a directive naming such a finding as WARN.
- **Config**: `plaintext_secret_in_wrangler_variables` → the 1-based line of the key inside `wrangler.jsonc` (file reported as
  `wrangler.jsonc`, relative to the project root — note the different base in the JSDoc); compute it from the JSONC text with the
  parser the reader already uses, or `jsonc-parser`'s offsets if available in the workspace (catalog), never by regex.
  `notify_missing_push_config` → the start line of the config call it is read from (find in `discover/config-calls.ts` or the notify
  feeder). If that rule's evidence is not a single call, leave it without a location and list it.
- **cross_module_table_write**: one finding per (table, module) as today; its location is the first of its write rows by
  (file, line) order. Rejected: one finding per write site (changes finding counts).
- **cacheKey unchanged** everywhere.
- Rejected: parsing the schema at runtime for positions; storing a separate location map beside the IR.

## 3. Steps

### Step 0 — verify per rule (write the table into your report)

For each of the 21 lints, name the IR object it reports and the source node per §2, or "no site" with the reason. If a rule's
object is built in a way §2 does not cover (e.g. a table whose definition the schema discoverer reads from something other
than a `defineTable` call node), STOP and report the cases.

### Step 1 — schema IR locations

Record `file`/`line` in the schema discoverer for tables, indexes, fields, relations; extend the IR types and `AdvisorSchema` types
(optional fields, one-line JSDoc each); carry them through the converter.
**Verify**: codegen and advisor `lint:types` exit 0; `pnpm --filter "@lunora/codegen" exec vitest run __tests__/discover` passes.

### Step 2 — config locations

`wranglerVariables` rows gain `line`; notify config gains `file`/`line` if §2 applies.

### Step 3 — lints copy the location

Each of the 21 lints adds `file`/`line` to `metadata` when defined. No other change.

### Step 4 — tests (red without the fix)

- codegen: a fixture schema with a JSDoc'd table, a table defined in a `const` in another `lunora/` file and spread in, an index,
  a field and a relation, asserting each recorded `file`/`line`; a wrangler.jsonc fixture asserting a key's line (model after the
  existing discoverer tests).
- advisor: one test per lint family (table, index, field, relation, wrangler, notify, cross-module) asserting `metadata.file`/`line`.
- Red: restore the baseline sources (`git show a75902bbb:<path> > <path>`), new tests FAIL; restore; pass.

### Step 5 — goldens and generated output

Run `pnpm --filter "@lunora/codegen" run test`. If a golden changes only by gaining these fields, STOP and report (reviewer regenerates
through `packages/codegen/__tests__/capture-expected.ts`). Do not run codegen in `examples/`.

### Step 6 — gates, commits

codegen and advisor `lint:eslint`, `lint:types`, `test` exit 0; oxfmt. Commits: `feat(codegen): record source sites for schema objects`,
`feat(codegen): record the wrangler.jsonc line of a variable`, `feat(advisor): report source locations on schema and config findings`.

## Scope

In: `packages/codegen/src/discover/schema/**`, `packages/codegen/src/ir/schema.ts`, the schema → advisor converter, the wrangler-variable
and notify-config readers, `packages/advisor/src/types.ts` (+ row type files), the 20 lints, their tests. Out: cacheKeys, rule levels and
wording, CLI/Studio/MCP, apps.

## STOP conditions

- Step 0 finds a construction §2 does not cover.
- Any emitted `_generated` runtime code changes (beyond `LUNORA_ADVISORIES`).
- A golden changes.
- A verification fails twice.

## 4. Rules expected to stay without a location

Filled in from Step 0's report by the reviewer. Expected: findings about tables/indexes contributed by an installed package's extension,
and `notify_missing_push_config` if its evidence is not one call.

## 6. Platform parity

Not applicable.

## 5. Clarifications after the executor's Step 0 (reviewer, 2026-11-12)

- A table whose `defineSchema` property initializer is not a `defineTable(...)` chain (`users: usersTable`, `users: makeUsers()`)
  is located at that property assignment's start line; schema discovery is not changed. (Such a table is already discovered with
  no columns — a pre-existing bug reported separately.)
- Schema objects use `node.getStartLineNumber()` on the specific node, not `declarationLineOf` (which would climb to the
  `defineSchema` statement): table → `defineTable` call; index → the `.index`-family property-access name node or standalone
  `define*Index(...)` call; field → property assignment; relation → relation property.
- `topic_too_many_subscriptions` is in scope: topics gain a declaration site and reach `LintContext` under a new optional `topics` key.
- `notify_missing_push_config` stays without a location (its evidence spans the channel config and send sites, not one call).
- `cross_module_table_write` keeps its grouping and copies the location of the write row it is built from.
