# Plan 247 — `defineEventStore`: couple Pipelines write + R2 SQL query under one typed schema (design spike)

**Baseline:** `2829e33ec` (2026-07-31)
**Status:** SPIKE COMPLETE — prototype + recommendation below; not ratified for a shipping package/subpath.

## 0. Headline finding

Pipelines (write) and R2 SQL (read) both target the same physical thing — an
Apache Iceberg table in R2 Data Catalog — but share no type today.
`PipelineBindingLike.send` takes untyped `Record<string, unknown>[]`
(`packages/bindings/src/pipelines/types.ts:16`), and `R2SqlClient.from<Row>`
takes a caller-declared `Row` with no relationship to what was ever written
(`packages/bindings/src/r2sql/client.ts:80`). A dev who wants both ends up
hand-declaring the column list twice — once as whatever shape they pass to
`send()`, once as the `Row` type argument to `from<Row>()` — and nothing
stops the two from drifting.

`defineEventStore(schema)` proves one schema CAN drive both halves at the
TypeScript level, and — the part that actually matters, since Pipelines
enforces nothing server-side — a runtime guard in front of `send()` catches
an off-schema record before it reaches Pipelines. The prototype does **not**
attempt to own the Iceberg table itself; see §4 for why.

## 1. Current state (audit)

- **Pipelines — write-only, untyped.** `packages/bindings/src/pipelines/types.ts:10-18`:
  `PipelineRecord = Record<string, unknown>`; `PipelineBindingLike<T>.send(records: T[])`.
  `packages/bindings/src/pipelines/create-pipelines.ts` wraps it as `ctx.pipelines`
  — "fire-and-forget", "no in-handler read-back" (its own doc comment).
- **R2 SQL — query-only, over Iceberg.** `packages/bindings/src/r2sql/types.ts` +
  `client.ts`: `createR2Sql(config)` → `R2SqlClient`. `from<Row>(table)` returns a
  `SelectBuilder<Row>` (`packages/bindings/src/r2sql/builder.ts`) — a real chainable
  query builder (`WHERE`, joins, window functions, set operations), but `Row` is
  purely a caller-side cast; nothing checks it against the table.
- **No DDL/table-lifecycle code anywhere in this repo.** `grep`-ing
  `packages/bindings/src` for `CREATE TABLE`/schema-management turns up nothing —
  Iceberg tables are created out-of-band today (`wrangler r2 sql` / the R2 Data
  Catalog REST API / the dashboard), and neither Pipelines nor R2 SQL bindings
  expose a way to create or introspect a table's column list from inside a
  Worker.
- **Precedent this is modeled on:** `packages/ai/src/rag/define-rag.ts`. One
  `RagConfig` couples `ctx.ai` (embed) + `ctx.vectors` (write AND read) under one
  declared shape, returning a per-bound-ctx factory (`{ index, retrieve, remove, asTool }`).
  Notably `defineRag` does not own Vectorize INDEX creation either — the index name
  is a config string, and creating/dimensioning the index is a `wrangler vectorize`
  step outside the library. That is the same "document, don't own" boundary this
  plan reaches for the Iceberg table (§4).
- **Adjacent precedent: Analytics Engine already half-solves this differently.**
  `packages/bindings/src/analytics/types.ts` + `create-analytics.ts`:
  `AnalyticsClient.track(name, event)` maps named `{ dimensions, metrics, index }`
  fields to AE's positional `blobN`/`doubleN`/`index1` columns and **returns** a
  `TrackSchema` (the field→column mapping) from every call — but there is no
  single declared schema up front; the mapping is inferred per-call from the
  event's own key order, and the read side (raw SQL over AE's SQL API) never
  consumes `TrackSchema` to type its rows. So AE independently arrived at
  "return a mapping instead of hand-declaring types twice," which is a lighter
  version of the same problem this plan addresses for Pipelines/r2sql — see §7.

## 2. Existing seams (do not reinvent)

- **`SelectBuilder<Row>`** already IS the typed query builder — `query()` in the
  prototype is nothing more than `r2sql.from<Row>(table)` with `Row` inferred
  from the schema. No new query surface was built; reinventing one would
  duplicate `WHERE`/joins/window functions/set-ops for no reason.
- **`PipelineBindingLike<T>`** already accepts a generic record type — the
  prototype narrows `T` to the schema-derived record instead of inventing a new
  binding shape.
- **`LunoraError` / `VALIDATION_ERROR`** (`@lunora/errors`, already a
  `@lunora/bindings` dependency) is the existing error vocabulary for a
  caller-input rejection; the runtime guard uses it rather than a bespoke error
  type.

## 3. The API

```ts
const purchases = defineEventStore({
    pipeline: env.PURCHASE_EVENTS, // PipelineBindingLike<EventStoreRecord<Schema>>
    r2sql: createR2Sql({ accountId, apiToken, bucket }), // needs only `.from`
    schema: {
        id: "string",
        amount: "number",
        occurredAt: "timestamp",
    },
    table: "analytics.purchases", // must already exist with a matching column set
});

// Write — runtime-validated against `schema` before it reaches Pipelines:
await purchases.send({ id: "evt-1", amount: 42, occurredAt: new Date().toISOString() });

// Read — the SAME schema types the row shape, over the SAME table:
const recent = await purchases.query().where("amount > 10").orderBy(desc("occurredAt")).limit(50).run();
```

`EventStoreRecord<Schema>` is a mapped type (`{ [K in keyof Schema]: TsTypeOf<Schema[K]> }`)
derived from the column-type map, exactly the way `defineRag`'s config shapes
derive `IndexInput`/`RetrieveResult` from one `RagConfig`. `query()` returns the
real `SelectBuilder<EventStoreRecord<Schema>>` unmodified — every existing
builder method works, typed against the same row shape `send()` accepts.

Prototype: `packages/bindings/src/event-store/{types,define-event-store,index}.ts`,
tests at `packages/bindings/__tests__/event-store/define-event-store.test.ts`.

## 4. Design decisions

### 4.1 Table lifecycle: **document, don't own**

**Decision:** `defineEventStore` takes `table` as a plain string and assumes it
already exists with columns matching `schema`. It does not call any table-creation
or table-introspection API.

**Alternative rejected: own table creation** (e.g. `defineEventStore` calls the
R2 Data Catalog API on first use to `CREATE TABLE IF NOT EXISTS` from `schema`).
Rejected because:

- **No existing seam.** Nothing in `@lunora/bindings` talks to the R2 Data
  Catalog control plane (table DDL) today — only the R2 SQL _query_ REST
  endpoint and the Pipelines _write_ binding, neither of which does schema
  management. Owning creation means a THIRD Cloudflare API surface (bearer
  token scope, endpoint, error handling) added specifically for this facade.
- **Type reconciliation is not solvable client-side.** Pipelines ingests JSON
  and Cloudflare's pipeline-to-Iceberg mapping decides the actual Iceberg
  column types (and does its own type coercion/widening) — this prototype's
  4-type `EventStoreColumnType` (`boolean` / `number` / `string` / `timestamp`)
  is a deliberately small approximation, not a mirror of Iceberg's real type
  system (no `decimal`, no nested `struct`/`list`/`map`, no explicit
  int-width/precision). A `CREATE TABLE` generated from `schema` could produce
  a column type that doesn't match what Pipelines actually writes for a given
  JSON value, and there is no in-repo way to verify that reconciliation short
  of running a real ingest against a real table and diffing the catalog's
  reported schema — out of scope for a client library, and squarely the kind
  of drift this plan exists to prevent, not reproduce one level down.
- **Blast radius of getting it wrong.** A table is a durable, billed, org-wide
  resource. Auto-creating it from application code (implicitly, on first
  `send()`) is a much bigger commitment than the read/write coupling this spike
  set out to prove, and reversing a wrong auto-created schema means a manual
  Iceberg migration.

So: the design **documents** the requirement (`table` must pre-exist,
matching `schema`, created via `wrangler r2 sql` / the Data Catalog API /
dashboard) rather than **coupling** the facade to table ownership. This
mirrors `defineRag`'s own boundary (Vectorize index creation/dimensioning is
also out-of-band) and matches the STOP condition in the originating plan:
_"the R2 Data Catalog table schema can't be reconciled between Pipelines
ingest format and r2sql column types without owning table creation — document
the mismatch and stop at 'document, don't couple.'"_ That is the exact outcome
here.

### 4.2 Schema → both-halves mapping

One `EventStoreSchema` (`Record<string, "boolean"|"number"|"string"|"timestamp">`)
is the single source of truth:

- `EventStoreRecord<Schema>` (a mapped type) is used as BOTH `send()`'s
  parameter type and `SelectBuilder`'s `Row` type argument for `query()`. There
  is exactly one place a column name/type is written down.
- At runtime, `send()` is checked field-by-field against `schema` before
  forwarding to the Pipelines binding (§4.3) — the compile-time mapping alone
  cannot be trusted given how `send()` can be reached (see below).

### 4.3 Runtime enforcement is client-side, and is honest about its limits

**The originating plan's STOP text is correct and worth restating precisely:**
_"Pipelines ingest is fire-and-forget with no schema enforcement — state the
typed `send` is compile-time-only honestly."_ This prototype goes one step
further than a pure type-level wrapper — `assertMatchesSchema` in
`define-event-store.ts` DOES run a real runtime check (field presence, no
extra fields, primitive-type match) before calling `pipeline.send()` — proven
by the "catches a wrong-typed field / missing field / undeclared field"
tests. But two honesty notes:

1. This check runs in the calling Worker, in front of the SDK boundary. It
   catches a bad call from JS (no compiler), a stale build, or an `as` cast —
   the realistic ways a typed `send()` gets bypassed. It does **not** validate
   against the Iceberg table's actual, authoritative schema (Cloudflare-side),
   because nothing in this client library can read that schema back (§4.1).
   A `schema` that has drifted from the real table columns will pass this
   check and still fail (or silently coerce) downstream in Cloudflare's
   pipeline.
2. The 4-type vocabulary is intentionally coarse. It cannot express Iceberg's
   fuller type system, so "passes `assertMatchesSchema`" is necessary but not
   sufficient for "matches the Iceberg column type."

Net: the typed `send()` here is a real improvement over "cast and hope,"
not a full write-time schema-enforcement guarantee.

## 5. Prototype — what the test proves

`packages/bindings/__tests__/event-store/define-event-store.test.ts`, five cases:

1. `send()` forwards a schema-valid record to the (double) Pipelines binding
   unchanged.
2. `query()` is a real `SelectBuilder` over the SAME `table` — `.where()`/
   `.orderBy()`/`.limit()`/`.run()` all work, exercised against `createR2Sql`
   wired to a fake `fetch` (mirrors `__tests__/r2sql/client.test.ts`'s pattern),
   not a hand-rolled stand-in for the query engine.
3. **The load-bearing case:** a record cast past the type system
   (`as unknown as PurchaseEvent`) with a wrong-typed field is REJECTED by
   `send()` at runtime, and the underlying Pipelines `send` mock is never
   called — proving the enforcement is not merely a compile-time convenience
   wrapper.
4. Same, for a record missing a declared field.
5. Same, for a record carrying a field the schema doesn't declare.

Doubles: `PipelineBindingLike` as a plain object literal (matching
`__tests__/pipelines/create-pipelines.test.ts`'s existing pattern), and the
real `createR2Sql` factory with an injected fake `fetch` (matching
`__tests__/r2sql/client.test.ts`'s pattern) — so the read half runs through
the actual `SelectBuilder` + envelope-parsing code, not a fake query engine.

`pnpm --filter "@lunora/bindings" run test` and `lint:types` both pass; the
existing `pipelines`/`r2sql` test files are untouched, so the untyped
`ctx.pipelines.send` / raw `r2sql.query()` paths are provably unaffected.

## 6. Does the façade generalize to Analytics Engine?

Partially, and not for free. AE's write path (`createAnalytics` /
`AnalyticsClient.track`) already derives a per-call `TrackSchema` mapping
(§1) — narrower than `defineEventStore`'s upfront declared schema, but
solving an adjacent problem (named fields → AE's positional `blobN`/`doubleN`
layout). Generalizing `defineEventStore` to AE would mean:

- A `defineEventStore`-style wrapper COULD accept a schema, call `track()` for
  writes, and use the _returned_ `TrackSchema` to type a query helper — but
  AE's read side (`packages/bindings/src/analytics/sql-api.ts`) is raw SQL
  over the Workers Analytics Engine SQL API, not `r2sql`'s typed
  `SelectBuilder`; there is no chainable query builder to plug a `Row` type
  into today. Building one is a separate, non-trivial scope addition — out of
  scope for this spike (the originating plan explicitly says "mention it,"
  not build it).
- AE's `TrackSchema` mapping is inherently per-call (key insertion order
  decides the positional columns), which is a fundamentally different
  contract than "one schema, declared once, used for every write" — merging
  the two designs cleanly is itself an open question, not a mechanical port.

**Conclusion:** plausible future direction, not a small follow-up. Left as an
open question (§8), not attempted here.

## 7. Codegen / DX story

Not addressed — the originating plan puts "wire codegen" out of scope. The
schema in the prototype is a plain object literal passed directly to
`defineEventStore` at the call site (mirroring `defineRag`'s `RagConfig`,
which also has no codegen involvement) — there is no `lunora/eventStores.ts`
declarative file, no `_generated/*` emission, and no `ctx.eventStores.*`
surface. If this ships for real, the DX question of "does the schema live in
`lunora/schema.ts` (reusing `defineTable`'s column vocabulary) or its own
declaration file" is open — see §8.

## 8. Open questions (answer before shipping past the spike)

1. **Table-lifecycle ownership.** Confirmed here as "document, don't own"
   (§4.1) for the spike — but is that the permanent answer, or does demand
   justify a later, carefully-scoped table-creation helper (e.g. thin
   `CREATE TABLE IF NOT EXISTS` from `schema`, run explicitly via a CLI command
   rather than implicitly on first `send()`)? Needs real usage signal.
2. **Is Analytics Engine in scope for a generalized facade**, and if so, does
   AE need its own typed query builder first (a much larger, separate
   project) before a shared `defineEventStore`-style wrapper makes sense?
3. **Where does the schema live?** A plain object literal at the call site
   (this prototype) vs. reusing `defineTable`'s column-type vocabulary from
   `lunora/schema.ts` vs. a new declaration file. Each has different codegen
   implications (§7).
4. **Type vocabulary completeness.** Is the 4-type `EventStoreColumnType`
   enough for real event-store use cases, or does it need to grow (nested
   objects, arrays, explicit numeric width) before this is usable beyond a
   spike — and if it grows, does the runtime guard's coverage grow with it or
   quietly fall behind?
5. **Multi-tenancy.** Neither Pipelines nor r2sql have a namespace/tenant
   concept the way Vectorize does (`defineRag`'s `namespace` parameter) — is
   per-tenant isolation a column in `schema` (app-level `WHERE tenant_id = ?`)
   or does it need a first-class parameter the way `defineRag` has one?

## 9. STOP / GO

**GO** on the design pattern (schema → both `send()` type and `query()` row
type is proven, with real runtime enforcement on the write side) — the
prototype's test suite demonstrates the core claim cleanly.

**STOP** on shipping `@lunora/bindings/event-store` as a public subpath until
open questions §8.1–§8.3 have real answers; the prototype intentionally stays
un-exported (no `package.json` "exports" entry) so nothing depends on an
unratified surface.
