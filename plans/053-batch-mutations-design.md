# Plan 053: Batch Database Writes — `insertMany` / `deleteMany` / `patchMany`

**Status**: Spike complete — awaiting maintainer decision on RLS semantics  
**Effort**: L (spike: M)  
**Risk**: MED  
**Depends on**: none  
**Direction**: design/spike  
**Spiked at**: b51b440a

---

## 1. Why

`DatabaseWriter` exposes only single-row writes: `insert`, `delete`, `patch`, `replace`
(`packages/server/src/types.ts:490-503`). Bulk operations force a per-row loop, which:

1. Produces N `await` microtasks inside one mutation handler.
2. Fires N separate trigger evaluations (before + after per row).
3. Produces N separate CDC log entries (one per row).
4. From the network boundary: is still one RPC per mutation call, but the handler
   does N SQLite round-trips against the DO's SQLite storage handle.

The internal migration runner already batches (see `packages/server/src/migration.ts`'s
`batchSize` — used for resumable keyset pagination over rows), and the data browser's
`__lunora_admin__:deleteRows` already loops per-row through the schema-aware writer
(`packages/do/src/shard-do.ts:2890`). Both prove the DO layer can do multi-row work —
it's just not surfaced to user code in an ergonomic form.

The non-trivial part is **semantics** (RLS per batch? all-or-nothing? return shape?),
so this is a design spike before a full build.

---

## 2. Architecture walkthrough: single-insert path

### 2a. User-facing writer

`DatabaseWriter` in `packages/server/src/types.ts:490-503` is the **public** interface
exposed in `ctx.db` for mutation/action handlers. It extends `DatabaseReader` with:

```
insert<T>(tableName, document, options?) → Promise<Id<T>>
delete<T>(id) → Promise<void>
patch<T>(id, patch) → Promise<void>
replace<T>(id, document) → Promise<void>
```

The **second** interface (`TriggerDatabase`, lines 742-754) is the **internal** trigger
context writer — it's handed to `TriggerCtx.db` (line 764) and is structurally similar
but not the user-facing surface.

### 2b. DO write path: `insert()` call trace

Starting from `ctx.db.insert("table", doc)` in a mutation handler:

```
ctx.db.insert(tableName, document)
  │
  ├─ [rls-guard] guardWriter.insert() — throws RlsRequiredError if schema is
  │   .rls("required") and table is not .public() and no .use(rls(...)) applied.
  │   (packages/do/src/rls-guard.ts:186-190)
  │
  ├─ [rls-middleware] wrapDatabase.insert() — if table has declared policies,
  │   evaluates the "insert" policy against the candidate row; throws FORBIDDEN
  │   on denial; routes THROUGH the unwrapped `raw` writer on success.
  │   (packages/server/src/rls/middleware.ts:969-987)
  │
  └─ [ctx-db] createShardCtxDb writer.insert()
       ├─ globalWriterFor() — routes .global() tables to D1 writer
       ├─ applyInsertDefaults() — fills .default()/.defaultFn()/.serverDefault()
       ├─ runRowValidators() — fires .check(predicate) validators
       ├─ id = generateId() (or clientId/allowExplicitId)
       ├─ fireTriggers("before", "insert", event)  [if declared]
       ├─ ensureBackfilledForTable()   [aggregate companion lazy backfill]
       ├─ ensureRankBackfilledForTable()
       ├─ runWrite(sql, INSERT INTO ... VALUES ...)
       ├─ syncSearch() / syncAggregates() / syncRanks()
       ├─ cache?.invalidate(table, id)
       ├─ recordCdc()
       ├─ broadcast({ key: id, op: "insert", ... })
       ├─ fireTriggers("after", "insert", event)   [if declared]
       └─ onWrite({ doc, id, op: "insert", table })
```

### 2c. DO transaction envelope

The `insert()` above happens inside whichever SQLite transaction is active.
`ShardDO.runInTransaction()` (shard-do.ts:2471) wraps the ENTIRE mutation handler with:

```
state.blockConcurrencyWhile(() => {
  BEGIN;
  result = await handler(ctx, args);
  COMMIT;
  return result;
})
```

A throw from anywhere inside `handler` triggers `ROLLBACK`. This means:

- All rows written by a mutation — including from an `insertMany` loop — are
  committed together or rolled back together.
- This guarantee exists at the **DO dispatch level**, not at the `insertMany`
  implementation level.

**Critical harness finding** (surfaced by PoC test `batch-mutations-poc.test.ts`):  
The `lunoraTest` in-memory harness does NOT wrap handlers in BEGIN/COMMIT. It calls
`handler(ctx, args)` directly. So in the harness, a mid-batch validator error leaves
the rows already written by prior `insert()` calls in the database. In production (real
ShardDO), ROLLBACK would clean them up. See §5 (Open Questions) for the harness
transaction-awareness TODO.

---

## 3. Proposed API (all three operations)

### `insertMany`

```typescript
// packages/server/src/types.ts — DatabaseWriter extension
insertMany<T extends string>(
  tableName: T,
  documents: Record<string, unknown>[],
  options?: InsertManyOptions,
): Promise<Array<Id<T>>>;

interface InsertManyOptions {
  /**
   * Payload cap: reject the call when `documents.length` exceeds this value.
   * Prevents accidental O(n²) operations and keeps the mutation under the DO
   * 128 MiB request limit. Defaults to `DEFAULT_INSERT_MANY_LIMIT` (500).
   */
  limit?: number;
}
```

### `deleteMany`

```typescript
deleteMany<T extends string>(
  ids: Array<Id<T>>,
  options?: DeleteManyOptions,
): Promise<{ deleted: number }>;

interface DeleteManyOptions {
  limit?: number;
}
```

### `patchMany`

```typescript
patchMany<T extends string>(
  patches: Array<{ id: Id<T>; patch: Record<string, unknown> }>,
  options?: PatchManyOptions,
): Promise<void>;

interface PatchManyOptions {
  limit?: number;
}
```

---

## 4. Semantics decisions

### 4a. Transaction boundary — all-or-nothing

**Decision**: All-or-nothing within the enclosing mutation's DO-level transaction.

The DO's `runInTransaction(handler)` wraps the entire mutation, so if `insertMany`
succeeds but the handler later throws, all rows are rolled back. If `insertMany` itself
fails mid-loop (RLS denial, validator error, unique violation), rows already written in
that mutation context are rolled back too. No extra transaction boundary is needed inside
`insertMany`.

**Implementation**: The PoC delegates to the existing `insert()` per row, which benefits
automatically from the enclosing transaction.

### 4b. RLS — per-row evaluation

**Decision (spike)**: Per-row, identical to N separate `insert()` calls.

Each row in the batch is checked individually against the table's insert policy
(`evaluateWrite(policies, "insert", { ...context, row: document })`). If any row is
denied, that row's `insert()` throws `FORBIDDEN` and the enclosing transaction rolls
back all rows written so far.

**Rationale**: Matches user expectations from Convex (no batch-level policy shortcuts),
preserves the invariant that a policy sees the exact candidate row, and avoids a new
"batch policy" concept.

**Alternative** (possible future extension): `insertManyUnsafe(tableName, documents)`
that skips RLS and runs a single SQL `INSERT INTO ... VALUES (a),(b),(c)...` for trusted
internal/admin contexts (migrations, seed, admin import). This would be significantly
faster for N > 50 but explicitly trades safety for throughput.

**Partial failure behavior**: Under per-row semantics, the first denied row aborts the
batch. The whole mutation rolls back. The caller receives a `FORBIDDEN` error. No partial
success is possible.

### 4c. Return shape — array of ids

**Decision**: Return `string[]` (one id per input document, same order).

This mirrors what a per-row loop would accumulate and matches Convex's `insertMany`
(returns `Id<T>[]`). `{ count: number }` is less useful because callers typically need
the ids for follow-up operations.

### 4d. Ordering and FK constraints within a batch

**Decision**: Insert order is preserved (the loop is sequential, not concurrent). FK
references between rows in the same batch are NOT guaranteed to resolve unless the
referenced row was inserted earlier in the same batch or in a prior mutation.

For example, inserting a `parent` row and a `child` row that references it in the same
`insertMany` call WORKS only if `parent` appears before `child` in the array. This is
consistent with the DO's single-threaded SQLite model (inserts are sequential within
the transaction).

---

## 5. Payload-size limits

The DO's `handleRpc` deserializes the entire mutation args before running the handler.
The Cloudflare Workers 128 MiB subrequest body limit and the DO's own 128 KiB CPU-burst
limit are the hard caps. For `insertMany`:

- Each document is a JSON-serialized record. A 1 KB avg doc × 500 docs = 500 KB payload
  — well within the 128 MiB limit but worth noting for very wide schemas.
- SQLite's per-statement bound-parameter limit (default 999 in SQLite, unlimited in
  workerd's SQLite) applies to a raw multi-row INSERT. Since the PoC delegates to
  per-row `insert()`, it avoids this limit entirely.
- **Recommended default cap**: 500 documents per `insertMany` call. Callers inserting
  larger sets should loop over chunks. The `options.limit` override lets trusted callers
  raise the cap on a per-call basis.

---

## 6. Codegen and client implications

- **Codegen** (`@lunora/codegen`): `insertMany` is a new method on `DatabaseWriter`.
  Codegen's emitted `_generated/server.ts` forwards the existing writer — no change
  needed. The by-table ORM facade (e.g. `ctx.db.items.insertMany(docs)`) would need to
  be added to the facade builder, but this is a UI improvement, not a correctness
  requirement.
- **Client** (`@lunora/client`): `insertMany` does not need new client-side optimistic
  update support for the first release. Callers can apply individual optimistic inserts
  before the mutation resolves — the server reply carries the real ids. TanStack DB
  collections (`@lunora/db`) would benefit from a `insertMany` → offline-transactions
  outbox integration, but that's a follow-up.
- **RLS middleware** (`packages/server/src/rls/middleware.ts`): Already patched in the
  spike to wrap `insertMany` with per-row `evaluateWrite`.
- **RLS guard** (`packages/do/src/rls-guard.ts`): Already patched in the spike to gate
  `insertMany` on `guardTable(tableName)`.

---

## 7. PoC implementation summary

Files modified by the spike:

| File                                                     | Change                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/do/src/ctx-db.ts`                              | Added `insertMany` to `DatabaseWriterLike` interface + implementation (loop over `insert()`) |
| `packages/do/src/rls-guard.ts`                           | Added `insertMany` to `GuardableWriter` interface + `guarded.insertMany` wrapper             |
| `packages/server/src/types.ts`                           | Added `insertMany` to public `DatabaseWriter` interface                                      |
| `packages/server/src/rls/middleware.ts`                  | Added `insertMany` to local `DatabaseWriterLike` + `wrapDatabase.insertMany`                 |
| `packages/testing/__tests__/batch-mutations-poc.test.ts` | PoC test suite (7 tests, all passing)                                                        |
| `plans/053-batch-mutations-design.md`                    | This document                                                                                |

The PoC is deliberately a minimal loop over `insert()` — not a native multi-row SQL
`INSERT INTO ... VALUES (a),(b),(c)...`. The rationale:

1. **Correctness first**: reuses all existing invariants (triggers, RLS, validators,
   aggregate/rank/search sync, CDC, broadcast) with zero risk of accidentally skipping
   one.
2. **One RPC, N writes**: the real win is reducing the caller's RPC count from N to 1 —
   the DO still does N inserts internally, but the caller's WebSocket/fetch round-trips
   drop from N to 1.
3. **Foundation for the fast path**: once the per-row correctness is proven, a follow-up
   spike can implement `insertManyUnsafe` using a chunked native INSERT with a manual
   companion maintenance step.

---

## 8. Open questions for the maintainer

### Q1 (KEY): RLS partial-failure policy

When `insertMany` has 10 rows and row 7 is denied by RLS:

- **Option A** (spike implementation): fail the whole batch with `FORBIDDEN`, roll back
  rows 1-6. The caller gets an error with no indication of which row failed.
- **Option B**: partial success — commit rows 1-6, skip row 7, continue with rows 8-10.
  Return `{ ids: [...], denied: [6] }` shape.
- **Option C**: reject the whole batch at validation time BEFORE any write, by running
  `evaluateWrite` for all rows upfront.

**Recommendation**: Option A (current spike behavior) — it matches the transaction model
("all or nothing") and avoids a complex partial-success shape. If partial success is
needed, it should be a separate `tryInsertMany` primitive.

### Q2: Should `insertManyUnsafe` be a first-class API?

A raw multi-row SQL INSERT would be 5–20× faster for N > 50, but it:

- Can't fire per-row `before`/`after` triggers.
- Skips RLS.
- Requires manual aggregate/rank/search/CDC sync after the batch.

This is appropriate only for admin/seed/migration contexts. Should it be exposed as
`ctx.db.insertManyUnsafe()` (clearly named), or kept internal only?

### Q3: Should `lunoraTest` wrap mutation handlers in a transaction?

The PoC revealed that the harness does NOT wrap handlers in BEGIN/COMMIT. This means
the "all-or-nothing" guarantee is invisible in tests — a mid-batch error leaves partial
rows in the harness's SQLite but not in production.

Adding `runInTransaction` to the harness's mutation/run path would make test behavior
match production, but it would also change the observable behavior of existing tests
that rely on partial-write behavior. This warrants a separate plan or RFC.

### Q4: `deleteMany` and `patchMany` — same semantics?

The spike only implements `insertMany`. `deleteMany` (array of ids) and `patchMany`
(array of `{id, patch}`) are proposed but not implemented. The same per-row loop
approach applies, with the same transaction and RLS guarantees. Should these be
included in the same build plan, or shipped separately?

### Q5: Payload limit default

The spike proposes a default cap of 500 documents. Is this too low for seed/import
use cases? Too high for a real mutation? Should the limit be enforced at the framework
level or left to callers?

---

## 9. Done criteria (for the build plan that follows this spike)

- [ ] `insertMany` / `deleteMany` / `patchMany` on `DatabaseWriter` and `DatabaseWriterLike`
- [ ] Per-row semantics (§4b) confirmed as the production choice
- [ ] Payload-size limit enforced at the writer level
- [ ] `lunoraTest` harness transaction-awareness (§Q3) addressed or explicitly deferred
- [ ] `@lunora/testing` batch-write test coverage (harness + real DO E2E)
- [ ] Codegen by-table facade emits `insertMany`
- [ ] `pnpm --filter "@lunora/server" run lint:types` passes
- [ ] `pnpm --filter "@lunora/testing" run test` passes
