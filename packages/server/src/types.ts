/* eslint-disable no-secrets/no-secrets -- JSDoc names the `RegisteredFunction<ArgsValidator, …>` type, not a credential. */

// The declared analysis languages and storage strategies. Inlined by the
// bundler from `shared/search` rather than depended on, so the schema builder
// still stands up without the DO runtime — it just no longer restates the
// unions that the engines validate against.
import type { SearchLanguage, SearchStrategy } from "@lunora/search-core";
import type { Id, Infer, InferValidatorMap, Validator, ValidatorMap } from "@lunora/values";

import { anyApi as sharedAnyApi } from "../../../shared/any-api";
import type { RestCachePolicy } from "../../../shared/rest-surface";

/** Map of validators describing a function's args record. Alias of `@lunora/values`' shared {@link ValidatorMap}. */
type ArgsValidator = ValidatorMap;

/** Infer the args object type from an {@link ArgsValidator}. Alias of `@lunora/values`' shared {@link InferValidatorMap}. */
type InferArgs<A extends ArgsValidator> = InferValidatorMap<A>;

/** Storage backend for a `.global()` table: D1 (default) or a Postgres/MySQL database via Cloudflare Hyperdrive (PlanetScale, Neon, …). */
type GlobalBackend = "d1" | "hyperdrive";

/**
 * Cloudflare Durable Object data-residency jurisdiction declared via
 * `defineSchema(...).jurisdiction("…")`. Restricts where every DO the app
 * reaches runs and persists data (GDPR, FedRAMP, US data residency). Widening
 * union — Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/** How a table is routed at runtime. */
type ShardMode = { backend?: GlobalBackend; kind: "global" } | { field: string; kind: "shardBy" } | { kind: "root" };

/** Poll cadence for a sourced table — `"manual"` (pull only on an explicit trigger) or a fixed interval. */
type ExternalSourceRefresh = "manual" | { everyMs: number };

/**
 * Delete-detection mode for external-source ingest (plan 077 / 136).
 *
 * `"full-pull"` (the default) reads the **whole** tenant membership each tick and
 * diffs it, so it observes upstream deletes for free — but costs a full read per tick
 * (the Phase-0 bench put the ceiling at ~10k rows).
 *
 * `"incremental"` pulls **only rows past a durable watermark** (`cursor`), cheap for
 * large low-churn tables above the full-pull cap. Because an absent row then means
 * "unchanged", not "deleted", incremental requires a delete-visibility path: either a
 * `reconcileEveryMs` periodic full-pull sweep, or a `softDeleteColumn` whose
 * tombstones the pull returns. `defineSchema` throws (and the
 * `external_source_incremental_no_delete_path` advisor lint fails the build) when an
 * incremental source declares neither.
 */
type ExternalSourceMode = "full-pull" | "incremental";

/**
 * Incremental-ingest cursor (plan 136): the monotonic watermark column plus the
 * watermark-parameterized pull query. `column` names the field in the pulled rows
 * whose max becomes the next watermark (e.g. `"updated_at"`). `query` is a second
 * SQL that returns only rows changed since the watermark — the watermark binds as
 * the parameter AFTER `tenantBy`'s params (e.g. Postgres
 * `... WHERE tenant_id = $1 AND updated_at >= $2 ORDER BY updated_at`). Prefer `>=`
 * with the idempotent upsert apply so rows sharing the boundary timestamp are never
 * skipped (re-pulling them is a no-op).
 */
interface ExternalSourceCursor {
    /** The monotonic watermark column in the pulled rows; its max advances the stored watermark. */
    column: string;
    /** The incremental pull SQL. `tenantBy`'s params bind first, then the watermark as the trailing param. */
    query: string;
}

/**
 * Config for `.source(...)` (plan 077): declares a table as **materialized from an
 * external Postgres/MySQL behind Cloudflare Hyperdrive**, not written by user
 * mutations. A system-driven poll loop reads the tenant slice and lands it in the
 * DO's SQLite (via the validated CDC writer), after which `defineShape` carries it
 * to clients unchanged. Orthogonal to `shardMode` — a sourced table almost always
 * also `.shardBy()`s, in which case `tenantBy` is the mandatory tenant-isolation
 * boundary (enforced by the `external_source_unscoped` advisor lint).
 */
interface ExternalSourceDefinition {
    /** The wrangler Hyperdrive binding name the poll loop reads from. */
    binding: string;

    /** Project the materialized rows to these columns (passed to the membership diff). Omit ⇒ the full mapped document. */
    columns?: ReadonlyArray<string>;

    /** **Required for `mode: "incremental"`**: the watermark column + watermark-parameterized pull query (plan 136). Rejected on a `"full-pull"` source. */
    cursor?: ExternalSourceCursor;

    /** Column whose value becomes the Lunora `_id`. Defaults to `"id"`. */
    idColumn?: string;

    /** Transform an external row into the stored document body. Omit ⇒ every selected column except `idColumn` is copied. */
    map?: (row: Record<string, unknown>) => Record<string, unknown>;

    /** Delete-detection mode. `"full-pull"` (the default) diffs the whole membership; `"incremental"` pulls past a `cursor` watermark. */
    mode?: ExternalSourceMode;

    /** The full tenant-membership query, with driver-native placeholders (`$1` / `?`). `tenantBy` binds its params. */
    query: string;

    /**
     * **Incremental delete-visibility (plan 136)**: run a full-pull sweep at most
     * this often (millis) to GC upstream deletes an incremental slice can't see.
     * One of `reconcileEveryMs` / `softDeleteColumn` is required for incremental;
     * rejected on a `"full-pull"` source.
     */
    reconcileEveryMs?: number;

    /** Poll cadence, or `"manual"`. Omit ⇒ the runtime's size-scaled default. */
    refresh?: ExternalSourceRefresh;

    /**
     * **Incremental delete-visibility (plan 136)**: the upstream soft-delete
     * tombstone column (e.g. `"deleted_at"`). When set, the incremental pull must
     * return tombstoned rows and the ingest turns each into a local delete — an
     * alternative to `reconcileEveryMs`. Rejected on a `"full-pull"` source.
     */
    softDeleteColumn?: string;

    /**
     * **Mandatory under `.shardBy()`**: map this DO's shard key → the query's bound
     * params, so a tenant DO can only ever pull its own rows. An unscoped sourced +
     * sharded table replicates the whole multitenant table into every shard — the
     * `external_source_unscoped` advisor lint fails the build when this is absent.
     */
    tenantBy?: (shardKey: string) => ReadonlyArray<unknown>;
}

interface IndexDefinition {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

interface SearchIndexDefinition {
    /** Indexed text column; a dot-separated path (`"properties.name"`) reads a nested field. */
    field: string;
    /** Columns `.eq()` may narrow by inside the search builder. At most 16. */
    filterFields?: ReadonlyArray<string>;

    /**
     * Text analysis for this index. Accent folding is always applied — it is
     * what makes `café` and `cafe` the same token on every backend, which they
     * otherwise are not. Naming a language additionally drops that language's
     * stopwords from both documents and queries.
     *
     * Analysis is baked into the stored index, so changing this rebuilds it:
     * the runtime records which profile a companion was built with and
     * re-indexes when it no longer matches.
     */
    language?: SearchLanguage;
    name: string;

    /**
     * Skip the migration-time backfill. By default, creating the index's
     * companion also indexes the rows already in the table, so a search index
     * added to a populated table works immediately. On a very large table that
     * scan is expensive to run inside a deploy: `staged: true` maintains the
     * index on write only and leaves the initial population to an out-of-band
     * run.
     *
     * That run is mandatory, not optional — until it happens, every row written
     * BEFORE the deploy is unsearchable. Drive it against a deployment with
     * `lunora run '__lunora_admin__:backfillSearch' --args '{"maxPages":20}'`,
     * repeating until the response reports `done: true`; progress is durable, so
     * each call resumes where the last stopped.
     */
    staged?: boolean;

    /**
     * How the index is stored and matched.
     *
     * `"portable"` (default) keeps one implementation on every backend, with
     * identical matching *and* ranking — the invariant the rest of the search
     * docs rest on.
     *
     * `"native"` hands matching to the engine's own full-text index where it has
     * one (Postgres `tsvector` + GIN today; ignored elsewhere). It scales far
     * better on large corpora and common terms, because the portable path
     * aggregates every matching token row before ranking. The trade: the engine
     * ranks, so results are ordered by its formula rather than the shared
     * scorer. Matching still agrees — the vector is built from the same analyzed
     * tokens — but a `.global()` table using it will not return rows in the same
     * order as the sharded twin.
     */
    strategy?: SearchStrategy;
}

/**
 * A geospatial index declared via `.geoIndex(name, { field })`. The runtime
 * maintains a geohash companion table over the `v.geoPoint()` column `field` so
 * `withGeoIndex(name, q => q.near(point, radius) | q.within(bbox))` resolves a
 * proximity / bounding-box read as a geohash-prefix range scan plus a Haversine
 * refine/sort on the candidate rows.
 *
 * - `field` — the `v.geoPoint()` column whose lat/lng feed the geohash.
 * - `precision` — geohash character length on the companion (default 9, ~4.8 m cells); higher precision narrows each cell.
 */
interface GeoIndexDefinition {
    field: string;
    name: string;
    precision?: number;
}

/**
 * Declarative table-level TTL declared via `.ttl(field, { after? })`. A DO
 * alarm-driven sweep deletes (or, when the table also `.softDelete()`s,
 * soft-deletes) rows whose expiry timestamp has passed.
 *
 * - `field` — an epoch-millisecond column. Without `after`, its value is the absolute expiry instant; with `after`, `field` is a base timestamp and the row expires `after` milliseconds later (`field + after`).
 * - `after` — optional millisecond offset added to `field` to derive the expiry.
 */
interface TtlDefinition {
    after?: number;
    field: string;
}

/** Reducer applied by an aggregate index. */
type AggregateOp = "avg" | "count" | "max" | "min" | "sum";

/**
 * Declared aggregate index — the schema-level seam that lets the runtime keep
 * O(1) counters/sums in step with row writes (via the trigger runner) and
 * route matching reads through them.
 *
 * - `on` — the table whose rows feed the aggregate.
 * - `op` — the reducer. `count` is field-less; the others take `field`.
 * - `field` — the column the reducer applies to (required for non-count ops).
 * - `by` — group keys. When all `where` keys in a read participate in `by`, the
 * reader can answer from the counter table without scanning rows.
 * - `where` — optional static predicate baked into the counter (only the rows
 * matching it ever land in the counter).
 */
interface AggregateIndexDefinition {
    by?: ReadonlyArray<string>;
    field?: string;
    name: string;
    on: string;
    op: AggregateOp;
    where?: Record<string, unknown>;
}

/**
 * One ordering key on a `rankIndex.sortBy`: which column to sort by, and the
 * direction. The runtime breaks ties on the row's `_id` ASC so the order is
 * total and `rank()` always returns a deterministic 1-based position.
 */
interface RankSortKey {
    direction: "asc" | "desc";
    field: string;
}

/**
 * Declared rank index — a sorted companion table per `(partition tuple, sortBy)`
 * maintained by triggers, so:
 *
 * - `rank(row)` returns the row's 1-based position within its partition under
 * the declared `sortBy` order, plus the partition's total row count, in
 * O(log n) lookups against the SQLite btree on the companion table.
 * - `rankPage({ where, take, from })` walks the same companion table to return
 * rows in the declared order — a sorted-pagination accelerator.
 *
 * Fields mirror `AggregateIndexDefinition`:
 *
 * - `on` — the source table whose rows feed the rank.
 * - `sortBy` — ordered keys driving the rank. Required.
 * - `partitionBy` — columns that scope each rank context (e.g. `["channelId"]`
 * to rank within a channel). Omitted ⇒ one global rank across the table.
 * - `where` — static predicate baked into the index; only matching rows enter.
 */
interface RankIndexDefinition {
    name: string;
    on: string;
    partitionBy?: ReadonlyArray<string>;
    sortBy: ReadonlyArray<RankSortKey>;
    where?: Record<string, unknown>;
}

/** FK behavior when a referenced parent row is deleted (mirrors SQL `ON DELETE`). */
type OnDeleteAction = "cascade" | "restrict" | "set null";

/**
 * A declared relation between two tables, recorded by `.relations((r) => …)`.
 *
 * - `one` (many-to-one): the FK column `field` lives on **this** table and
 * points at `table`.`references` (default `_id`). Loads a single doc.
 * - `many` (one-to-many): the FK column `field` lives on the **target** table
 * and points back at this table's `references` (default `_id`). Loads an array.
 *
 * `onDelete` is meaningful only on `one`: it is the action applied to the
 * holder rows when the referenced parent row is deleted.
 */
interface RelationDefinition {
    field: string;
    kind: "many" | "one";
    onDelete?: OnDeleteAction;
    references: string;
    table: string;
}

/** Distance metric used by a Vectorize index. */
type VectorMetric = "cosine" | "dot-product" | "euclidean";

/**
 * Bring-your-own-embedder: a user-supplied fn turning a source string into a
 * numeric vector. The runtime calls it at upsert/query time so the framework
 * never couples to a single embedding provider.
 */
type VectorEmbedder = (input: string) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

/**
 * Vector index declared inline on a table via `.vectorize(field, opts)`
 * (DSL Shape A). The source is always a single column on the owning table.
 */
interface TableVectorIndex {
    dimensions: number;
    embed: VectorEmbedder;
    field: string;
    metadata?: ReadonlyArray<string>;
    metric: VectorMetric;
    name: string;
}

interface TableDefinition<Shape extends Record<string, Validator> = Record<string, Validator>> {
    /**
     * Aggregate indexes declared via `.aggregateIndex(name, opts)`. The runtime
     * maintains a counter row per `by` group via the trigger seam, so reads
     * whose `where` keys all participate in the index's `by` set are answered
     * without scanning the underlying table.
     */
    aggregateIndexes: ReadonlyArray<AggregateIndexDefinition>;

    /**
     * Set by `.commitOrdered()` (named `commitOrderedMode`, not `commitOrdered`,
     * so the data field doesn't collide with the fluent `.commitOrdered()`
     * builder method — same convention as `shardBy()`/`shardMode`). When `true`,
     * every write to a row stamps `_commitSeq`: a per-shard integer allocated
     * once per mutation and strictly increasing in commit order. Absent/`false`
     * ⇒ rows carry no `_commitSeq`, as before.
     */
    commitOrderedMode?: boolean;

    /**
     * Set by `.source(...)` (named `externalSource`, not `source`, so the data
     * field doesn't collide with the fluent `.source()` builder method — same
     * convention as `shardBy()`/`shardMode`). When present, the table is
     * materialized from an external Hyperdrive-backed database by a system poll
     * loop rather than user mutations. Implies `isExternallyManaged`.
     */
    externalSource?: ExternalSourceDefinition;

    /**
     * Geospatial indexes declared via `.geoIndex(name, { field })`. The runtime
     * maintains a geohash companion over the named `v.geoPoint()` column so
     * `withGeoIndex(name, q => q.near(point, radius) | q.within(bbox))` resolves
     * a proximity/bounding-box read as a geohash-prefix range scan plus a
     * Haversine refine/sort. Empty unless `.geoIndex()` was called.
     */
    geoIndexes: ReadonlyArray<GeoIndexDefinition>;

    indexes: ReadonlyArray<IndexDefinition>;

    /**
     * `true` when `.externallyManaged()` was called — the table's rows are
     * written outside Lunora's discoverable insert path (an adapter, a
     * migration, or framework middleware), e.g. `@lunora/auth`'s better-auth
     * tables or `@lunora/ratelimit`'s store. Advisor insert-path lints
     * (`table_without_insert`) skip such tables instead of flagging the absent
     * `ctx.db.insert(...)`.
     */
    isExternallyManaged?: boolean;

    /**
     * `true` when `.public()` was called — the table opts OUT of secure-by-default
     * RLS. Under a schema marked `.rls("required")`, every table is protected (the
     * DO/D1 write path denies raw, non-RLS `ctx.db` access) UNLESS it is `isPublic`.
     * Has no effect when the schema does not require RLS.
     */
    isPublic?: boolean;

    /**
     * Set by `.memory()` (named `memoryMode`, not `memory`, so the data field
     * doesn't collide with the fluent `.memory()` builder method — same
     * convention as `shardBy()`/`shardMode`). When `true`, the table's rows are
     * cleared every time the Durable Object is reconstructed, and its writes
     * never reach the CDC changelog. Absent/`false` ⇒ an ordinary durable table.
     */
    memoryMode?: boolean;

    /**
     * Set by `.ownedBy(field)` — the column holding the owning user's id (named
     * `ownerField`, a data field, rather than colliding with the fluent
     * `.ownedBy()` builder method — same convention as `shardBy()`/`shardMode`).
     *
     * A shape over this table with `owner: true` derives its predicate from this
     * field, so "only the owner may replicate these rows" is declared once on the
     * table instead of being restated in every shape's `where`. Absent ⇒ the table
     * has no single owning column and a shape must spell its predicate out.
     */
    ownerField?: string;

    /**
     * Rank indexes declared via `.rankIndex(name, opts)`. The runtime maintains
     * a sorted companion table per declared rank with a btree on
     * `(partition, sortBy)` so `rank(row)` returns the row's 1-based position
     * within its partition in O(log n), and `rankPage()` walks the index for
     * sorted pagination.
     */
    rankIndexes: ReadonlyArray<RankIndexDefinition>;

    /**
     * Declared relations keyed by accessor name; empty unless `.relations()`
     * was called. Named `relationMap` (not `relations`) so the fluent
     * `.relations((r) => …)` builder method doesn't collide with this field.
     */
    relationMap: Record<string, RelationDefinition>;

    searchIndexes: ReadonlyArray<SearchIndexDefinition>;

    shape: Shape;

    shardMode: ShardMode;

    /**
     * Set by `.softDelete()` (named `softDeleteMode`, not `softDelete`, so the
     * data field doesn't collide with the fluent `.softDelete()` builder method —
     * same convention as `shardBy()`/`shardMode`). When present, the table carries
     * a nullable timestamp column (`field`, default `deletedAt`):
     * `ctx.db.<table>.delete()` flips it instead of physically removing the row,
     * and **list reads** (`findMany`/`findFirst`/`query()`/`count`/`aggregate`/
     * relation loads) hide rows whose `field` is set unless
     * `includeDeleted: true` is passed. By-id `get`/`patch`/`replace` and
     * `restore` are unaffected. Absent ⇒ deletes are physical, as before.
     */
    softDeleteMode?: { field: string };

    /**
     * Declared lifecycle triggers keyed by accessor name; empty unless
     * `.triggers()` was called. Named `triggerMap` (not `triggers`) so the
     * fluent `.triggers((t) => …)` builder method doesn't collide with this
     * field — same reasoning as {@link TableDefinition.relationMap}.
     */
    triggerMap: Record<string, TriggerDefinition>;

    /**
     * Set by `.ttl(field, { after })` — the declarative auto-expiry policy. A DO
     * alarm-driven sweep deletes rows whose expiry timestamp has passed (or
     * soft-deletes them when the table also `.softDelete()`s). Named `ttlPolicy`
     * (a data field) rather than colliding with the fluent `.ttl()` builder
     * method — same convention as `shardBy()`/`shardMode`. Absent ⇒ rows never
     * auto-expire.
     */
    ttlPolicy?: TtlDefinition;
    vectorIndexes: ReadonlyArray<TableVectorIndex>;
}

/**
 * Standalone vector index declared via `defineVectorIndex(...)` (DSL Shape B).
 * Unlike {@link TableVectorIndex}, the source is a `select` function so it can
 * derive the embedded text from any computation (e.g. `title + body`).
 */
interface VectorIndexDefinition {
    readonly dimensions: number;
    readonly embed: VectorEmbedder;
    readonly kind: "vectorIndex";
    readonly metadata?: (row: Record<string, unknown>) => Record<string, unknown>;
    readonly metric: VectorMetric;
    readonly select: (row: Record<string, unknown>) => string;
    readonly table: string;
}

interface Schema<T extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
    /**
     * Secure-by-default RLS mode declared via `.rls("required")`. When
     * `"required"`, every table is protected: the DO/D1 write path denies raw
     * (non-RLS-wrapped) `ctx.db` access at runtime, so a procedure that forgets
     * `.use(rls(...))` fails closed instead of silently exposing the table. A
     * table opts out with `.public()` (→ {@link TableDefinition.isPublic}).
     * Absent ⇒ legacy opt-in behavior (RLS only where a policy is applied).
     */
    readonly rlsMode?: "required";
    readonly tables: T;
    readonly vectorIndexes: Record<string, VectorIndexDefinition>;
}

// --- Function registration ---------------------------------------------------

type FunctionKind = "action" | "mutation" | "query" | "stream";

/**
 * Call surface a function is exposed on. `public` functions are reachable from
 * clients via the generated `api`; `internal` functions are reachable only
 * server-to-server (`ctx.runQuery`/`runMutation`/`runAction`) and are rejected
 * by the DO's external RPC path. Absence is treated as `public` for
 * back-compat with functions registered before visibility existed.
 */
type FunctionVisibility = "internal" | "public";

/**
 * x402 payment tag attached by the `.x402({ price })` builder modifier. Marks a
 * public procedure as paid: the origin worker answers an unpaid client RPC with
 * HTTP 402, verifies + settles the payment, and only then dispatches to the
 * shard. The runtime reads only `price` from here — the network, recipient, and
 * facilitator live in the worker-level x402 charge config, so `@lunora/runtime`
 * never has to import `@lunora/x402` (and its viem/solana deps).
 */
interface X402ProcedureConfig {
    /**
     * USD-denominated price: a number of dollars (`0.01`) or a decimal string
     * (`"0.01"`, or the `"$0.01"` shorthand). Resolved to the network
     * stablecoin's base units (USDC has 6 decimals) at challenge time.
     */
    readonly price: number | string;
}

/**
 * HTTP caching for an exposed REST endpoint, declared as
 * `.expose({ rest: true, cache: { scope: "public", maxAge: 60 } })`. The runtime
 * turns this into `Cache-Control` / `Cache-Tag` / `Vary` response headers, and a
 * `cache.tag` is purgeable through `ctx.cache.purge({ tags: [...] })`.
 *
 * This is NOT equivalent to `httpRoute(...).cacheControl()`, which writes whatever
 * value the author passes with no credential downgrade. That is the unguarded
 * escape hatch; this is the guarded surface.
 *
 * Caching a procedure whose result depends on the caller is how a REST cache
 * turns into a data leak, so `scope` is enforced at runtime rather than trusted:
 * a request that carries credentials (an `Authorization` header or any `Cookie`)
 * is ALWAYS answered `private`, even under `scope: "public"` — see
 * {@link https://developer.mozilla.org/docs/Web/HTTP/Headers/Cache-Control MDN}
 * for what `private` forbids. So a per-user response can never be stored in a
 * shared/edge cache, and the worst a mis-declared `scope` can cost is a missed
 * cache hit. `scope: "public"` additionally emits `Vary: authorization, cookie`
 * so an intermediary can't hand a stored anonymous variant to a signed-in caller.
 *
 * Only ever applied to a cacheable exchange: a `GET` (so `query` procedures — a
 * `mutation` / `action` is `POST`-only) that produced a 2xx.
 */
type RestCacheConfig = RestCachePolicy;

/**
 * Opt-in public-surface tag attached by the `.expose({ rest: true })` builder
 * modifier (plan 167). Marks a procedure as deliberately published over the
 * public REST surface: the runtime mints a `/_lunora/rest/<namespace>/<fn>` route
 * that dispatches THROUGH the procedure (so `ctx.auth` / RLS / validators are
 * enforced), and the generated OpenAPI describes it. Everything is default-closed
 * — a procedure without this tag is unreachable over REST.
 */
interface ExposeConfig {
    /** Opt this endpoint's responses into HTTP caching. Omit to leave them uncached. */
    readonly cache?: RestCacheConfig;

    /** Publish this procedure over the public REST surface. */
    readonly rest?: boolean;
}

interface RegisteredFunction<A extends ArgsValidator, R, Kind extends FunctionKind> {
    readonly args: A;

    /**
     * Set by the `.expose({ rest: true })` builder modifier. Marks the procedure
     * as published on the public REST surface (plan 167). Absent on procedures that
     * are reachable only via typed RPC (the default).
     */
    readonly expose?: ExposeConfig;
    readonly handler: (context: unknown, args: InferArgs<A>) => Promise<R> | R;

    readonly kind: Kind;

    /**
     * Set on connection-lifecycle hooks (`onConnect` / `onDisconnect`).
     * Marks the function for the generated `LUNORA_LIFECYCLE_HOOKS` manifest so the
     * DO dispatches it on socket connect/disconnect rather than via a client RPC.
     * Absent on ordinary registrations.
     */
    readonly lifecycle?: LifecycleEventKind;

    readonly visibility?: FunctionVisibility;

    /**
     * Set by the `.x402({ price })` builder modifier. Marks the procedure as paid
     * so the origin worker gates it behind an x402 402-challenge before dispatch.
     * Absent on unpaid functions.
     */
    readonly x402?: X402ProcedureConfig;
}

type RegisteredQuery<A extends ArgsValidator, R> = RegisteredFunction<A, R, "query">;
type RegisteredMutation<A extends ArgsValidator, R> = RegisteredFunction<A, R, "mutation">;
type RegisteredAction<A extends ArgsValidator, R> = RegisteredFunction<A, R, "action">;

/**
 * Structural mirror of `@lunora/client`'s `FunctionReference` — the handle the
 * generated `api` / `internal` objects hand you, carrying `<file>:<function>`
 * in `__lunoraRef`. Redeclared here so `@lunora/server` needs no dependency on
 * the client package, exactly as {@link Scheduler} avoids one on
 * `@lunora/scheduler`. `RegisteredFunction` has no `__lunoraRef`, so the two
 * shapes never overlap.
 */
interface FunctionHandle<Kind extends "action" | "mutation" | "query" | "stream", Args, Return> {
    /** Phantom marker carrying the type parameters; never present at runtime. */
    readonly __lunoraPhantom?: { args: Args; kind: Kind; returns: Return };
    readonly __lunoraRef: string;
}

/*
 * `ctx.run*` accepts EITHER handle shape.
 *
 * `_generated/api.ts` types every entry as a `FunctionReference`, but these
 * were declared to take `RegisteredQuery` — the server-side registration
 * object — so the documented example (`ctx.runQuery(api.todos.list, args)`,
 * straight out of this package's own JSDoc) did not typecheck. There was no
 * user-side fix short of a cast at every call site; on the first large port it
 * was ~370 errors and the single largest class remaining.
 *
 * Overloads rather than a union parameter: `Args` cannot be inferred backwards
 * through `InferArgs<A>`, so the two shapes need separate inference sites. The
 * registration overload comes first so importing a module directly keeps its
 * existing, more precise behaviour.
 */

/**
 * `ctx.runQuery` — overloaded, see the note above.
 *
 * A single generic signature over the reference would be nicer (TS will not
 * contextually type a parameter against a multi-signature type, so a hand-built
 * ctx object must annotate its `(reference, args)` explicitly — see
 * `@lunora/testing`'s harness). It does not work: a concrete
 * `RegisteredQuery<{…}, number>` is not assignable to a
 * `RegisteredFunction<ArgsValidator, …>` constraint, because `handler`'s args
 * are in a contravariant position. Two inference sites it is.
 */

/**
 * Options for `ctx.runQuery`.
 *
 * Lunora's answer to Convex's `useStaleSnapshot`, and deliberately NOT a port of
 * it. Convex needs that flag because a mutation there validates its whole read
 * set at commit, so merely *reading* a hot append-only table manufactures OCC
 * conflicts. Lunora has no such conflict class: its OCC is a compare-and-swap on
 * the `__doc__` of each row a mutation actually WRITES (see `runGuardedWrite`),
 * so a read costs a mutation nothing and there is nothing for a stale snapshot
 * to relieve.
 *
 * What a read does cost here is REACTIVITY. Every table a live query touches
 * enters its read footprint, and every write to any of those tables re-runs the
 * subscription. A query that reads one hot table — an append-only audit log, a
 * counter, a feed — therefore re-runs on every append even when the append
 * cannot change its result. That is Lunora's version of the pressure Convex is
 * relieving, and {@link RunQueryOptions.untracked} is the release valve.
 */
interface RunQueryOptions {
    /**
     * Run the query without recording its reads in the CALLER's read footprint.
     * The subscription therefore does not re-run when the tables that query
     * touched change.
     *
     * The result is exactly as fresh as a tracked call — same SQLite, same
     * instant, no snapshot involved. The only thing given up is the invalidation
     * edge, so use it when the read genuinely should not wake the subscriber
     * (a monotonic counter rendered once, a config row, an audit tail whose
     * growth is irrelevant to the result) — and never for data whose change
     * should reach the client, which is what makes the subscription stale
     * indefinitely rather than merely late.
     *
     * Scoped to the sub-query and nothing else: the untracked call runs on its
     * own context, so a read interleaved on the caller's `ctx.db` while it is in
     * flight still tracks normally. That is why this is an option on
     * `ctx.runQuery` rather than a `ctx.db.untracked(...)` scope — a
     * writer-wide flag would silently swallow a concurrent read's dependency
     * (compare `meterExempt`'s documented interleaving caveat, which is
     * tolerable for a resource meter and would not be here).
     *
     * No effect outside a subscription: a one-shot query records no footprint,
     * so there is nothing to opt out of.
     */
    untracked?: boolean;
}

interface RunQuery {
    <A extends ArgsValidator, R>(reference: RegisteredQuery<A, R>, args: InferArgs<A>, options?: RunQueryOptions): Promise<R>;
    <Args, R>(reference: FunctionHandle<"query", Args, R>, args: Args, options?: RunQueryOptions): Promise<R>;
}

/** `ctx.runMutation` — overloaded for the same reason as {@link RunQuery}. */
interface RunMutation {
    <A extends ArgsValidator, R>(reference: RegisteredMutation<A, R>, args: InferArgs<A>): Promise<R>;
    <Args, R>(reference: FunctionHandle<"mutation", Args, R>, args: Args): Promise<R>;
}

/** `ctx.runAction` — overloaded for the same reason as {@link RunQuery}. */
interface RunAction {
    <A extends ArgsValidator, R>(reference: RegisteredAction<A, R>, args: InferArgs<A>): Promise<R>;
    <Args, R>(reference: FunctionHandle<"action", Args, R>, args: Args): Promise<R>;
}

/** Which side of the WebSocket lifecycle a hook fires on. */

/**
 * Which lifecycle moment a hook fires on.
 *
 * `connect`/`disconnect` are per-SOCKET and fire many times over a shard's life.
 * `init` is per-INSTANCE and fires once per cold start, before any handler runs
 * — see {@link ShardInitEvent}. `reactor` is per-WRITE-FLUSH and fires only when
 * a watched read's result changed — see `onQueryChange`.
 */
type LifecycleEventKind = "connect" | "disconnect" | "init" | "reactor";

/**
 * The event a connection-lifecycle hook receives as its second argument. It is
 * the JSON-serializable payload the DO forwards on socket connect/disconnect;
 * the verified caller identity is also reflected on `ctx.auth` (the hook runs
 * under the connecting user via `resolveIdentity`).
 */
interface LifecycleEvent {
    /** Stable per-socket id, minted at upgrade and replayed verbatim on disconnect. */
    readonly connectionId: string;
    /** App-supplied connection context from the client `connect` envelope (e.g. `{ roomId, sessionId }`). */
    readonly context?: Record<string, unknown>;
    /** The shard this socket is bound to. */
    readonly shardKey: string;
    /** Verified user id resolved at upgrade, or `null` for an anonymous socket. */
    readonly userId: string | null;
}

/**
 * A registered connection-lifecycle hook — an internal mutation tagged with the
 * lifecycle side it fires on. Produced by `onConnect` / `onDisconnect` /
 * `onShardInit`.
 */
type RegisteredLifecycleHook = RegisteredFunction<Record<string, never>, void, "mutation"> & { readonly lifecycle: LifecycleEventKind };

/**
 * The event an `onShardInit` hook receives.
 *
 * Deliberately thin, and deliberately NOT a {@link LifecycleEvent}: there is no
 * socket here. An init hook fires because the Durable Object was constructed,
 * not because anyone connected — so there is no `connectionId` to report and no
 * user to attribute it to. The hook runs as a trusted system dispatch with no
 * request identity, exactly like a cron tick; `ctx.auth` is anonymous and RLS
 * does not apply. Derive whatever you need from `shardKey` and the shard's own
 * durable tables, never from an ambient caller — there isn't one.
 */
interface ShardInitEvent {
    /** The shard this Durable Object instance serves. */
    readonly shardKey: string;
}

/**
 * A streaming query registration. Unlike {@link RegisteredFunction} the handler
 * returns an `AsyncIterable<R>` synchronously (it does NOT `Promise<R>`); the
 * runtime drives it frame by frame and forwards each chunk to the caller. The
 * third `signal` argument is wired to the caller's cancel signal so the handler
 * can stop early — break out of the loop or check `signal.aborted` between
 * yields.
 */
interface RegisteredStream<A extends ArgsValidator, R> {
    readonly args: A;

    /**
     * Present when the stream was declared `durable`. Chunks are persisted per
     * run before they reach a socket, the producer outlives the socket that
     * opened it, and a reconnecting (or second) client attaches to the same run
     * and replays what it missed. See {@link DurableStreamOptions}.
     */
    readonly durable?: DurableStreamOptions;
    readonly handler: (context: unknown, args: InferArgs<A>, signal: AbortSignal) => AsyncIterable<R>;
    readonly kind: "stream";
    readonly visibility?: FunctionVisibility;
}

/**
 * Durability settings for a `.stream()` procedure.
 *
 * A run is identified by the socket's verified identity plus the function path
 * and arguments, so two clients of the SAME user calling the same stream with
 * the same arguments observe one producer and one transcript. That identity is
 * the feature: it is what makes a reload resume rather than re-generate, and
 * what lets a second tab watch the same answer. A different identity always gets
 * its own run.
 *
 * Sharing applies to a run still in flight. Once a run finishes, a later caller
 * asking the same question gets a fresh one — a transcript is the record of one
 * execution, not a cached response.
 *
 * **What an attach does not do:** it replays a transcript, it does not re-run the
 * handler — so the procedure's middleware chain (`.use(rls(...))`, rate limits,
 * any custom guard) runs once, for the caller that started the run. That is why
 * the run key is identity-scoped: a guard that has already passed for one user
 * must never be skipped for another.
 */
interface DurableStreamOptions {
    /**
     * How long a finished transcript is kept before it is trimmed, in
     * milliseconds. Defaults to 24 hours — long enough to survive a reload and
     * a commute, short enough that a chatty shard doesn't accumulate
     * transcripts forever.
     */
    readonly ttlMs?: number;
}

// --- Context types -----------------------------------------------------------

/** The system tables `ctx.db.system` can read. */
type SystemTableName = "_scheduled_functions" | "_storage";

/**
 * A pending scheduled invocation as surfaced by the `_scheduled_functions`
 * system table. Mirrors {@link ScheduledJob} (the `ctx.scheduler` view); the
 * separate name keeps the system-table read surface self-describing.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface ScheduledFunctionDoc {
    /** Function arguments the job will be dispatched with. */
    args: Record<string, unknown>;
    /** Number of dispatch attempts already made (absent until the first retry). */
    attempts?: number;
    /** When the job was enqueued (epoch ms). */
    enqueuedAt: number;

    /**
     * Fully-qualified `ns:fn` path of the function to invoke. Absent when the job
     * targets a durable workflow/agent instead — exactly one of `functionPath` /
     * {@link ScheduledFunctionDoc.workflow} is set on any given row.
     */
    functionPath?: string;
    /** The job's id (the `_scheduled_functions` row id). */
    id: string;
    /** Logical workpool the job is concurrency-gated by, when any. */
    pool?: string;
    /** When the job is scheduled to fire (epoch ms). */
    scheduledFor: number;
    /** Routing hint forwarded so dispatch lands on the right shard. */
    shardKey?: string;

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding a fresh durable instance is started from
     * on fire (the {@link ScheduledFunctionDoc.args} become its `params`). Set
     * instead of {@link ScheduledFunctionDoc.functionPath}.
     */
    workflow?: string;
}

/** Maps each system table name to the document shape its reads return. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- internal map for the public SystemDoc/SystemDatabaseReader names; mirrors Convex's `Doc` naming
interface SystemDocMap {
    _scheduled_functions: ScheduledFunctionDoc;
    _storage: StorageMetadata;
}

/** Document type for a given system table name. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
type SystemDoc<T extends SystemTableName> = SystemDocMap[T];

/** Terminal returned by {@link SystemDatabaseReader.query}; only `.collect()` is supported. */
interface SystemQuery<T extends SystemTableName> {
    /** Resolve the full list of rows in the backing source. */
    collect: () => Promise<SystemDoc<T>[]>;
}

/**
 * Read-only reader over Lunora's system tables (`_scheduled_functions`,
 * `_storage`), exposed as `ctx.db.system`. Mirrors Convex's `ctx.db.system`.
 *
 * **Best-effort and eventually consistent.** Unlike `ctx.db.<table>` — which
 * reads the shard's transactional SQLite snapshot — the data behind these tables
 * lives OUTSIDE the shard (scheduled functions in the `SchedulerDO`, storage
 * objects in R2). Every `collect()` / `get()` reaches across to that source.
 *
 * It is **not part of the mutation transaction snapshot** (no OCC guard, no
 * subscription dependency recorded — reading it inside a mutation does not pin
 * it), and results are **eventually consistent** with writes a mutation just
 * made (e.g. a freshly scheduled job may not appear yet).
 *
 * Read-only by design: mutate scheduled jobs via `ctx.scheduler`, storage
 * objects via `ctx.storage`.
 */
interface SystemDatabaseReader {
    /**
     * Resolve a single system-table row by id, or `null` when absent.
     * (`_scheduled_functions` → job id; `_storage` → object key.)
     */
    get: <T extends SystemTableName>(table: T, id: string) => Promise<SystemDoc<T> | null>;

    /**
     * Begin a read over a system table; call `.collect()` to resolve the full
     * list. No filtering, indexing, or pagination — the backing source is remote
     * and the surface stays deliberately minimal.
     */
    query: <T extends SystemTableName>(table: T) => SystemQuery<T>;
}

/**
 * Read-only handle bound to a table. Used by `query`/`mutation`/`action`. The
 * actual SQL implementation lives in `@lunora/do`; these are signatures only.
 */
interface DatabaseReader {
    /**
     * The throwing sibling of {@link DatabaseReader.normalizeId}: brand `id` as an
     * {@link Id} for `tableName`, or throw `BAD_REQUEST` when it is not structurally
     * an id. Pure — it never reads the database, so a valid id for a row that
     * doesn't exist still returns.
     *
     * This is the **parse boundary** for an id that arrived as a plain `string`: a
     * wire payload, a mutator's args, a change plan computed on the client. The
     * alternative is `value as Id<"table">` at every such call site — an assertion,
     * not a check, and one that has to be repeated for every table a helper is
     * generic over:
     *
     * ```ts
     * for (const patch of plan.patches) {
     *     await ctx.db.patch(ctx.db.asId("nodes", patch.id), patch.fields);
     * }
     * ```
     *
     * Ids are opaque strings, so the check is exactly `normalizeId`'s: it rejects
     * empty, whitespace-bearing, and NUL-bearing values, not "an id that isn't in
     * this table". Use it to get the brand honestly, and `get()` to learn whether
     * the row exists.
     */
    asId: <T extends string>(tableName: T, id: string) => Id<T>;
    get: <T extends string>(id: Id<T>) => Promise<Record<string, unknown> | null>;

    /**
     * Validate an untrusted `id` string against the structural shape of an id
     * for `tableName`, returning the branded {@link Id} when it is well-formed
     * and `null` otherwise. Pure structural validation — it never reads the
     * database, so a structurally valid id for a row that doesn't exist still
     * returns the branded id (mirrors Convex's `db.normalizeId`).
     */
    normalizeId: <T extends string>(tableName: T, id: string) => Id<T> | null;
    query: (tableName: string) => TableReader;

    /**
     * Best-effort, read-only reader over Lunora's system tables
     * (`_scheduled_functions`, `_storage`). Eventually consistent and **not**
     * part of the transaction snapshot — see {@link SystemDatabaseReader}.
     */
    readonly system: SystemDatabaseReader;
}

/** Options for {@link TableReader.paginate} — Convex-compatible page request. */
interface PaginationOptions {
    /** Opaque cursor from the prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;

    /**
     * Optional inclusive upper bound for reactive pagination. When supplied the
     * page covers the fixed half-open range `(cursor, endCursor]` (ignoring
     * `numItems`): every row strictly after `cursor` up to and including the
     * boundary row `endCursor` encodes. The page's `isDone` is `true` and its
     * `continueCursor` echoes `endCursor`, so the next page keeps starting where
     * this one ends even as rows are inserted/deleted inside the range. Omit (or
     * pass `null`) for the legacy "first `numItems` after `cursor`" behaviour.
     */
    endCursor?: null | string;
    /** Maximum rows to return for this page. */
    numItems: number;
}

/** One page of a keyset-paginated query. */
interface PaginationResult<T = Record<string, unknown>> {
    /** Cursor to pass back for the next page, or `null` once `isDone`. */
    continueCursor: null | string;
    /** `true` when this page is the last one. */
    isDone: boolean;
    page: T[];

    /**
     * Reactive-pagination only: the midpoint cursor of a bounded
     * `(cursor, endCursor]` page, used by the client to split an over-grown page
     * into two adjacent ranges. Absent on legacy (open-ended) pages.
     */
    splitCursor?: null | string;
}

/**
 * The fluent `ctx.db.query(table)` reader. Generic over the document type
 * `Row` so the generated `ctx.db` can bind it to `Doc<table>` (the chain and
 * every terminal then resolve typed rows — no `as unknown as Doc<...>` casts),
 * and over the table's declared index names so `.withIndex()` / `.withSearchIndex()`
 * / `.withGeoIndex()` reject a name the table does not declare.
 *
 * All four default to the untyped shape for the base (schema-agnostic)
 * `@lunora/server` reader, which is also the wide `(table: string) => TableReader`
 * overload the generated `ctx.db` intersects in — so a caller holding a runtime
 * string (e.g. `@lunora/ratelimit`'s `createDbStore`) is unaffected.
 *
 * The index-name parameters are what make a stale index name a compile error.
 * They resolve to `never` for a table that declares none of that kind, so the
 * only way to satisfy the call is to declare the index. Before this, a renamed
 * or dropped index left its call sites typechecking, and the query either threw
 * at runtime or silently degraded to a full table scan — the second being the
 * worse outcome, since it stays green in tests and surfaces months later as a
 * latency regression.
 *
 * **Why `with*` are method signatures and everything else is a property.**
 * Narrowing a parameter makes the enclosing type contravariant in it, so as
 * function properties these would make a BOUND reader
 * (`TableReader<Doc, "by_x">`, what `ctx.db.query(t)` returns) unassignable to
 * the unbound `TableReader<Doc>` — quietly breaking every helper factored as
 * `(reader: TableReader<Doc<"users">>) => …`, which is the obvious way to share
 * query logic. A method signature is bivariant in its parameters, which keeps
 * that direction working while the narrow parameter still rejects an undeclared
 * name at the call site. Both directions are pinned in `types.test-d.ts`.
 */
interface TableReader<
    Row = Record<string, unknown>,
    Indexes extends string = string,
    SearchIndexes extends string = string,
    GeoIndexes extends string = string,
> {
    /**
     * Iterate rows lazily: `for await (const row of ctx.db.query("t").withIndex(…))`.
     *
     * Pages through the result set behind the scenes and yields row by row, so
     * a consumer that stops early stops the reads too. `.collect()` is still the
     * right terminal when you want the whole set; this exists for the cases
     * where you cannot know up front how far you need to read.
     *
     * That is what merged/ordered index streams need. Reimplementing Convex's
     * `convex-helpers/server/stream` in userland previously meant materialising
     * each branch with a bounded `.take(1024)` before merging, so asking a
     * merged stream for ONE row read up to 1,024 rows per branch. The k-way merge itself is application code and stays there — only
     * the laziness had to come from the database layer.
     *
     * Iteration pages through `.paginate()`, so it follows the same order —
     * which is `.collect()`'s order whenever the sort key is unique. Under a
     * TIED sort key (an unindexed read whose rows share `_creationTime`) the
     * two can disagree, because the tie-break is left to SQLite. Read through
     * an index when order matters, exactly as you would for `.paginate()`.
     */
    [Symbol.asyncIterator]: () => AsyncIterator<Row>;
    collect: () => Promise<Row[]>;
    filter: (predicate: (document: Row) => boolean) => TableReader<Row, Indexes, SearchIndexes, GeoIndexes>;
    first: () => Promise<Row | null>;

    /**
     * Set the result order. Orders by the active `.withIndex()` (or by
     * `_creationTime` when none is staged), `"asc"` by default; `"desc"`
     * reverses it. Composes with `.withIndex()`, `.filter()`, and every
     * terminal (`collect`/`first`/`take`/`paginate`/`unique`). Mirrors Convex's
     * `.order("asc" | "desc")`.
     */
    order: (direction: "asc" | "desc") => TableReader<Row, Indexes, SearchIndexes, GeoIndexes>;
    paginate: (options: PaginationOptions) => Promise<PaginationResult<Row>>;
    take: (limit: number) => Promise<Row[]>;

    /**
     * Return the single matching document. Returns `null` when nothing matches
     * and throws when more than one row matches. Mirrors Convex's `.unique()`.
     */
    unique: () => Promise<Row | null>;

    /**
     * Restrict the query to a declared `.geoIndex()`. The builder's
     * `.near(point, radiusMeters)` returns rows within `radiusMeters` of `point`,
     * ordered nearest-first; `.within(bbox)` returns rows inside the
     * latitude/longitude bounding box. Both resolve as a geohash-prefix range
     * scan over the index's companion followed by a Haversine refine. Pair with
     * `.take(n)` to cap results (`.paginate()` is not supported on a geo query).
     */
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- deliberate: a method signature is BIVARIANT in its parameters, a function property is not. Written as a property, narrowing the index-name parameter would make a bound `TableReader<Doc, "by_x">` unassignable to a helper typed `TableReader<Doc>` — a silent breaking change to a published type. The narrow parameter still rejects an undeclared name at the call site.
    withGeoIndex(indexName: GeoIndexes, build: (q: GeoFilterBuilder) => GeoFilterBuilder): TableReader<Row, Indexes, SearchIndexes, GeoIndexes>;

    /**
     * Restrict the query to a declared `.index()`. `indexName` is constrained to
     * this table's declared index names (`never` when it declares none), so a
     * renamed, dropped, or mistyped index is a compile error rather than a
     * runtime throw or a silent full-table scan.
     */
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- deliberate: a method signature is BIVARIANT in its parameters, a function property is not. Written as a property, narrowing the index-name parameter would make a bound `TableReader<Doc, "by_x">` unassignable to a helper typed `TableReader<Doc>` — a silent breaking change to a published type. The narrow parameter still rejects an undeclared name at the call site.
    withIndex(indexName: Indexes, range?: (q: IndexRangeBuilder) => IndexRangeBuilder): TableReader<Row, Indexes, SearchIndexes, GeoIndexes>;

    /**
     * Restrict the query to a declared `.searchIndex()`. The builder's
     * `.search(field, query)` runs a full-text match against the index's
     * searchable field; `.eq(field, value)` narrows by a declared filter
     * field. Results come back ordered by relevance — pair with `.take(n)`
     * (`.paginate()` is not supported on a search query).
     */
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- deliberate: a method signature is BIVARIANT in its parameters, a function property is not. Written as a property, narrowing the index-name parameter would make a bound `TableReader<Doc, "by_x">` unassignable to a helper typed `TableReader<Doc>` — a silent breaking change to a published type. The narrow parameter still rejects an undeclared name at the call site.
    withSearchIndex(indexName: SearchIndexes, search: (q: SearchFilterBuilder) => SearchFilterBuilder): TableReader<Row, Indexes, SearchIndexes, GeoIndexes>;
}

interface IndexRangeBuilder {
    eq: (field: string, value: unknown) => IndexRangeBuilder;
    gt: (field: string, value: unknown) => IndexRangeBuilder;
    gte: (field: string, value: unknown) => IndexRangeBuilder;
    lt: (field: string, value: unknown) => IndexRangeBuilder;
    lte: (field: string, value: unknown) => IndexRangeBuilder;
}

/** Builder passed to {@link TableReader.withSearchIndex}; mirrors Convex's search query. */
interface SearchFilterBuilder {
    /** Narrow by a declared filter field (exact match). */
    eq: (field: string, value: unknown) => SearchFilterBuilder;
    /** Full-text match `query` against the index's searchable `field`. Call exactly once. */
    search: (field: string, query: string) => SearchFilterBuilder;
}

/** A latitude/longitude point (WGS84 decimal degrees) accepted by geo queries. */
interface GeoPointInput {
    lat: number;
    lng: number;
}

/**
 * An axis-aligned latitude/longitude bounding box: `sw` is the south-west
 * (min lat, min lng) corner, `ne` the north-east (max lat, max lng) corner.
 */
interface GeoBoundingBox {
    ne: GeoPointInput;
    sw: GeoPointInput;
}

/**
 * Builder passed to {@link TableReader.withGeoIndex}. Call exactly one of
 * `.near(...)` / `.within(...)` — the two are mutually exclusive proximity vs
 * bounding-box modes.
 */
interface GeoFilterBuilder {
    /** Rows within `radiusMeters` of `point`, resolved nearest-first. Call exactly once. */
    near: (point: GeoPointInput, radiusMeters: number) => GeoFilterBuilder;
    /** Rows whose point falls inside the bounding `box`. Call exactly once. */
    within: (box: GeoBoundingBox) => GeoFilterBuilder;
}

/**
 * Options shared by the batch-write methods (`insertMany`/`deleteMany`/
 * `patchMany`) — a per-call payload cap. The default cap (500) rejects an
 * oversized call up front so an accidental O(n²) or a payload past the Durable
 * Object request limit fails loudly instead of degrading the mutation. Callers
 * with larger sets should chunk their own loop or raise `limit`.
 */
interface BatchWriteOptions {
    /** Reject the call when the batch size exceeds this value (default 500). */
    limit?: number;
}

/** Options accepted by {@link DatabaseWriter.insertMany} and the per-table facade. */
interface InsertManyOptions extends BatchWriteOptions {
    /**
     * When `true`, a UNIQUE-constraint breach for a row resolves to `null`
     * instead of throwing — the rest of the batch is still inserted. Skipped rows
     * keep their input-order slot with `null` in the returned array. Mirrors
     * better-drizzle's `createMany({ skipDuplicates: true })`.
     */
    skipDuplicates?: boolean;
}

interface DatabaseWriter extends DatabaseReader {
    delete: <T extends string>(id: Id<T>) => Promise<void>;

    /**
     * Delete EVERY row in `tableName`, chunking internally until the table is
     * empty — the erasure primitive.
     *
     * Unlike `deleteWhere(tableName, {})` there is **no batch cap**: a
     * `BATCH_LIMIT_EXCEEDED` at row 501 of an account deletion is a bug, not a
     * safety rail. Rows still go through the single-row delete pipeline, so
     * triggers, cascades, companions, CDC, and live subscriptions stay correct.
     *
     * On a `.softDelete()` table the default flips the marker column; pass
     * `{ hard: true }` to remove the rows physically (what GDPR erasure means).
     */
    deleteAll: (tableName: string, options?: { chunkSize?: number; hard?: boolean }) => Promise<{ deleted: number }>;

    /**
     * Delete many rows by id in one call. Each id is deleted through the full
     * single-row pipeline (triggers + per-row RLS). The returned `deleted` is the
     * number of ids **requested**, not the rows actually removed — an unknown or
     * duplicated id is a silent no-op.
     *
     * **Atomic within a mutation:** the DO wraps a mutation's dispatch in a
     * BEGIN/COMMIT span, so a mid-batch failure (a later RLS denial or handler
     * error) rolls back the whole mutation. (In an action there is no transaction
     * span, so the prior deletes persist; the in-memory test harness mirrors the span.)
     */
    deleteMany: <T extends string>(ids: ReadonlyArray<Id<T>>, options?: BatchWriteOptions) => Promise<{ deleted: number }>;

    /**
     * Delete every row matching `where` in one call. Matching rows are resolved
     * first, then each row is deleted through the single-row delete pipeline
     * (triggers, companion sync, CDC, broadcast) so reactive subscriptions and
     * search/aggregate companions stay correct.
     *
     * **Atomic within a mutation:** the DO wraps a mutation's dispatch in a
     * BEGIN/COMMIT span, so a mid-batch failure rolls back the whole mutation.
     */
    deleteWhere: (tableName: string, where: Record<string, unknown>, options?: BatchWriteOptions) => Promise<{ deleted: number }>;

    /**
     * Insert a document, returning its server id.
     *
     * Pass `options.clientId` (a UUID) to key the row yourself — for an
     * optimistic client that needs the persisted row to match the key it
     * already rendered. It's validated for shape and still subject to the
     * primary-key uniqueness constraint; omit it and the server mints the id.
     */
    insert: <T extends string>(tableName: T, document: Record<string, unknown>, options?: { clientId?: string }) => Promise<Id<T>>;

    /**
     * Insert many documents into one table in a single call, returning the
     * minted ids in input order. Equivalent to a per-row `insert()` loop — each
     * row gets defaults, validators, triggers, and a per-row RLS check — but the
     * caller pays one round-trip instead of N.
     *
     * Pass `{ skipDuplicates: true }` to turn UNIQUE-constraint breaches into
     * `null` results for that row instead of failing the whole batch; the rest of
     * the batch is still inserted and order is preserved.
     *
     * **Atomic within a mutation:** the DO wraps a mutation's dispatch in a
     * BEGIN/COMMIT span, so a mid-batch failure (an invalid or RLS-denied row)
     * rolls back the whole mutation. (In an action there is no transaction span,
     * so the prior inserts persist; the in-memory test harness mirrors the span.)
     */
    insertMany: {
        <T extends string>(
            tableName: T,
            documents: ReadonlyArray<Record<string, unknown>>,
            options: BatchWriteOptions & { skipDuplicates: true },
        ): Promise<(Id<T> | null)[]>;
        <T extends string>(tableName: T, documents: ReadonlyArray<Record<string, unknown>>, options?: InsertManyOptions): Promise<Id<T>[]>;
    };

    /**
     * **Trusted** bulk insert: one multi-row `INSERT` that **skips per-row
     * `.check()` validators and before/after triggers** for throughput on data you
     * control (seed, migration, admin import). Defaults, ids, and every companion
     * (search/aggregate/rank/CDC + live subscriptions) are still applied, so reads
     * stay correct.
     *
     * It is **"unsafe" only in that it bypasses the validation/trigger pipeline** —
     * RLS is **not** bypassed: secure-by-default and the table's insert policy still
     * apply (the framework ships no RLS-bypassing writer). Pass `allowExplicitId` to
     * preserve a supplied `_id` (import). Use only for data you trust; prefer
     * `insertMany` for anything user-supplied.
     */
    insertManyUnsafe: <T extends string>(
        tableName: T,
        documents: ReadonlyArray<Record<string, unknown>>,
        options?: BatchWriteOptions & { allowExplicitId?: boolean },
    ) => Promise<Id<T>[]>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;

    /**
     * Patch many rows by id in one call. Each `{ id, patch }` is applied like a
     * single `patch()` (per-row triggers + RLS). Returns the number of rows
     * actually patched.
     *
     * **Atomic within a mutation:** the DO wraps a mutation's dispatch in a
     * BEGIN/COMMIT span, so a mid-batch failure rolls back the whole mutation.
     * (In an action there is no transaction span, so the prior patches persist;
     * the in-memory test harness mirrors the span.)
     */
    patchMany: <T extends string>(
        patches: ReadonlyArray<{ id: Id<T>; patch: Record<string, unknown> }>,
        options?: BatchWriteOptions,
    ) => Promise<{ patched: number }>;

    /**
     * Patch every row matching `where` with the same `patch` in one call. The
     * matching rows are resolved first, then each row is updated through the
     * single-row patch pipeline (OCC, triggers, companion sync, CDC, broadcast)
     * so reactive subscriptions and search/aggregate companions stay correct.
     *
     * **Atomic within a mutation:** the DO wraps a mutation's dispatch in a
     * BEGIN/COMMIT span, so a mid-batch failure rolls back the whole mutation.
     */
    patchWhere: (
        tableName: string,
        args: { patch: Record<string, unknown>; where: Record<string, unknown> },
        options?: BatchWriteOptions,
    ) => Promise<{ patched: number }>;
    replace: <T extends string>(id: Id<T>, document: Record<string, unknown>) => Promise<void>;

    /**
     * Erase every shard-local table — the account-deletion / tenant-teardown
     * primitive. Sweeps the schema's non-`.global()` tables with
     * {@link DatabaseWriter.deleteAll}`({ hard: true })` and returns the per-table
     * counts.
     *
     * `.global()` tables are skipped by design: their rows live in D1 and are shared
     * across shards, so "wipe this shard" must not reach them. Restrict the sweep
     * with `options.tables`, or spare one with `options.exclude` (e.g. an audit log
     * that must outlive the data).
     *
     * ```ts
     * export const deleteAccount = internalMutation({ handler: async ({ ctx }) => ctx.db.wipeShard() });
     * ```
     */
    wipeShard: (options?: { chunkSize?: number; exclude?: ReadonlyArray<string>; tables?: ReadonlyArray<string> }) => Promise<{
        deleted: number;
        tables: Record<string, number>;
    }>;
}

/** Authenticated identity surfaced into every context. */
interface AuthState {
    getIdentity: () => Promise<Record<string, unknown> | null>;
    readonly userId: string | null;
}

/**
 * A pending scheduled invocation as surfaced by {@link Scheduler.list} /
 * {@link Scheduler.get}. A clean public mirror of `@lunora/scheduler`'s
 * `ScheduleRecord`, re-declared so the public ctx surface names its own type
 * rather than re-exporting the scheduler's. It must stay field-for-field
 * identical: `__tests__/scheduler-mirror.test.ts` asserts mutual assignability
 * against the real `ScheduleRecord` and fails `lint:types` if either side moves.
 */
interface RetryPolicy {
    /** Backoff growth across attempts. Default `"exponential"`. */
    backoff?: "exponential" | "linear";
    /** Base delay in milliseconds for the first retry. Default `30_000`. */
    baseMs?: number;
    /** Maximum number of dispatch attempts before dead-lettering. Default `5`. */
    maxAttempts?: number;
    /** Optional ceiling clamping the computed backoff delay. */
    maxMs?: number;
}

interface ScheduledJob {
    args: Record<string, unknown>;
    /** Number of dispatch attempts already made (absent until the first retry). */
    attempts?: number;
    /** When the job was enqueued (epoch ms). */
    enqueuedAt: number;

    /**
     * The `ns:fn` path of the function to dispatch on fire. Absent when the job
     * targets a durable workflow/agent instead — see {@link ScheduledJob.workflow}.
     * Exactly one of `functionPath` / `workflow` is set.
     */
    functionPath?: string;
    id: string;
    /** Scheduler/workpool instance the job was enqueued through. Absent for the default instance. */
    instanceName?: string;
    /** Logical workpool the job is concurrency-gated by. Absent for plain `runAfter`/`runAt` jobs. */
    pool?: string;
    /** Per-job retry policy; absent means the scheduler's built-in defaults. */
    retry?: RetryPolicy;
    /** When the job is scheduled to fire (epoch ms). */
    scheduledFor: number;
    /** Routing hint forwarded so dispatch lands on the right shard. */
    shardKey?: string;

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding name a fresh durable instance is started
     * from on fire (the {@link ScheduledJob.args} become its `params`). Set
     * instead of {@link ScheduledJob.functionPath}.
     */
    workflow?: string;
}

/**
 * A schedulable durable-workflow reference — the generated `workflows.<name>` /
 * `agents.<name>` object, which carries its `WORKFLOW_*`/`AGENT_*` binding and
 * stable name. Structural mirror of `@lunora/scheduler`'s `WorkflowReference` so
 * `ctx.scheduler` can target a workflow/agent without a dependency on
 * `@lunora/scheduler` / `@lunora/workflow`. A scheduled workflow target starts a
 * fresh instance on fire (the args become its `params`).
 */
interface SchedulableWorkflowReference {
    /** The `WORKFLOW_*`/`AGENT_*` binding name (present on a generated ref). */
    readonly binding?: string;
    readonly isLunoraWorkflow: true;
    /** The workflow/agent export/stable name (present on a generated ref). */
    readonly name?: string;
}

/**
 * What `ctx.scheduler.runAfter` / `runAt` accept as a target:
 *
 * - a generated `internal.<file>.<fn>` / `api.<file>.<fn>` reference to a
 * mutation or action — the form the docs and the setup skills use, and the one
 * `@lunora/scheduler` has always resolved at runtime (it reads `__lunoraRef`);
 * - the equivalent `"file:fn"` path string;
 * - a generated `workflows.<name>` / `agents.<name>` reference, which starts a
 * fresh durable instance on fire.
 *
 * A `query` is not schedulable — a deferred job exists to have an effect.
 */
type SchedulableTarget = FunctionHandle<"action" | "mutation", unknown, unknown> | SchedulableWorkflowReference | string;

interface Scheduler {
    /** Cancel a pending job by id. `cancelled` is `false` when no such job exists. */
    cancel: (id: string) => Promise<{ cancelled: boolean }>;
    /** Resolve a single pending job by id, or `null` when absent. */
    get: (id: string) => Promise<ScheduledJob | null>;
    /** List all pending scheduled jobs. */
    list: () => Promise<ScheduledJob[]>;

    /**
     * Schedule a one-shot run `delayMs` from now; see {@link SchedulableTarget}
     * for the accepted targets. A workflow/agent reference starts a fresh
     * durable instance on fire (the args become its `params`).
     */
    runAfter: (delayMs: number, target: SchedulableTarget, args?: Record<string, unknown>) => Promise<string>;
    /** Like {@link Scheduler.runAfter} but fires at an absolute epoch-ms timestamp. */
    runAt: (timestampMs: number, target: SchedulableTarget, args?: Record<string, unknown>) => Promise<string>;
}

// --- Durable workflows -------------------------------------------------------

/**
 * A workflow instance's lifecycle status. Clean public mirror of
 * `@lunora/workflow`'s `WorkflowInstanceStatus` (itself a mirror of Cloudflare's
 * `WorkflowInstanceStatus`) — re-declared here so the ctx surface carries no
 * dependency on the workflow package, exactly as {@link Scheduler} avoids a
 * dependency on `@lunora/scheduler`.
 */
type WorkflowInstanceStatus = "complete" | "errored" | "paused" | "queued" | "running" | "terminated" | "unknown" | "waiting" | "waitingForPause";

/** Result of {@link WorkflowInstance.status}. Mirrors `@lunora/workflow`'s `WorkflowStatusResult`. */
interface WorkflowStatusResult {
    error?: { message: string; name: string };
    output?: unknown;
    status: WorkflowInstanceStatus;
}

/** Options accepted by {@link WorkflowHandle.create}. Mirrors `@lunora/workflow`'s `WorkflowCreateOptions`. */
interface WorkflowCreateOptions<Params = Record<string, unknown>> {
    /** Unique-within-the-workflow instance id. Generated by Cloudflare when omitted. */
    id?: string;
    /** The event payload the instance is triggered with — surfaced as `event.payload`. */
    params?: Params;
    /** Instance retention policy (defaults to the account maximum). */
    retention?: { errorRetention?: string; successRetention?: string };
}

/**
 * One declared external event a workflow waits on. Mirrors `@lunora/workflow`'s
 * `WorkflowEventDefinition` — the value `defineWorkflowEvent` returns, taken by
 * both {@link WorkflowInstance.sendEvent} and the workflow's `ctx.waitForEvent`.
 */
interface WorkflowEventDefinition<Payload = unknown> {
    readonly isLunoraWorkflowEvent: true;
    readonly payload: Validator<Payload>;
    readonly type: string;
}

/** A live handle to a single workflow instance. Mirrors `@lunora/workflow`'s `WorkflowInstanceLike`. */
interface WorkflowInstance {
    readonly id: string;
    pause: () => Promise<void>;
    restart: () => Promise<void>;
    resume: () => Promise<void>;
    sendEvent: (event: { payload: unknown; type: string }) => Promise<void>;
    status: () => Promise<WorkflowStatusResult>;
    terminate: () => Promise<void>;
}

/**
 * A typed handle to one declared workflow, addressable from `ctx.workflows`.
 * Mirrors `@lunora/workflow`'s `WorkflowHandle`.
 */
interface WorkflowHandle<Params = Record<string, unknown>> {
    /** Start a new instance (optionally with an id + params). */
    create: (options?: WorkflowCreateOptions<Params>) => Promise<WorkflowInstance>;
    /** Start many instances in one batched RPC. */
    createBatch: (batch: ReadonlyArray<WorkflowCreateOptions<Params>>) => Promise<WorkflowInstance[]>;
    /** Get a handle to an existing instance by id. */
    get: (id: string) => Promise<WorkflowInstance>;
    /** Deliver a declared event (`defineWorkflowEvent`) to one instance; the payload is validated before the send. */
    sendEvent: <Payload>(instanceId: string, event: WorkflowEventDefinition<Payload>, payload: Payload) => Promise<void>;
}

/**
 * The `ctx.workflows` surface on {@link MutationCtx} / {@link ActionCtx}. Each
 * workflow declared in `lunora/workflows.ts` is reachable by its export name;
 * codegen narrows the `get(name)` overloads to the known workflow names + their
 * inferred param types. Mirrors `@lunora/workflow`'s `Workflows`.
 */
interface Workflows {
    /** Resolve the handle for a declared workflow by export name. */
    get: <Params = Record<string, unknown>>(name: string) => WorkflowHandle<Params>;
}

// --- Workers Cache (action-only) --------------------------------------------

/**
 * Programmatic cache purge surface exposed on {@link ActionCtx}. Actions run
 * in the Worker (not the DO), so they can reach the Worker's `ctx.cache.purge`.
 * Queries and mutations do not expose this — they run inside the Durable Object.
 */
interface CachePurge {
    /**
     * Purge cached responses matching the given tags, or everything when
     * `purgeEverything` is true. Only available in action handlers.
     */
    purge: (options: { purgeEverything?: boolean; tags?: string[] }) => Promise<unknown>;
}

// --- Secrets Store (core built-in) -------------------------------------------

/**
 * Structural projection of workers-types' `SecretsStoreSecret` binding — the
 * per-secret `secrets_store_secrets[]` binding whose `.get()` resolves the
 * secret value (or throws if it does not exist). Mirrored structurally so the
 * runtime resolves it without a workerd type dependency.
 */
interface SecretsStoreSecretLike {
    get: () => Promise<string>;
}

/**
 * `ctx.secrets` — read account-level secrets bound via Cloudflare Secrets Store.
 * A core built-in (always present on every context, like `ctx.log`): a binding
 * named in wrangler's `secrets_store_secrets[]` is read by its binding name.
 *
 * ```ts
 * const apiKey = await ctx.secrets.get("STRIPE_KEY");
 * ```
 *
 * The lookup is async (the platform fetches and decrypts on first read);
 * reading an undeclared name throws a directed error naming the bound secrets.
 */
interface Secrets {
    /** Resolve a Secrets Store secret by its wrangler binding name. */
    get: (name: string) => Promise<string>;
}

// --- Lifecycle triggers ------------------------------------------------------

/** Lifecycle phase relative to the SQL write. */
type TriggerTiming = "after" | "before";

/** The CRUD operation a trigger reacts to. `patch` and `replace` both map to `update`. */
type TriggerOp = "delete" | "insert" | "update";

/**
 * A row as observed by a trigger handler: the table's `Shape` (with the same
 * optionality rules as {@link InferArgs}) plus the system columns every stored
 * doc carries.
 */
type TriggerRow<Shape extends Record<string, Validator>> = { [K in keyof Shape as undefined extends Infer<Shape[K]> ? K : never]?: Infer<Shape[K]> } & {
    [K in keyof Shape as undefined extends Infer<Shape[K]> ? never : K]: Infer<Shape[K]>;
} & {
    readonly _creationTime: number;
    readonly _id: string;
};

/** What an `insert` trigger observes: the freshly written row. */
interface TriggerInsertEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly doc: TriggerRow<Shape>;
    readonly id: string;
    readonly op: "insert";
    readonly table: string;
}

/**
 * What an `update` trigger observes: the merged row plus the pre-write row.
 * `previous` is typed as always present (the row must exist to be updated); the
 * runtime supplies it best-effort and only omits it in the unreachable
 * row-vanished-mid-write case.
 */
interface TriggerUpdateEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly doc: TriggerRow<Shape>;
    readonly id: string;
    readonly op: "update";
    readonly previous: TriggerRow<Shape>;
    readonly table: string;
}

/**
 * What a `delete` trigger observes: the row about to be (or just) removed.
 * `previous` is typed as always present; the runtime supplies it best-effort
 * and only omits it in the unreachable row-vanished-mid-write case.
 */
interface TriggerDeleteEvent<Shape extends Record<string, Validator> = Record<string, Validator>> {
    readonly id: string;
    readonly op: "delete";
    readonly previous: TriggerRow<Shape>;
    readonly table: string;
}

/** Union of every trigger event, with the table `Shape` erased (as stored in `triggerMap`). */
type TriggerEvent = TriggerDeleteEvent | TriggerInsertEvent | TriggerUpdateEvent;

/** Page returned by {@link TriggerDatabase.findMany}; mirrors `@lunora/do`'s `QueryPage`. */
interface TriggerQueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

/** Args accepted by {@link TriggerDatabase} reads; mirrors `@lunora/do`'s `QueryArgs`. */
interface TriggerQueryArgs {
    cursor?: null | string;
    limit?: number;
    orderBy?: ReadonlyArray<unknown>;
    where?: Record<string, unknown>;
    with?: Record<string, unknown>;
}

/**
 * Args accepted by {@link TriggerDatabase.aggregate} — structural mirror of
 * `@lunora/do`'s `AggregateOptions`, kept local so trigger handlers in
 * `@lunora/server` don't take a hard dep on the DO runtime.
 */
interface TriggerAggregateOptions {
    baseWhere?: Record<string, unknown>;
    field?: string;
    op: AggregateOp;
    restrictsCounts?: boolean;
    where?: Record<string, unknown>;
}

/** Args accepted by {@link TriggerDatabase.groupBy}. */
interface TriggerGroupByOptions {
    agg?: { field?: string; op: AggregateOp };
    baseWhere?: Record<string, unknown>;
    by: ReadonlyArray<string>;
    restrictsCounts?: boolean;
    where?: Record<string, unknown>;
}

/** One entry returned by {@link TriggerDatabase.groupBy}. */
interface TriggerGroupByEntry {
    key: Record<string, unknown>;
    value: null | number;
}

/** Args accepted by {@link TriggerDatabase.rank}. */
interface TriggerRankOptions {
    baseWhere?: Record<string, unknown>;
    restrictsCounts?: boolean;
    /** Either the row id or the full row document. */
    row: Record<string, unknown> | string;
    where?: Record<string, unknown>;
}

/** Result of {@link TriggerDatabase.rank} — 1-based position + partition total. */
interface TriggerRankResult {
    position: number;
    total: number;
}

/** Args accepted by {@link TriggerDatabase.rankPage}. */
interface TriggerRankPageOptions {
    baseWhere?: Record<string, unknown>;
    cursor?: null | string;
    take?: number;
    where?: Record<string, unknown>;
}

/**
 * Portable, table/id-addressed ORM writer handed to trigger handlers via
 * `ctx.db`. Mirrors `@lunora/do`'s runtime `DatabaseWriterLike` surface — it is
 * **not** the generated per-table `ctx.db.<table>` facade (which can't be typed
 * from inside `defineTable`, where the full schema isn't known).
 *
 * `aggregate`/`groupBy`/`count`/`rank`/`rankPage` route through the same
 * trigger-maintained counter and rank tables the user-facing reader uses, so
 * a handler's `ctx.db.<table>.aggregate(...)` observes the just-staged write
 * within the same DO transaction (the counter step happens before the trigger
 * fires).
 */
interface TriggerDatabase {
    aggregate: (tableName: string, options: TriggerAggregateOptions) => Promise<null | number>;
    count: (tableName: string, where?: Record<string, unknown>) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: TriggerQueryArgs) => Promise<Record<string, unknown> | null>;
    findMany: (tableName: string, args?: TriggerQueryArgs) => Promise<TriggerQueryPage>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    groupBy: (tableName: string, options: TriggerGroupByOptions) => Promise<ReadonlyArray<TriggerGroupByEntry>>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    rank: (tableName: string, indexName: string, options: TriggerRankOptions) => Promise<null | TriggerRankResult>;
    rankPage: (tableName: string, indexName: string, options?: TriggerRankPageOptions) => Promise<TriggerQueryPage>;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

/**
 * Handle injected into every trigger handler. `db` is the portable ORM writer;
 * `scheduler` enqueues async / cross-shard follow-up work (cross-shard work is
 * **not** transactional with the firing write).
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface TriggerCtx {
    readonly db: TriggerDatabase;
    readonly scheduler: Scheduler;
}

/** A user-declared trigger handler. Throwing from a `before*` handler aborts the write. */
type TriggerHandler<Event> = (context: TriggerCtx, event: Event) => Promise<void> | void;

/**
 * A single declared trigger, as stored in {@link TableDefinition.triggerMap}.
 * The handler's event type is erased to the {@link TriggerEvent} union here; the
 * per-op {@link TriggerBuilder} methods recover the precise event type for
 * authors.
 */
interface TriggerDefinition {
    readonly handler: TriggerHandler<TriggerEvent>;
    readonly op: TriggerOp;
    readonly timing: TriggerTiming;
}

/**
 * The `t` argument passed to `.triggers((t) => …)`. Each method binds a handler
 * to one `timing`+`op` pair, typing the event against the table's `Shape`.
 */
interface TriggerBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> {
    afterDelete: (handler: TriggerHandler<TriggerDeleteEvent<Shape>>) => TriggerDefinition;
    afterInsert: (handler: TriggerHandler<TriggerInsertEvent<Shape>>) => TriggerDefinition;
    afterUpdate: (handler: TriggerHandler<TriggerUpdateEvent<Shape>>) => TriggerDefinition;
    beforeDelete: (handler: TriggerHandler<TriggerDeleteEvent<Shape>>) => TriggerDefinition;
    beforeInsert: (handler: TriggerHandler<TriggerInsertEvent<Shape>>) => TriggerDefinition;
    beforeUpdate: (handler: TriggerHandler<TriggerUpdateEvent<Shape>>) => TriggerDefinition;
}

/**
 * Per-file metadata returned by {@link ReadOnlyStorage.getMetadata}. A clean
 * public mirror of `@lunora/storage`'s `ObjectMetadata` — re-declared here so
 * the ctx surface carries no dependency on the storage package's types. Matches
 * the columns Convex surfaces for `ctx.storage.getMetadata` / `_storage`.
 */
interface StorageMetadata {
    /** The object's `Content-Type`, when recorded. */
    contentType?: string;
    /** Custom metadata set at upload time, if any. */
    customMetadata?: Record<string, string>;
    /** The object's key. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Body length in bytes. */
    size: number;
    /** When the object was last written (epoch ms), when reported. */
    uploaded?: number;
}

/**
 * The body-free object shape returned by {@link ReadOnlyStorage.head} — a clean
 * public mirror of `@lunora/storage`'s head projection, re-declared here for the
 * same reason as {@link StorageMetadata}: the ctx surface carries no dependency
 * on the storage package's types.
 *
 * Richer than {@link StorageMetadata} on purpose. `getMetadata` is the tidy
 * Convex-shaped summary; `head` is what an HTTP layer needs, so it keeps the
 * validator (`etag`) and the base64 digest RFC 9530 `Repr-Digest` requires, and
 * leaves `uploaded` as the `Date` the binding reports rather than epoch ms.
 */
interface StorageObjectHead {
    /** Custom metadata set at upload time, if any. */
    customMetadata?: Record<string, string>;

    /**
     * R2's unquoted etag (the MD5 hex for a single-part upload). Required: R2
     * reports one on every object, and an HTTP layer built on `head()` (the
     * `serveStorageObject` helper) needs it to emit a validator.
     */
    etag: string;
    /** The already-quoted form of {@link StorageObjectHead.etag}, when the binding reports one. */
    httpEtag?: string;
    /** Recorded HTTP metadata, notably the `Content-Type`. */
    httpMetadata?: { contentType?: string };
    /** The object's key. */
    key: string;
    /** Hex-encoded SHA-256 of the body, when R2 carries a checksum. */
    sha256?: string;
    /** Base64-encoded SHA-256 of the same checksum — the encoding RFC 9530 digest headers require. */
    sha256Base64?: string;
    /** The FULL object size in bytes: R2 reports the object's size, not a returned window's, which is what makes a head enough to resolve a `Range` against. */
    size: number;
    /** When the object was last written. */
    uploaded?: Date;
}

/**
 * Byte window forwarded to {@link ReadOnlyStorage.download} so R2 resolves the
 * slice server-side and streams only those bytes back. Mirrors R2's own `range`
 * option (`@lunora/platform`'s `R2RangeLike`), restated structurally so
 * `@lunora/server` takes no dependency on the bindings package.
 */
type StorageRange = { length?: number; offset: number } | { length: number; offset?: number } | { suffix: number };

/**
 * A downloaded object: the same metadata {@link StorageObjectHead} carries, plus
 * the body stream. This is what `download()` resolves to — R2's object, NOT a
 * bare stream.
 */
interface StorageObjectBody extends StorageObjectHead {
    /** The object body stream. `null` for a zero-byte object. */
    body: ReadableStream | null;
}

/**
 * Read-only projection of `Storage` exposed on `QueryCtx` / `MutationCtx`.
 *
 * Queries are pure reads, and mutations run inside a transactional scope —
 * neither is allowed to perform side-effectful R2 writes (`upload`) or
 * deletes (`delete`). They can, however, **read** existing objects and
 * resolve signed URLs (the URL signing itself is HMAC-only — no R2 round
 * trip), so the read-only surface keeps `download` and `getSignedUrl`. The
 * full {@link Storage} surface stays on `ActionCtx`.
 */
interface ReadOnlyStorage<Buckets extends string = string> {
    /**
     * Select a named bucket (declared via `v.storage("name")`). The returned
     * accessor's operations target that bucket — `ctx.storage.bucket("avatars")
     * .download(key)`. The bare `ctx.storage` targets the default bucket.
     */
    bucket: (name: Buckets) => ReadOnlyStorage<Buckets>;

    /** The bucket this accessor's operations target (the default for the bare `ctx.storage`). */
    readonly bucketName: string;

    /**
     * Fetch an existing object. Returns the R2 object — metadata plus a `body`
     * stream — or `null` when absent.
     *
     * NOT a bare stream: `new Response(await ctx.storage.download(key))` would
     * stringify the object and serve the literal text `[object Object]`. Reach
     * for the body explicitly:
     *
     * ```ts
     * const object = await ctx.storage.download(key);
     *
     * return object ? new Response(object.body) : new Response("Not found", { status: 404 });
     * ```
     *
     * (`serveStorageObject` from `@lunora/server` does this, plus range/ETag
     * handling, for the common "serve a stored file over HTTP" case.)
     *
     * Pass `range` to have R2 resolve the byte window server-side, so the
     * unwanted bytes never reach the worker.
     */
    download: (key: string, options?: { range?: StorageRange }) => Promise<StorageObjectBody | null>;

    /**
     * Read a file's metadata (size, content-type, sha256, upload time, custom
     * metadata) without fetching its body. Returns `null` when the object is
     * absent. Mirrors Convex's `ctx.storage.getMetadata`.
     */
    getMetadata: (key: string) => Promise<StorageMetadata | null>;
    /** Resolve a short-lived signed URL for an existing object. */
    getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
    /** Public URL pointing at the configured base for `key`. */
    getUrl: (key: string) => string;

    /**
     * Read an object's metadata with NO body transfer, as the raw object shape —
     * `etag` and the base64 digest included, which is what an HTTP layer needs to
     * answer a `Range` request. Returns `null` when the object is absent.
     *
     * {@link ReadOnlyStorage.getMetadata} is the tidier summary over the same
     * read; reach for this one when building a response.
     */
    head: (key: string) => Promise<StorageObjectHead | null>;
}

/**
 * `ctx.storage` inside a **mutation**: the read surface, plus the one write a
 * transactional context can safely express. See `@lunora/server`'s
 * `deferred-deletes.ts` for why `delete` itself stays action-only.
 */
interface MutationStorage<Buckets extends string = string> extends ReadOnlyStorage<Buckets> {
    /** Select a named bucket; deletes queued on it are flushed against that bucket. */
    bucket: (name: Buckets) => MutationStorage<Buckets>;

    /**
     * Queue `key` for deletion once this mutation commits.
     *
     * Returns `void`, not a promise: nothing has been attempted yet, so the object
     * is still there on the next line. A rolled-back mutation never flushes, so
     * the row deletion and the object cleanup cannot disagree. A failed delete
     * leaks the object rather than failing a mutation that already succeeded, and
     * is logged with its key.
     */
    deleteAfterCommit: (key: string) => void;
}

interface Storage<Buckets extends string = string> extends ReadOnlyStorage<Buckets> {
    /** Select a named bucket; the returned accessor exposes the full read/write surface. */
    bucket: (name: Buckets) => Storage<Buckets>;

    delete: (key: string) => Promise<void>;

    /**
     * Mint a short-lived signed `PUT` URL a client can upload directly to,
     * optionally pinning the `Content-Type` the uploader must send. Mirrors
     * Convex's `storage.generateUploadUrl`.
     */
    generateUploadUrl: (key: string, options?: { contentType?: string; expiresInSeconds?: number }) => Promise<string>;

    /**
     * Mint a native S3 SigV4 URL that hits R2 **directly**, so the bytes never
     * pass through the Worker — unlike {@link Storage.generateUploadUrl}, whose
     * signed URL points back at this app so its storage rules still apply.
     *
     * Requires `s3` credentials on the `.storage({ s3 })` declaration; without
     * them the call throws. That is the trade-off: no Worker in the path also
     * means no rule enforcement in the path.
     *
     * Declared structurally rather than imported — `@lunora/server` does not
     * depend on `@lunora/storage`, and this file mirrors that surface the same
     * way `head` and `download` do.
     */
    getPresignedUrl: (key: string, options?: { expiresInSeconds?: number; method?: "GET" | "PUT" }) => Promise<string>;

    /**
     * Upload `body` to `key` from the server, returning the stored object's key
     * and etag. Mirrors Convex's `storage.store`. Accepts the same guard fields
     * as `@lunora/storage`'s `UploadOptions` so `maxSize` /
     * `allowedContentTypes` enforcement isn't lost behind the Convex-style alias.
     */
    store: (
        key: string,
        body: ReadableStream | ArrayBuffer | Blob,
        options?: {
            allowedContentTypes?: ReadonlyArray<string>;
            contentType?: string;
            customMetadata?: Record<string, string>;
            maxSize?: number;
        },
    ) => Promise<{ etag: string; key: string }>;
}

interface VectorMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

interface VectorMatches {
    count: number;
    matches: ReadonlyArray<VectorMatch>;
}

interface VectorQueryInput {
    /** Embedder used when `input` is supplied instead of a precomputed `vector`. */
    embed?: VectorEmbedder;
    filter?: Record<string, unknown>;
    /** Natural-language input embedded via `embed`. Ignored when `vector` is set. */
    input?: string;
    namespace?: string;
    topK?: number;
    /** Precomputed query vector; skips `embed`. */
    vector?: ReadonlyArray<number>;
}

interface VectorUpsertInput {
    embed: VectorEmbedder;
    id: string;
    input: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

interface VectorRecord {
    id: string;
    metadata?: Record<string, unknown>;
    values: ReadonlyArray<number>;
}

/**
 * Read-only vector surface exposed on {@link QueryCtx}. Mirrors the read half
 * of `@lunora/bindings/vectors`' `LunoraVectors` so the live adapter is assignable.
 */
interface VectorSearchReader<IndexName extends string = string> {
    getByIds: (indexName: IndexName, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorRecord>>;
    query: (indexName: IndexName, input: VectorQueryInput) => Promise<VectorMatches>;
}

/**
 * Mutating vector surface on {@link MutationCtx} / {@link ActionCtx}. `upsert`
 * is queued post-commit by default; `upsertNow` forces a synchronous write.
 * `db.delete` on a vectorized table auto-propagates the matching `deleteByIds`.
 */
interface VectorSearch<IndexName extends string = string> extends VectorSearchReader<IndexName> {
    deleteByIds: (indexName: IndexName, ids: ReadonlyArray<string>) => Promise<void>;
    upsert: (indexName: IndexName, input: VectorUpsertInput) => Promise<void>;
    upsertNow: (indexName: IndexName, input: VectorUpsertInput) => Promise<void>;
}

/**
 * Structured, filterable key/value fields attached to a log line — the second
 * argument of a `ctx.log.<level>(message, fields)` call, or the fields bound by
 * `ctx.log.with(fields)`. They travel to an `ObservabilitySink`'s `onLog` and,
 * for a network sink, become OTLP log-record attributes a log pipeline (or the
 * Cloud log viewer) can filter and index on. Primitive values pass through;
 * objects/arrays are JSON-encoded at the sink boundary.
 */
type LogFields = Record<string, unknown>;

/**
 * One `ctx.log` severity method. Two call forms:
 *
 * - **Structured** — `ctx.log.info("order placed", { orderId, total })`: a message string plus a `fields` object. The fields are indexed as attributes.
 * - **Console-style** — `ctx.log.info("state", value, other)`: any number of values, joined into the display message exactly like `console.log`.
 *
 * The structured form is matched when the second argument is a plain object;
 * otherwise the call is treated as console-style, so existing `console`-shaped
 * calls keep working unchanged.
 */
interface LunoraLogMethod {
    (message: string, fields?: LogFields): void;
    (...args: unknown[]): void;
}

/**
 * Structured logger on every function `ctx`. Each call emits one attributed log
 * line — tagged with the function path on the server — that flows to an
 * `ObservabilitySink`'s `onLog` (where you route it in production) and, in
 * development, to the dev server terminal via the CLI / Vite plugin formatter.
 * Mirrors the `console` method names so it's a drop-in for `console.log` inside a
 * handler, but with attribution, structured fields, and a routable transport.
 *
 * Six severities spanning the OpenTelemetry ramp: `trace`, `debug`, `info` (and
 * its `log` alias), `warn`, `error`, `fatal`.
 *
 * Two ways to attach structured {@link LogFields}: pass them per call
 * (`ctx.log.info(message, fields)`) or bind them once with {@link with} for a
 * child logger that stamps every line. The rendered `message` and the structured
 * `fields` reach the dev terminal and the platform's Workers Logs; the raw,
 * un-rendered console-style arguments are preserved ONLY on the in-process
 * `onLog` sink (which you opt into and control).
 *
 * Attribution follows the dispatched function: a log emitted inside an internal
 * function invoked via `ctx.runQuery`/`runMutation`/`runAction` is attributed to
 * the outer request entrypoint, since the composed call reuses its context.
 */
interface LunoraLogger {
    readonly debug: LunoraLogMethod;
    readonly error: LunoraLogMethod;

    /**
     * Emit a **structured event** instead of a log line — OpenTelemetry's Events
     * API, on the wire as `LogRecord.eventName` (plus an `event.name` attribute
     * for collectors predating that field).
     *
     * ```ts
     * ctx.log.event("checkout.completed", { plan: user.plan, total, currency });
     * ```
     *
     * The difference from `ctx.log.info("checkout completed", { … })` is what a
     * backend can do with it. A log line's payload is its message: prose, written
     * for a human, free to be reworded next sprint — so "how many checkouts
     * completed, by plan, this hour" degrades into a substring search over
     * English. An event's payload is its `fields` under a **stable name**, which a
     * collector can index, group, and alert on directly.
     *
     * Rule of thumb: `log.*` for narration you'd read while debugging, `event` for
     * anything you'd ever put on a dashboard. And for facts about the request as a
     * whole, prefer `ctx.span` — one wide event beats a dozen
     * events, however well named.
     */
    readonly event: (name: string, fields?: LogFields) => void;
    readonly fatal: LunoraLogMethod;
    readonly info: LunoraLogMethod;
    readonly log: LunoraLogMethod;
    readonly trace: LunoraLogMethod;
    readonly warn: LunoraLogMethod;

    /**
     * Return a child logger that stamps `fields` onto every line it emits,
     * merged under any per-call fields (per-call wins on a key clash). Chainable
     * — `ctx.log.with({ requestId }).with({ step })` accumulates both. Use it to
     * bind request-scoped context once instead of repeating it per call.
     */
    readonly with: (fields: LogFields) => LunoraLogger;
}

/**
 * Handle the enclosing `ctx.trace` span hands its body, so the body can attach
 * attributes only known *after* it resolves (an AI call's token usage / dollar
 * cost, a downstream status, a computed count). Declared structurally here to
 * mirror `shared/span-event.ts`'s `SpanHandle` and `@lunora/do`'s implementation;
 * a cross-package assignability guard in `@lunora/testing` fails the build if the
 * three drift apart. Start attributes are snapshotted before the body runs;
 * handle writes are merged over them at record time, post-hoc winning on a clash.
 */

/**
 * One AI **evaluation** verdict — a scorer's `{name, score, label?}` — to attach
 * to a generation span via {@link SpanHandle.recordEvaluation}. Declared
 * structurally to mirror `shared/evaluation-attributes.ts`'s `EvaluationInput`
 * without a dependency edge.
 */
interface SpanEvaluation {
    /** Optional categorical label (e.g. `"pass"` / `"fail"`), emitted as `.label`. */
    label?: string;
    /** Scorer name — the key's name segment; non-`[A-Za-z0-9._-]` chars become `_`. */
    name: string;
    /** Numeric score (typically `[0, 1]`), emitted as `.score`. */
    score: number;
}

interface SpanHandle {
    /**
     * Record a timestamped event on the enclosing span — a retry, a cache miss, a
     * state transition. Prefer this over an extra `ctx.log` line for anything that
     * only makes sense *relative to this span*: it rides the span's own export, so
     * it costs no additional record and can never be separated from its context.
     */
    addEvent: (name: string, attributes?: LogFields) => void;

    /**
     * Link this span to one in another trace — how a queue consumer points back at
     * the request that enqueued its message without collapsing every producer into
     * one giant trace.
     */
    addLink: (link: SpanLink) => void;

    /**
     * Attach an AI **evaluation** verdict to this (generation) span as the
     * `gen_ai.evaluation.<name>.score` / `.label` OpenTelemetry attributes, so a
     * scorer's grade rides the same trace as the generation it graded. Convenience
     * over {@link SpanHandle.setAttributes} that owns the key format; privacy-safe —
     * only the name, score, and optional label are emitted. Throws on an empty name
     * or a non-finite score.
     */
    recordEvaluation: (evaluation: SpanEvaluation) => void;

    /**
     * Record a **handled** exception as the OTel-conventional `exception` span
     * event (`exception.type` / `exception.message` / `exception.stacktrace`),
     * without marking the span failed.
     *
     * For an error you swallowed — a retried request, a fallback that worked. An
     * error that escapes the span body is recorded automatically and *does* set
     * the error status, so don't call this for one you're re-throwing.
     */
    recordException: (error: unknown) => void;

    /** Set one attribute on the enclosing span (merged at record time; post-hoc wins on key clash). */
    setAttribute: (key: string, value: LogFields[string]) => void;
    /** Merge attributes onto the enclosing span (post-hoc wins on key clash). */
    setAttributes: (fields: LogFields) => void;

    /**
     * The W3C ids of the span this handle refers to (32-hex trace, 16-hex span).
     *
     * On `ctx.span` these are the DISPATCH's ids — the trace the whole request
     * belongs to. Use it to echo a trace id back to a caller so a user can quote
     * it in a bug report, to build a `traceparent` for a hand-rolled outbound
     * call, or to parent a third-party library's spans onto this request.
     */
    spanContext: () => SpanContextIds;
}

/**
 * A span's W3C ids plus the trace's settled sampling verdict.
 *
 * `sampled` is the propagated head decision — absent means none reached this
 * tier, which every consumer reads as keep. It rides with the ids because
 * everything that announces this span downstream from them (a hand-built
 * `traceparent`, an `@opentelemetry/api` `SpanContext`) needs the flag in the
 * same breath: claiming SAMPLED on a trace that was sampled out leaves a
 * collector holding the middle of a trace nobody kept.
 */
interface SpanContextIds {
    /** The trace's settled W3C `sampled` verdict; absent when none was propagated. */
    sampled?: boolean;
    /** This span's id (16-hex). */
    spanId: string;
    /** The trace this span belongs to (32-hex). */
    traceId: string;
}

/**
 * A causal reference to a span in another trace (OTel `Span.links`). Ids are
 * lowercase hex — 32 chars for `traceId`, 16 for `spanId`.
 */
interface SpanLink {
    /** Attributes describing the relationship, e.g. `{ "link.kind": "enqueued_by" }`. */
    attributes?: LogFields;
    spanId: string;
    traceId: string;
}

/** OTel `SpanKind`. Drives a collector's service map — see {@link SpanOptions.kind}. */
type SpanKind = "client" | "consumer" | "internal" | "producer" | "server";

/** Options accepted by `ctx.trace(name, fn, options)` beyond a plain attribute bag. */
interface SpanOptions {
    /** Start attributes, snapshotted before the body runs. */
    attributes?: LogFields;

    /**
     * OTel `SpanKind`, default `"internal"`. Set `"client"` for a call OUT to
     * another service and `"producer"`/`"consumer"` for queue hops: a collector
     * builds its service map from this, so leaving everything `"internal"` yields
     * a trace with no topology.
     */
    kind?: SpanKind;

    /** Links to spans in other traces, known at span start. */
    links?: SpanLink[];
}

/**
 * Span factory on every function `ctx`. Wraps a sub-operation so it becomes its
 * own **span** nested under the dispatch's RPC span, giving a trace real shape:
 * without it a slow request is one opaque bar, with it you see which part was
 * slow.
 *
 * ```ts
 * const charge = await ctx.trace("stripe.charge", () => stripe.charges.create(…), { orderId });
 * ```
 *
 * **Nesting is explicit.** The body receives a tracer bound to its own span;
 * calling *that* is what makes a child:
 *
 * ```ts
 * await ctx.trace("fulfil", async (trace) => {
 *     // Children of "fulfil" — including under Promise.all, where an ambient
 *     // "currently open span" would mis-record these as nested inside each other.
 *     await Promise.all([trace("reserve.stock", …), trace("email.receipt", …)]);
 * });
 * ```
 *
 * Calling `ctx.trace` again inside a body (rather than the passed tracer) is not
 * an error — that span is simply parented to the dispatch instead of to the
 * enclosing span, which is flatter but never wrong.
 *
 * Spans share the dispatch's trace id with its `ctx.log` lines and any container
 * the handler calls (the same `traceparent` is propagated), so one trace spans
 * worker, shard, and container.
 *
 * The span is recorded when the body settles, and the body's value is returned
 * unchanged. A throw is recorded as an error span and then **re-thrown** — this
 * is instrumentation, never flow control. Recording is best-effort: a failing
 * sink can't turn a working handler into a broken one.
 *
 * **Post-hoc attributes.** The body also receives a {@link SpanHandle} as its
 * second argument. The `attributes` passed here are stamped at span start (and
 * snapshotted, so a later mutation can't rewrite them); anything the body sets
 * through the handle — `span.setAttribute(k, v)` / `span.setAttributes({…})` — is
 * merged over that snapshot when the span is recorded, so a value known only once
 * the body has resolved (an AI call's token usage / dollar cost, a computed
 * count) still lands on the span. Post-hoc wins on a key clash. The handle is a
 * trailing parameter, so every existing `(trace) => …` body keeps working
 * unchanged.
 * @param name Span name, e.g. `"stripe.charge"`. Prefer a low-cardinality name
 * and put the varying part in `attributes` — a name built from an id makes every
 * span its own group in a collector.
 * @param fn The body to time, receiving a tracer bound to this span for any
 * nested spans and the enclosing span's {@link SpanHandle} for post-hoc
 * attributes. May be sync or async; the result is awaited.
 * @param attributes Either a plain attribute bag to stamp on the span at start
 * (normalized like a log line's `fields`), or a {@link SpanOptions} object when
 * you need `kind` or `links`. It is read as options only when *every* key is one
 * of `attributes`/`kind`/`links` AND a `kind`, if present, actually names a
 * {@link SpanKind}; `{ attributes: { kind: "premium" } }` is the explicit form if
 * your own attributes happen to be named that.
 * @param identity Adapter-only: record the span under ids the caller has ALREADY
 * published (see {@link SpanIdentity}). A handler never passes this — it exists
 * so the `@opentelemetry/api` bridge, which must hand a library a `SpanContext`
 * synchronously, is recorded under the id it handed out rather than a phantom.
 */
type LunoraTracer = <T>(
    name: string,
    function_: (trace: LunoraTracer, span: SpanHandle) => Promise<T> | T,
    attributes?: LogFields | SpanOptions,
    identity?: SpanIdentity,
) => Promise<T>;

/**
 * Caller-supplied ids for one `ctx.trace` span — the tracer's fourth argument.
 *
 * For adapters that must publish a span's identity BEFORE the body runs: the
 * `@opentelemetry/api` bridge returns a `SpanContext` synchronously from
 * `startSpan` and a library builds a `traceparent` from it, so the span has to be
 * recorded under the id already announced or every downstream span parents to an
 * id that never reaches the collector. `parentSpanId` lets such an adapter
 * express its own parent/child structure without an ambient span stack.
 */
interface SpanIdentity {
    /** Parent to this span id instead of the enclosing `ctx.trace` / dispatch span. */
    parentSpanId?: string;
    /** Record the span under this id (16-hex) instead of a freshly minted one. */
    spanId?: string;
}

/**
 * `ctx.span` — a handle onto **this request's own span**, and with it the
 * wide-event API.
 *
 * ```ts
 * export const checkout = mutation({ handler: async (ctx, args) => {
 *     ctx.span.setAttributes({ "user.plan": user.plan, "cart.items": cart.length });
 *     const payment = await charge(cart);
 *     ctx.span.setAttributes({ "payment.provider": payment.provider, "payment.total": payment.total });
 *     if (payment.retried) ctx.span.addEvent("payment.retried", { attempts: payment.attempts });
 *     return payment;
 * }});
 * ```
 *
 * **Why this instead of more log lines.** The usual way to make a handler
 * observable is to sprinkle `ctx.log.info` through it, which costs one record per
 * call, scatters one request's facts across a dozen rows, and forces every
 * question to be answered by correlating them back together. The wide-event
 * pattern inverts that: accumulate the facts as you learn them, and emit **one**
 * richly-attributed record per unit of work. Cost is flat — one span per request
 * no matter how much you attach — and every question ("p99 checkout latency for
 * pro-plan users with >10 items") becomes a single filter over one table instead
 * of a join across log lines.
 *
 * **This is plain OpenTelemetry, not a Lunora convention.** The attributes land
 * on the span the dispatch already emits, and are additionally exported as an
 * OTel Event record named `lunora.dispatch`, correlated by `trace_id`/`span_id`.
 * Any OTLP backend groups and aggregates them with no special configuration.
 *
 * **`span` vs `trace`.** `ctx.trace(name, fn)` creates a NEW child span to time a
 * sub-operation; `ctx.span` attaches to the one that already exists for the
 * request. Use `trace` for "how long did this part take", `span` for "what was
 * true about this request". Inside a `ctx.trace` body, the handle passed as the
 * body's second argument is that child span's equivalent of this.
 *
 * Attributes are normalized exactly like `ctx.log` fields, and recording is
 * best-effort — a telemetry failure never breaks the handler.
 */
type LunoraWideEvent = SpanHandle;

/**
 * Application metrics on every function `ctx` — the third signal alongside
 * `ctx.log` and `ctx.trace`. Each call records one measurement that flows to an
 * `ObservabilitySink`'s `onMetric`, and from `otlpSink` to a collector's
 * `/v1/metrics`.
 *
 * ```ts
 * ctx.metrics.count("orders.placed", 1, { plan: user.plan });
 * ctx.metrics.record("checkout.latency_ms", Date.now() - started);
 * ctx.metrics.gauge("cart.items", cart.items.length);
 * ```
 *
 * Pick the instrument by the question you want to answer: `count` for "how many"
 * (summed over time), `gauge` for "how many right now" (replaces the last
 * reading), `record` for "what's the distribution" (percentiles, not just a
 * mean).
 *
 * `attributes` are the metric's dimensions. Keep them **low-cardinality** — an
 * attribute valued by user id or order id creates a distinct time series per id,
 * which is how a metrics backend gets expensive. Put identifiers on a log line or
 * a span instead.
 *
 * No pre-aggregation happens: one call is one exported measurement, with counter
 * deltas for the collector to sum. In a hot loop, sum locally and record once
 * rather than calling per iteration.
 */
interface LunoraMetrics {
    /**
     * Add to a monotonic counter (default `1`) — requests served, retries,
     * bytes sent. The collector sums successive deltas.
     */
    readonly count: (name: string, value?: number, attributes?: LogFields) => void;

    /**
     * Report a point-in-time reading that replaces the previous one — queue
     * depth, cache size, connections open.
     */
    readonly gauge: (name: string, value: number, attributes?: LogFields) => void;

    /**
     * Observe one sample of a distribution — latency, payload size. Use this,
     * not a counter, when percentiles matter.
     */
    readonly record: (name: string, value: number, attributes?: LogFields) => void;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface QueryCtx {
    readonly auth: AuthState;

    readonly db: DatabaseReader;

    /**
     * The validated, typed environment. Populated only when the project declares
     * a `defineEnv(...)` contract in `lunora/env.ts`; codegen then narrows this to
     * the validated `InferEnv` shape so `ctx.env.STRIPE_KEY` is parsed and
     * coercion-aware. Absent (optional) without a contract — declare
     * `lunora/env.ts` to populate and type it.
     */
    readonly env?: Record<string, unknown>;

    /**
     * The caller's IP for this request — Cloudflare's trusted `CF-Connecting-IP`,
     * forwarded server-side (never read from a client header). `undefined` when
     * unknown: a live-subscription re-run, a server-initiated dispatch, or
     * non-Cloudflare hosting. A convenient rate-limit key for anonymous traffic.
     */
    readonly ip?: string;

    /** Structured, function-attributed logger; see {@link LunoraLogger}. */
    readonly log: LunoraLogger;

    /** Application counters, gauges, and histograms; see {@link LunoraMetrics}. */

    /**
     * Static metadata declared on this procedure with `.meta(...)`, merged
     * across calls and deep-frozen. Present so middleware can read the policy it
     * is meant to enforce (`ctx.meta.rateLimit`, …) instead of having it
     * hard-wired at each `.use()` site; absent when the procedure never called
     * `.meta()`.
     */
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly metrics: LunoraMetrics;

    /**
     * Wall-clock time (epoch ms) the function began, captured once so the whole
     * handler sees a single stable value. Query/mutation handlers must be
     * deterministic — they may be re-run on OCC retry / subscription re-eval — so
     * read time through `ctx.now` instead of `Date.now()` (the latter is flagged
     * by the `nondeterministic_query_mutation` advisor). Actions may use `Date.now()`.
     */
    readonly now: number;

    /**
     * Compose a read-only subquery in-process, reusing this query's read
     * context (same transaction, same `db`). Executes the referenced query's
     * handler directly — no fresh DO RPC round-trip — so it observes the exact
     * same snapshot. A query may only call other queries; there is no
     * `runMutation` on a `QueryCtx` (writes are not allowed from a query).
     * Mirrors Convex's `ctx.runQuery`.
     */
    readonly runQuery: RunQuery;
    /** Read account-level secrets from Cloudflare Secrets Store; see {@link Secrets}. */
    readonly secrets: Secrets;
    /** Attach facts to THIS request's span — the wide event; see {@link LunoraWideEvent}. */
    readonly span: LunoraWideEvent;
    readonly storage: ReadOnlyStorage;
    /** Wrap a sub-operation in its own nested span; see {@link LunoraTracer}. */
    readonly trace: LunoraTracer;
    readonly vectors: VectorSearchReader;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface MutationCtx {
    readonly auth: AuthState;

    readonly db: DatabaseWriter;

    /**
     * The validated, typed environment. Populated only when the project declares
     * a `defineEnv(...)` contract in `lunora/env.ts`; codegen then narrows this to
     * the validated `InferEnv` shape so `ctx.env.STRIPE_KEY` is parsed and
     * coercion-aware. Absent (optional) without a contract — declare
     * `lunora/env.ts` to populate and type it.
     */
    readonly env?: Record<string, unknown>;

    /**
     * The caller's IP for this request — Cloudflare's trusted `CF-Connecting-IP`,
     * forwarded server-side (never read from a client header). `undefined` when
     * unknown: a live-subscription re-run, a server-initiated dispatch, or
     * non-Cloudflare hosting. A convenient rate-limit key for anonymous traffic.
     */
    readonly ip?: string;

    /** Structured, function-attributed logger; see {@link LunoraLogger}. */
    readonly log: LunoraLogger;

    /** Application counters, gauges, and histograms; see {@link LunoraMetrics}. */

    /**
     * Static metadata declared on this procedure with `.meta(...)`, merged
     * across calls and deep-frozen. Present so middleware can read the policy it
     * is meant to enforce (`ctx.meta.rateLimit`, …) instead of having it
     * hard-wired at each `.use()` site; absent when the procedure never called
     * `.meta()`.
     */
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly metrics: LunoraMetrics;

    /**
     * Wall-clock time (epoch ms) the function began, captured once so the whole
     * handler sees a single stable value. Mutation handlers must be deterministic
     * — they may be re-run on OCC retry — so read time through `ctx.now` instead
     * of `Date.now()` (the latter is flagged by the `nondeterministic_query_mutation`
     * advisor). Actions may use `Date.now()`.
     */
    readonly now: number;

    /**
     * Compose a submutation in-process, reusing this mutation's `db` writer.
     * Executes the referenced mutation's handler directly — no fresh DO RPC —
     * so its writes apply through the same shard invocation as the enclosing
     * mutation. Note: writes are not wrapped in a SQL transaction, so a partial
     * failure does not roll back earlier writes (the same as a top-level
     * mutation). Mirrors Convex's `ctx.runMutation`.
     */
    readonly runMutation: RunMutation;

    /**
     * Compose a read-only subquery in-process, reusing this mutation's `db`.
     * Executes the referenced query's handler directly — no fresh DO RPC — so
     * it observes this mutation's in-flight writes. Mirrors Convex's
     * `ctx.runQuery`.
     */
    readonly runQuery: RunQuery;
    readonly scheduler: Scheduler;
    /** Read account-level secrets from Cloudflare Secrets Store; see {@link Secrets}. */
    readonly secrets: Secrets;
    /** Attach facts to THIS request's span — the wide event; see {@link LunoraWideEvent}. */
    readonly span: LunoraWideEvent;
    readonly storage: MutationStorage;
    /** Wrap a sub-operation in its own nested span; see {@link LunoraTracer}. */
    readonly trace: LunoraTracer;
    readonly vectors: VectorSearch;

    /** Start / resume / inspect durable workflows; see {@link Workflows}. */
    readonly workflows: Workflows;
}

// eslint-disable-next-line unicorn/prevent-abbreviations -- public API name re-exported by src/index.ts; renaming would break consumers
interface ActionCtx {
    readonly auth: AuthState;

    /**
     * Programmatic Workers Cache purge; see {@link CachePurge}.
     *
     * **HTTP actions only.** It is the Worker that holds the `cache` binding, and
     * only `HttpActionCtx` is built there — an `action` reached over RPC runs
     * inside the Durable Object like a query or a mutation, so `ctx.cache` is
     * `undefined` for it. Declared here because `HttpActionCtx` is a `Pick` of
     * this interface. Optional because Workers Cache is only present when
     * enabled in `wrangler.jsonc`; always branch on it.
     */
    readonly cache?: CachePurge;

    readonly db: DatabaseWriter;

    /**
     * The validated, typed environment. Populated only when the project declares
     * a `defineEnv(...)` contract in `lunora/env.ts`; codegen then narrows this to
     * the validated `InferEnv` shape so `ctx.env.STRIPE_KEY` is parsed and
     * coercion-aware. Absent (optional) without a contract — declare
     * `lunora/env.ts` to populate and type it.
     */
    readonly env?: Record<string, unknown>;

    readonly fetch: typeof globalThis.fetch;

    /**
     * The caller's IP for this request — Cloudflare's trusted `CF-Connecting-IP`,
     * forwarded server-side (never read from a client header). `undefined` when
     * unknown: a live-subscription re-run, a server-initiated dispatch, or
     * non-Cloudflare hosting. A convenient rate-limit key for anonymous traffic.
     */
    readonly ip?: string;

    /** Structured, function-attributed logger; see {@link LunoraLogger}. */
    readonly log: LunoraLogger;

    /** Application counters, gauges, and histograms; see {@link LunoraMetrics}. */

    /**
     * Static metadata declared on this procedure with `.meta(...)`, merged
     * across calls and deep-frozen. Present so middleware can read the policy it
     * is meant to enforce (`ctx.meta.rateLimit`, …) instead of having it
     * hard-wired at each `.use()` site; absent when the procedure never called
     * `.meta()`.
     */
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly metrics: LunoraMetrics;

    /**
     * Wall-clock time (epoch ms) the action began, captured once for convenience
     * and parity with query/mutation `ctx.now`. Actions run exactly once, so they
     * may also use ambient `Date.now()` freely.
     */
    readonly now: number;
    readonly runAction: RunAction;
    readonly runMutation: RunMutation;
    readonly runQuery: RunQuery;
    readonly scheduler: Scheduler;
    /** Read account-level secrets from Cloudflare Secrets Store; see {@link Secrets}. */
    readonly secrets: Secrets;
    /** Attach facts to THIS request's span — the wide event; see {@link LunoraWideEvent}. */
    readonly span: LunoraWideEvent;
    readonly storage: Storage;
    /** Wrap a sub-operation in its own nested span; see {@link LunoraTracer}. */
    readonly trace: LunoraTracer;
    readonly vectors: VectorSearch;

    /** Start / resume / inspect durable workflows; see {@link Workflows}. */
    readonly workflows: Workflows;
}

// --- Generated API surface ---------------------------------------------------

/**
 * Stand-in returned by codegen so projects can `import { api } from "./_generated/api"`.
 * The runtime value is opaque; the types are filled in by generated declarations.
 */
type AnyApi = Record<string, Record<string, RegisteredFunction<ArgsValidator, unknown, FunctionKind>>>;

// The proxy itself lives in `shared/any-api.ts` so `@lunora/client` can serve
// the same value: the generated `api.ts` is what a sibling package imports, and
// its runtime import should not be the server runtime. Re-exported here
// unchanged, typed to this package's `AnyApi`.
const anyApi = sharedAnyApi as unknown as AnyApi;

export { anyApi };

export type {
    ActionCtx,
    AggregateIndexDefinition,
    AggregateOp,
    AnyApi,
    ArgsValidator,
    AuthState,
    CachePurge,
    DatabaseReader,
    DatabaseWriter,
    DurableObjectJurisdiction,
    DurableStreamOptions,
    ExposeConfig,
    ExternalSourceCursor,
    ExternalSourceDefinition,
    ExternalSourceMode,
    ExternalSourceRefresh,
    FunctionKind,
    FunctionVisibility,
    GeoBoundingBox,
    GeoFilterBuilder,
    GeoIndexDefinition,
    GeoPointInput,
    GlobalBackend,
    IndexDefinition,
    IndexRangeBuilder,
    InferArgs,
    LifecycleEvent,
    LifecycleEventKind,
    LogFields,
    LunoraLogger,
    LunoraLogMethod,
    LunoraMetrics,
    LunoraTracer,
    LunoraWideEvent,
    MutationCtx,
    MutationStorage,
    OnDeleteAction,
    PaginationOptions,
    PaginationResult,
    QueryCtx,
    RankIndexDefinition,
    RankSortKey,
    ReadOnlyStorage,
    RegisteredAction,
    RegisteredFunction,
    RegisteredLifecycleHook,
    RegisteredMutation,
    RegisteredQuery,
    RegisteredStream,
    RelationDefinition,
    RestCacheConfig,
    RetryPolicy,
    RunQueryOptions,
    ScheduledFunctionDoc,
    ScheduledJob,
    Scheduler,
    Schema,
    SearchFilterBuilder,
    SearchIndexDefinition,
    Secrets,
    SecretsStoreSecretLike,
    ShardInitEvent,
    ShardMode,
    SpanContextIds,
    SpanEvaluation,
    SpanHandle,
    SpanIdentity,
    SpanKind,
    SpanLink,
    SpanOptions,
    Storage,
    StorageMetadata,
    StorageObjectBody,
    StorageObjectHead,
    StorageRange,
    SystemDatabaseReader,
    SystemDoc,
    SystemQuery,
    SystemTableName,
    TableDefinition,
    TableReader,
    TableVectorIndex,
    TriggerAggregateOptions,
    TriggerBuilder,
    TriggerCtx,
    TriggerDatabase,
    TriggerDefinition,
    TriggerDeleteEvent,
    TriggerEvent,
    TriggerGroupByEntry,
    TriggerGroupByOptions,
    TriggerHandler,
    TriggerInsertEvent,
    TriggerOp,
    TriggerQueryArgs,
    TriggerQueryPage,
    TriggerRankOptions,
    TriggerRankPageOptions,
    TriggerRankResult,
    TriggerRow,
    TriggerTiming,
    TriggerUpdateEvent,
    TtlDefinition,
    VectorEmbedder,
    VectorIndexDefinition,
    VectorMatch,
    VectorMatches,
    VectorMetric,
    VectorQueryInput,
    VectorRecord,
    VectorSearch,
    VectorSearchReader,
    VectorUpsertInput,
    WorkflowCreateOptions,
    WorkflowEventDefinition,
    WorkflowHandle,
    WorkflowInstance,
    WorkflowInstanceStatus,
    Workflows,
    WorkflowStatusResult,
    X402ProcedureConfig,
};

export type { SearchLanguage, SearchStrategy } from "@lunora/search-core";
