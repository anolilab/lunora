# Plan 489 — Many-to-many relations through a join table (`r.many(..., { through })`)

**Baseline:** `f3915a2e4` (2026-10-13)
**Status:** BLOCKED (design only; decision §4.1 needs the owner's answer)

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

### 4.1 One new declaration, or a derived helper? (open)

- **A. `r.many(target, { through: { table, from, to } })`.** One declaration beside the others; the join table is
  named once. Needs a third relation kind in `RelationDefinition`, the generated types, `resolveWith`, relation
  predicates, cascade and the advisor.
- **B. Keep two one-to-many relations and add only a write helper** (`connect` through a named join table).
  Smaller, and reads stay two hops by hand; the typing gain is small.
- Recommendation: **A**, built in the order of §5, because reads are where a many-to-many hurts most. Needs the
  owner's call before work starts.

### 4.2 Duplicate and ordering semantics of the join rows (open)

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
| 0     | Decide §4.1 | the owner's answer in this file                                                                                   |
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

1. §4.1: one new declaration (`r.many(..., { through })`), or a derived helper over two one-to-many relations?
2. §4.2: are duplicate join rows (the same pair twice) allowed, and does a read order by the join row's creation?
3. Does a through relation inherit `onDelete` cascade from the join table's foreign keys, or declare its own?
