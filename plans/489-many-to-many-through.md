# Plan 489 — Many-to-many relations through a join table (`r.many(..., { through })`)

**Baseline:** `f3915a2e4` (2026-10-13)
**Status:** DONE, awaiting merge (owner chose §4.1 option A; all phases shipped on `feat/many-to-many-through`, see §10)

## 0. Headline finding

A many-to-many link cannot be declared today. `r.one` and `r.many` describe a single foreign key, so a link
that needs a join table (`posts` ↔ `tags` through `post_tags`) is two one-to-many relations the caller walks by
hand, and nested relation writes (`connect`/`disconnect`/`set`) stop at one hop. Adding a third relation kind
touches reads, the generated types, cascade, the relation graph and the advisor, so it is a plan before it is
code.

## 1. Current state (audit)

- A relation is `{ field, kind: "one" | "many", references, table, onDelete? }` — one foreign key, one hop
  (`RelationDefinition`, `packages/server/src/types.ts:294`; builders in `packages/server/src/schema.ts`).
- The `with` loader resolves one hop per relation (`resolveWith`, `packages/shard-engine/src/relations.ts:190`), and
  relation predicates (`some`/`every`/`none`/`is`) compile to a single semijoin
  (`packages/shard-engine/src/relation-predicates.ts`).
- Nested writes (`connect`/`disconnect`/`set`) are composed in the table facade from the writer's own
  `get`/`patch`, over a per-relation descriptor the engine publishes (`describeRelationWrites`,
  `packages/shard-engine/src/relation-writes.ts`). They assume the foreign key lives on one of the two tables.
- `onDelete` cascades walk the same single-hop edge set (`applyOnDelete`, `packages/shard-engine/src/relations.ts:508`).
- Codegen emits `OneRelation<Target, Field>` / `ManyRelation<Target>` into `dataModel.ts`; the type machinery
  keys on `__relationKind: "one" | "many"`.

## 2. Existing seams (do not reinvent)

- `describeRelationWrites` already carries `field`, `references`, `nullable`, `colocated` per relation; a through
  relation is the same facts for two hops, with `colocated` true only if both hops are.
- The facade's `applyManys` (`packages/server/src/relation-writes.ts`) is the place a join-row write would plug in, so RLS, triggers and
  validators keep running per row.
- `with` already batches one `IN` query per hop; a through relation is two of them.
- The relation-graph edge set (`deriveRelationEdges`) is derived from `v.id("target")` columns; a join table is
  already two edges there.

## 3. The behavioural contract to preserve

- A table that declares no through relation compiles, generates and runs byte-for-byte as before (golden
  fixtures unchanged).
- `with`, relation predicates and cascade results for existing `one`/`many` relations do not change.
- Every join row is written through the bound writer, so a write policy on the join table gates it.

## 4. Design decisions

### 4.1 One new declaration, or a derived helper? (decided: A)

Owner decision: **option A**. `r.many(target, { through: { table, from, to } })`; `RelationDefinition` gains `through`.

- **A. `r.many(target, { through: { table, from, to } })`.** One declaration beside the others; the join table is
  named once. Needs a third relation kind in `RelationDefinition`, the generated types, `resolveWith`, relation
  predicates, cascade and the advisor.
- **B. Keep two one-to-many relations and add only a write helper** (`connect` through a named join table).
  Smaller, and reads stay two hops by hand; the typing gain is small.
- Recommendation: **A**, built in the order of §5, because reads are where a many-to-many hurts most. Needs the
  owner's call before work starts.

### 4.2 Duplicate and ordering semantics of the join rows (decided: the recommendations)

- A unique index on `(from, to)` makes `connect` idempotent and `set` a diff; without it a double `connect` is a
  second row. Recommendation: require the unique index at schema load, and reject a through relation without it
  (an advisor lint first, an error later).
- Extra columns on the join row (a role, an `addedAt`): `connect` can only write the two keys. Rows with extra
  required columns must be written directly. Recommendation: say so, do not add a payload form.

### 4.3 Cross-shard and `.global()` joins

Same rule as the one-hop writes: both the join table and the target must share the owner's backend and shard,
or the nested write is refused up front.

## 5. Workstreams

| Workstream | Size | Work                                                                                                                          |
| ---------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| A          | M    | `RelationDefinition` gains `through`; builder, `defineSchema` validation (join table exists, both keys are ids, unique index) |
| B          | M    | Codegen: emit the relation type with both targets; golden fixtures                                                            |
| C          | L    | Reads: `with` over two hops, `some`/`every`/`none` through the join, `_count`                                                 |
| D          | S    | Cascade: deleting either side removes its join rows (`onDelete` on the join relations)                                        |
| E          | S    | Writes: `connect`/`disconnect`/`set` insert and delete join rows through `applyToManyRelations`                               |
| F          | S    | Advisor lint for a through relation without a unique index; docs                                                              |

## 6. Platform parity

Adds relation declarations and reads over existing `ctx.db` SQL; no new `ctx.*` surface or binding. Join rows
are ordinary shard-local rows, so the mapping is the same on every target. If workstream C adds a SQL shape the
Postgres or MySQL `.global()` backends cannot run, that backend refuses it with `NOT_IMPLEMENTED`, as path
filters do. Not applicable otherwise.

## 7. Phasing & ordering

| Phase | Work        | Gate                                                                                                              |
| ----- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| 0     | Decide §4.1 | the owner's answer in this file (done: option A)                                                                  |
| 1     | A + B       | existing golden fixtures byte-identical; a new fixture with a through relation                                    |
| 2     | C           | a conformance table of `with`/predicate results over a seeded join, equal on node:sqlite, a Durable Object and D1 |
| 3     | D + E       | a rollback test: a failure partway through a `set` leaves the join rows as they were                              |
| 4     | F           | the lint fires on a fixture and not on the documented shape                                                       |

## 8. Risks & STOP conditions

- **STOP** if a through relation cannot be expressed with the two existing single-hop edges the relation graph and
  cascade already walk. A third edge shape touches `with`, predicates, cascade, the graph and the advisor at once;
  re-scope to a derived helper (§4.1) instead of improvising a new kind.
- **STOP** if the semijoin for a two-hop predicate needs more than 5 compound SELECTs or 100 bound parameters on
  workerd (the Durable Object and D1 limits). Chunk it, or refuse the predicate.
- **Risk:** a two-hop `set` releases and re-adds join rows one by one, so a failure partway through a long list
  leaves a partial join. Mitigate: the whole write runs in the mutation's transaction (shard-local join tables only,
  as with nested writes today), and an action refuses it.
- **Perf watch:** a `some`/`every` predicate through a join table. No relation-predicate bench exists yet in
  `packages/shard-engine/__bench__`; phase 2 adds one so the claim is measured, not assumed.

## 9. Open questions (answer during execution)

1. §4.1: **one new declaration**, `r.many(..., { through })` (owner decision).
2. §4.2: **duplicate join rows are not allowed**: `defineSchema` throws unless the join table has a unique index over exactly
   (`from`, `to`), and the `through_relation_missing_unique_index` advisor lint reports it at codegen time. A read does **not** order
   by the join row's creation: rows come back in the target read's order (its `orderBy`, else the table's default order).
3. **Inherit.** A through relation declares no `onDelete`; deleting either side cascades through the `onDelete` of the join table's
   own `r.one(...)` relations. No new knob.

## 10. Execution record

All of it landed on `feat/many-to-many-through`. It was started stacked on `feat/db-query-ergonomics`; #1144 merged into `alpha` while the work was in flight, so the branch was rebased onto `alpha` and the PR targets `alpha`.

### Shape of the change

- `RelationDefinition` (server), `RelationDefinitionLike` (shard-engine), `RelationIR` (codegen) and `AdvisorRelation` (advisor) are now
  **unions** of the single-key relation and a through relation. The through variant has **no `field`, `references` or `onDelete`**, so
  every unconditional `relation.field` read fails to compile until it narrows on `relation.through`; that is how the call sites were
  found. This is a breaking type change on the alpha line (recorded in `migrating/from-alpha.mdx` and the PR body).
- The through relation is emitted as an ordinary `ManyRelation<"tags">`. `WhereOf`, `LoadRelation` and `ToManyRelationWrite` already type
  that correctly, so **no emitted-template text changed**: every existing golden fixture and every `examples/*/lunora/_generated` is
  byte-identical (`git diff --stat` over them is empty; `pnpm run lint:generated` green).
- **Reads** (`shard-engine/src/relations.ts`): `with` is two batched hops (join rows under the join table's read policy, then targets under
  the target's), a `limit` fans out per parent on the same budget as `many`. `_count` counts **readable targets**, not join rows, so a
  hidden or dangling link is not counted.
- **Predicates** (`relation-predicates.ts`): `some`/`every`/`none` run the semijoin twice (targets matching W, or NOT W for `every`; then
  join rows pointing at them; then `_id in|notIn` the owners). A through node is **never** EXISTS-pushed, so `relationExistsPushDown:
"always"` cannot reach it, and a key set past `maxRelationKeys` fails closed. `assertShapeShardable` also checks the join table for
  `.shardBy()` / `.memory()`.
- **Writes** (`server/src/relation-writes.ts`): `connect` reads the targets (NOT_FOUND before any join row changes) and inserts only the
  missing links, `disconnect` deletes the links, `set` is a diff. Only the two keys are written. Refused up front with `UNPROCESSABLE`:
  a join table with another required column; an owner/join/target that do not share one tier; a masked `from`/`to`; and **an action**
  (the engine publishes a `refusalNow` that asks the writer's `inTransaction`; an engine that does not report its transaction state is
  not asked to refuse).
- **Schema load** (`defineSchema` and the plugin merge): the join table exists, `from`/`to` are required `v.id` columns pointing at the
  declaring table and the target, and a unique index over exactly the pair exists.
- **Advisor**: `through_relation_missing_unique_index` (ERROR, F), plus through branches in `relation_references_unknown_table`,
  `relation_references_unknown_field` (otherwise it fires on every through relation and fails codegen) and `unindexed_relation_target`
  (checks the join table's `from` column).

### Gates

| Phase | Gate                                                         | Result                                                                                                                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | goldens byte-identical, new fixture                          | 182 codegen test files (2 831 tests) green on the final tree with no fixture or example touched; new `codegen/__tests__/relation-through.test.ts`                                                                                                                                                                     |
| 2     | conformance table equal on node:sqlite, a Durable Object, D1 | `shard-engine/__tests__/_helpers/through-cases.ts` (11 cases + 4 wide) run by `ctx-db.relation-through.test.ts`, the `@lunora/d1` node harness, and `do/__tests__/workerd/relation-through.workerd.test.ts` (Durable Object) and `d1/__tests__/workerd/relation-through.workerd.test.ts` (real D1 binding) on workerd |
| 3     | a failed `set` leaves the join rows as they were             | `do/__tests__/workerd/relation-through-rollback.workerd.test.ts` (real `state.storage.transaction`; the same failure outside a transaction keeps the release, so the test can fail) and the in-process equivalent in `server/__tests__/relation-through.test.ts`                                                      |
| 4     | lint fires on a fixture, not on the documented shape         | `codegen/__tests__/relation-through.test.ts` and `advisor/__tests__/static-lints.test.ts`                                                                                                                                                                                                                             |

The advisor lint (F) was written in phase 1, not phase 4: without a through branch `relation_references_unknown_field` is an ERROR with no
opt-out and would fail codegen for every through relation.

Final tree, after the rebase onto `alpha`: `tsc --noEmit` clean in server, shard-engine, sql-store, advisor, codegen, d1, do, cli, studio, vite,
hyperdrive, platform-node, mcp, runtime and lunora; vitest green in server (1 026+), shard-engine (1 738), sql-store (296), d1 (353), advisor
(632), do (882), codegen (2 831) and studio (1 411); `pnpm run test:workerd` passed all 17 workerd suites; `api:check`, `lint:generated` and
`lint:package-json` green.

### STOP conditions

- _A through relation cannot be expressed with the two single-hop edges_: not hit. It composes the two existing hops; `deriveRelationEdges`
  and `applyOnDelete` are untouched (cascade needs no new code and is tested through the join table's `onDelete`).
- _More than 5 compound SELECTs or 100 bound parameters on workerd_: not hit. No compound SELECT is emitted. The wide cases seed 150 tags
  on one post so both hops carry a 150-id list (including the `notIn` path of `none`/`every` and `with`); they pass on a real Durable
  Object (where a statement with 101 bound parameters was probed to be rejected) and a real D1 binding (documented cap, not probed), because every list compiles to one `json_each` parameter. The node
  suite also asserts the widest statement it sent has at most 100 parameters.

### Phase 2 bench

`packages/do/__bench__/relation-predicates-through.bench.ts` (2 000 posts, 200 tags, 12 000 join rows, node:sqlite). The through
declaration costs the same as the hand-written equivalent (`postTags.some(tag.is(W))`), within about 8%:

| Case                                 | through (hz) | hand-written (hz) |
| ------------------------------------ | ------------ | ----------------- |
| `some`, broad first hop (~half tags) | 53.6         | 50.7              |
| `some`, one tag                      | 2 604        | 2 815             |
| 50 posts `with` tags                 | 760          | 802               |

Through-only: `every` (broad) 77.7 hz, `none` (broad) 48.8 hz. A broad `some` is ~50 hz because both hops return thousands of keys; the
`maxRelationKeys` cap (5 000) is the guard, and unlike a one-hop relation a through predicate cannot escalate to EXISTS past it.

### Left open

- A write that touches only the join table and a live shape whose predicate goes through it: whether the source table's shape re-probes was
  not checked. The same question applies to every one-hop relation predicate and was left as it was.
- `with` on a through relation reads **every** join row of the page's parents even when the caller passes `limit`. A one-hop `many`
  pushes the `limit` into the child read; here the order comes from the target's `orderBy`, so the cap can only apply after the first hop.
  `loadMany`'s per-parent fan-out still bounds the target reads, not the link reads.
- A through relation declared by a **plugin** is rejected when the plugin merges: `validateThroughRelations` compares the join table's bare
  `v.id("tags")` names with the prefixed table names, and no plugin declares one today.
- `unindexed_relation_target` checks the join table's `from` column only. Predicates also filter the join table by `to`; an index
  leading with `to` is not linted.
- `_count` over a through relation materialises the linked target ids; it is not a single grouped query.
- The in-process test runtime does not report its transaction state to the engine, so it never refuses a through write as an action would
  be (a deployed shard's `buildCtx` passes `inTransaction` for every dispatch, and an action is not wrapped in one).
