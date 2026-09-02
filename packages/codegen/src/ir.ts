/**
 * AST-observable subset of a column's modifier chain (`.unique()`, `.default()`,
 * …). Function-valued modifiers (`.$defaultFn`/`.$onUpdateFn`) can't be
 * serialized, so only their *presence* is recorded.
 */
export interface ColumnMetaIR {
    /** `.default(...)` or `.$defaultFn(...)` present — field is optional on insert. */
    hasDefault?: boolean;
    /** `.$onUpdateFn(...)` present. */
    hasOnUpdate?: boolean;
    /** Default `true`; `.nullable()` flips it to `false`. */
    notNull: boolean;
    /** `.unique()` present. */
    unique?: boolean;
}

/** Reflective representation of a single validator call from the schema. */
export interface ValidatorIR {
    /** For `v.storage(bucket?)` — the named typed bucket the object key lives in, when given. */
    bucket?: string;
    /** Column modifiers (`.unique()`, `.default()`, `.nullable()`, …) when present. */
    column?: ColumnMetaIR;

    /**
     * `true` when this validator carries a refinement (`.check(...)`, `.max(n)`,
     * `.email()`, …) — anything that narrows the accepted values without changing
     * the kind. `schema-drift` hashes this, so a bound counts here even when it is
     * modelled below. `.meta(...)` is pure metadata with no parse effect and does
     * NOT set it.
     */
    hasRefinement?: boolean;
    /** For `v.optional(inner)` / `v.array(inner)`. */
    inner?: ValidatorIR;
    /** For `v.record(key, value)`. */
    keyType?: ValidatorIR;
    /** Kind of validator (string, number, id, object, optional, array, union, literal, record, ...). */
    kind: string;
    /** For `v.literal(value)` — the literal value as source text. */
    literalValue?: string;
    /** For `v.union(a, b, ...)`. */
    members?: ValidatorIR[];
    /** For `v.object({...})`. */
    shape?: Record<string, ValidatorIR>;
    /** Verbatim source text — used in emitted code when we can't reconstruct from AST. */
    sourceText?: string;

    /**
     * The `n` of a `v.string().max(n)` written with a numeric literal — the one
     * refinement predicate the IR can represent exactly (`value.length <= n`).
     * The AOT compiler emits it as a guard instead of declining the node, which
     * is what keeps a length-bounded public argument on the fast path.
     */
    stringMaxLength?: number;
    /** For `v.id("table")` — the table name. */
    tableName?: string;

    /**
     * For `v.from(externalSchema)` — the wrapped Standard Schema's inferred type,
     * rendered as TS source. Recovered through the type checker from
     * `~standard.types.output`, mirroring the runtime's `InferStandardOutput`.
     * Absent when it could not be recovered safely, in which case the emitted
     * type falls back to `unknown`.
     */
    tsType?: string;

    /**
     * `true` when this validator carries a refinement the IR could NOT model — a
     * `.check(...)` closure, `.email()`, `.pattern(re)`, a `.max()` whose bound is
     * not a literal. The AOT args-validator compiler declines any node with this
     * flag, because compiling it would silently skip the predicate.
     */
    unmodelledRefinement?: boolean;
    valueType?: ValidatorIR;
}

export interface IndexIR {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface SearchIndexIR {
    /** Primary text-search field; a dot-separated path reads a nested field. */
    field: string;
    /** Optional filter fields surfaced alongside the FTS column. */
    filterFields?: ReadonlyArray<string>;
    /** Text-analysis profile (accent folding + that language's stopwords). */
    language?: string;
    name: string;
    /** Skip the migration-time backfill of the search companion (large tables index out-of-band). */
    staged?: boolean;
    /** `"native"` opts into the engine's own full-text index where it has one (Postgres). */
    strategy?: string;
}

/** A `.geoIndex(name, { field, precision? })` declaration — a geohash companion over a `v.geoPoint()` column. */
export interface GeoIndexIR {
    /** The `v.geoPoint()` column feeding the geohash. */
    field: string;
    name: string;
    /** Geohash precision (characters) maintained on the companion; omitted ⇒ the runtime default. */
    precision?: number;
}

/** A `.ttl(field, { after? })` declaration — declarative table-level auto-expiry. */
export interface TtlIR {
    /** Millisecond offset added to `field` to derive the expiry (`field + after`); omitted ⇒ `field` is the absolute expiry. */
    after?: number;
    /** The epoch-millisecond expiry column. */
    field: string;
}

export interface VectorIndexIR {
    dimensions?: number;
    /** Shape A: the single source column. Shape B: undefined (derived via a `select` fn). */
    field?: string;
    /** Shape A: metadata field names mirrored into Vectorize. */
    metadata?: ReadonlyArray<string>;
    metric?: "cosine" | "dot-product" | "euclidean";
    name: string;
    /** Owning table the vectors are sourced from. */
    table: string;
}

/**
 * One ordering key on a rank index's `sortBy`: the column and direction.
 * Mirrors the runtime `RankSortKey` (defaults `direction` to `"asc"`).
 */
export interface RankSortKeyIR {
    direction: "asc" | "desc";
    field: string;
}

/**
 * A `.rankIndex(name, { sortBy, partitionBy?, where? })` declaration. The owning
 * table is always the table the index is declared on, so — unlike a vector index
 * — there is no separate `on`/`table` reference to carry: it rides along on its
 * {@link TableIR}. Only the fields needed for type emission are captured.
 */
export interface RankIndexIR {
    name: string;
    /** Columns scoping each ranking; omitted ⇒ one global rank over the table. */
    partitionBy?: ReadonlyArray<string>;
    /** Ordered sort keys driving the rank. */
    sortBy: ReadonlyArray<RankSortKeyIR>;
}

export interface RelationIR {
    /** FK column: on this table for `one`, on the target table for `many`. */
    field: string;
    kind: "many" | "one";
    /** Accessor name the relation is loaded under (the `with` key). */
    name: string;
    /** FK behaviour applied to holder rows when the referenced parent is deleted. */
    onDelete?: "cascade" | "restrict" | "set null";
    /** Referenced column (defaults to `_id`). */
    references: string;
    /** Target table name. */
    table: string;
}

/**
 * Statically-discovered `.source(...)` config (plan 077). Only the bits the
 * advisor lints + DO wiring need are captured; `map`/`tenantBy` are functions and
 * cannot be serialized, so their presence is recorded as `hasTenantBy` rather than
 * the function itself.
 */
export interface ExternalSourceIR {
    /** The wrangler Hyperdrive binding name. */
    binding: string;
    /** Whether a `columns` projection allow-list was given. */
    columns?: ReadonlyArray<string>;
    /** `true` when a `reconcileEveryMs` was given — one of the two incremental delete-visibility paths the `external_source_incremental_no_delete_path` lint checks. */
    hasReconcile?: boolean;
    /** `true` when a `softDeleteColumn` was given — the other incremental delete-visibility path. */
    hasSoftDelete?: boolean;
    /** `true` when a `tenantBy` mapper was given — the tenant-isolation boundary the `external_source_unscoped` lint checks. */
    hasTenantBy: boolean;
    /** The `idColumn` literal, when given (defaults to `"id"` at runtime). */
    idColumn?: string;
    /** Delete-detection mode literal, when given (`"full-pull"` today). */
    mode?: string;
    /** The membership query literal, when statically knowable. */
    query?: string;

    /**
     * `true` when `.source(...)` was present but its argument was **not** a static
     * object literal (e.g. `.source(buildConfig())`), so none of the fields above
     * could be read. The source still exists — this flag lets `hasSourcedTables`
     * (codegen) and the `external_source_*` lints treat it as a source that can't be
     * verified, instead of mistaking it for no `.source()` at all.
     */
    unanalyzable?: boolean;
}

export interface TableIR {
    /**
     * `true` when the table chain carried `.commitOrdered()` — every row carries
     * `_commitSeq`, a per-shard integer allocated once per mutation and strictly
     * increasing in commit order. Optional: hand-built IR and tables that never
     * called `.commitOrdered()` default it to `false`.
     */
    commitOrdered?: boolean;

    /**
     * The `defineSchemaExtension` key that contributed this table, set when it
     * arrived through `defineSchema(...).extend(...)`. Absent for a table the app
     * declared itself.
     *
     * Drives the generated `AppTableName` union: an add-on's tables
     * (`ratelimit_buckets`, …) are real tables and stay in `TableName`, but an app
     * enumerating "my tables" should not have to know about them.
     */
    extensionKey?: string;

    /**
     * `true` when the table chain carried `.externallyManaged()` — its rows are
     * written outside Lunora's discoverable insert path (adapter/migration/
     * middleware), so advisor insert-path lints skip it. Optional: hand-built
     * IR and the runtime `fromServerSchema` path default it to `false`.
     */
    externallyManaged?: boolean;

    /**
     * Set when the chain carried `.source(...)` — the table is materialized from an
     * external Hyperdrive-backed database by a system poll loop (plan 077). Carries
     * the statically-knowable bits the advisor lints read; the functions (`map`,
     * `tenantBy`) are not serialized, only their presence (`hasTenantBy`).
     */
    externalSource?: ExternalSourceIR;

    /**
     * Storage backend for a `.global()` table: `"d1"` (default) or
     * `"hyperdrive"` (a Postgres/MySQL database via Cloudflare Hyperdrive). Only
     * meaningful when `shardMode === "global"`; absent for sharded/root tables.
     */
    /** Geospatial indexes declared inline via `.geoIndex(name, …)`. Optional so hand-built IR may omit it (discovery always sets it). */
    geoIndexes?: ReadonlyArray<GeoIndexIR>;
    globalBackend?: "d1" | "hyperdrive";
    indexes: ReadonlyArray<IndexIR>;

    /**
     * `true` when the table chain carried `.public()` — an explicit opt-OUT of
     * the schema's `.rls("required")` enforcement for this one table. Optional:
     * hand-built IR and tables that never called `.public()` default it to
     * `false`.
     */
    isPublic?: boolean;

    /**
     * `true` when the table chain carried `.memory()` — its rows are cleared on
     * every Durable Object cold start and never reach the CDC changelog.
     * Optional: hand-built IR and tables that never called `.memory()` default it
     * to `false`.
     */
    memory?: boolean;
    name: string;
    /** Rank indexes declared inline via `.rankIndex(name, …)`. */
    rankIndexes: ReadonlyArray<RankIndexIR>;
    /** Declared relations (via `.relations((r) => …)`), keyed in source order. */
    relations: ReadonlyArray<RelationIR>;
    searchIndexes: ReadonlyArray<SearchIndexIR>;
    shape: Record<string, ValidatorIR>;
    shardMode: "global" | "root" | { field: string; kind: "shardBy" };
    /** Set when the chain carried `.softDelete()` — the marker column's name (default `deletedAt`). The column is injected into `shape` so `Doc_*` carries it. */
    softDelete?: { field: string };
    /** Set when the chain carried `.ttl(field, { after? })` — the declarative auto-expiry policy read by the DO alarm sweep. */
    ttl?: TtlIR;
    /** Vector indexes declared inline via `.vectorize()` (DSL Shape A). */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

/** The Cloudflare DO data-residency jurisdictions the schema may declare. Canonical literal set for the codegen package. */
export type JurisdictionIR = "eu" | "fedramp" | "us";

export interface SchemaIR {
    /**
     * Cloudflare data-residency jurisdiction declared via
     * `defineSchema(...).jurisdiction("…")`. Emitted into the generated worker's
     * `createWorker({ jurisdiction })` (and `ctx.scheduler` / `ctx.containers`).
     * Absent ⇒ un-pinned.
     */
    jurisdiction?: JurisdictionIR;

    /**
     * Set when `defineSchema(...).rls("required")` was chained onto the schema —
     * every table's `ctx.db` write path is denied without an RLS-covering
     * procedure unless the table itself is `.public()` (see {@link TableIR.isPublic}).
     * Absent when the schema never called `.rls("required")`.
     */
    rlsMode?: "required";
    tables: ReadonlyArray<TableIR>;
    /** All vector indexes (inline Shape A hoisted + standalone Shape B), flattened. */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

/**
 * Statically-read mirror of `@lunora/server`'s `RestCacheConfig`. Every field is
 * optional because discovery only records literals it could actually read off the
 * `.expose({ cache: … })` object.
 */
export interface ExposeCacheIR {
    maxAge?: number;
    scope?: "private" | "public";
    staleWhileRevalidate?: number;
    tag?: string;
    vary?: string;
}

export interface FunctionIR {
    args: Record<string, ValidatorIR>;
    exportName: string;

    /**
     * Set by the `.expose({ rest: true })` builder modifier (plan 167). When
     * `rest` is `true` the function is published on the public REST surface, so the
     * OpenAPI emitter describes it as a real `/_lunora/rest/<namespace>/<fn>` path
     * (the single source of truth the runtime router also derives from). Absent →
     * RPC-only (the default; not on the REST surface).
     *
     * `cache` mirrors the `RestCacheConfig` the runtime turns into response
     * headers, so the emitted spec can document the `Cache-Control` a caller will
     * actually observe. Only statically-readable literal fields are carried; a
     * computed value is simply absent (the spec under-documents rather than lies).
     */
    expose?: { cache?: ExposeCacheIR; rest?: boolean };
    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "messages". */
    filePath: string;
    kind: "action" | "mutation" | "query" | "stream";

    /**
     * Set on connection-lifecycle hooks (`onConnect`/`onDisconnect`): the socket
     * side the hook fires on. Such a function is also an internal mutation (so it
     * lands in `LUNORA_FUNCTIONS` for path dispatch); emit additionally collects
     * it into the `LUNORA_LIFECYCLE_HOOKS` manifest keyed by this side. Absent on
     * ordinary functions.
     */
    lifecycle?: "connect" | "disconnect" | "init" | "reactor";

    /**
     * The `.output(validator)` declaration, when the chain has one.
     *
     * Takes precedence over {@link FunctionIR.returnType} (the handler's
     * inferred type) for the emitted `FunctionReference`. `.output()` is what
     * validates at runtime and what a reader takes as the contract, so the two
     * must agree — see the emit-side note for what went wrong when they did not.
     */
    output?: ValidatorIR;

    /**
     * Serialized TS source for the handler's return type, with `Promise<T>`
     * unwrapped so callers see `T` directly. Defaults to `"unknown"` when
     * ts-morph cannot resolve the type (typically because the consuming
     * project lacks a tsconfig that can reach `@lunora/server`).
     */
    returnType: string;

    /**
     * Call surface the function is exposed on. Absent (or `"public"`) means it
     * lands in the generated `api`; `"internal"` routes it to the separate
     * `internal` object and is rejected by the DO's external RPC path.
     */
    visibility?: "internal" | "public";
}

/**
 * A `defineMigration({...})` declaration discovered in the user's lunora
 * sources. The emitted `LUNORA_MIGRATIONS` registry keys on {@link MigrationIR.id}; the
 * import wiring needs {@link MigrationIR.exportName}/{@link MigrationIR.filePath}. The runtime object
 * carries the authoritative {@link MigrationIR.table}, but the lifted value is
 * load-bearing at build time: the schema-drift gate matches it against the
 * tables with breaking drift, so a migration left at `""` covers nothing.
 */
export interface MigrationIR {
    /** Export binding name, used to reference the module member in generated imports. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "migrations". */
    filePath: string;
    /** Stable migration id — the registry key and per-shard run-state key. */
    id: string;
    /** Table the migration iterates; `""` when not a static string literal. */
    table: string;
}

/**
 * A `defineShape({...})` declaration discovered in `lunora/shapes.ts`
 * (local-first sync engine, Phase 7). The emitted `LUNORA_SHAPES` registry keys
 * on {@link ShapeIR.exportName}; the generated DO's `resolveShape` override
 * dispatches a `shape_subscribe` to the matching registered shape. Discovery is
 * marker-driven (the `__lunoraShape` brand) — no field metadata is lifted here
 * because the runtime object (`columns`/`compileWhere`) carries the authority.
 */
export interface ShapeIR {
    /**
     * The shape's `args` validator map — its partition selector. Lifted so
     * `_generated/collections.ts` can type the selector a caller passes instead of
     * widening it to `Record<string, unknown>`. `{}` for a parameterless shape.
     */
    args: Record<string, ValidatorIR>;
    /** Export binding name — the shape's registry key and import member. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension — always `"shapes"`. */
    filePath: string;

    /**
     * The `table` string literal from the `defineShape({ table })` call, lifted
     * only for static advisor lints (the runtime object stays authoritative).
     * `undefined` when `table` is not a plain string literal — lints skip those.
     */
    table?: string;
}

/**
 * The single `defineIdentity({...})` claim contract discovered in
 * `lunora/identity.ts`. Discovery is **marker-driven** (the `__lunoraIdentity`
 * brand, exactly like {@link ShapeIR}) — no claim metadata is lifted here
 * because the emitted `_generated/server.ts` recovers the claim *type* from the
 * declaration itself (`InferIdentity` over the contract's `typeof`), and the
 * runtime object (`validate`/`onInvalid`) carries the authority at the boundary.
 * Exactly one per app; absent ⇒ generated output is byte-identical to today.
 */
export interface IdentityIR {
    /** Export binding name — the namespace member `_generated/server.ts` reads via `typeof`. */
    exportName: string;
}

/**
 * The single `defineEnv({...})` contract discovered in `lunora/env.ts`. Like
 * {@link IdentityIR}, only the export binding is lifted — the emitted
 * `_generated/server.ts` recovers the validated shape from the declaration
 * itself (`ReturnType` over the accessor's `typeof`), and the generated ShardDO
 * applies the same accessor to the worker `env` at ctx-build time to populate
 * `ctx.env`. Exactly one per app; absent ⇒ generated output is byte-identical.
 */
export interface EnvIR {
    /** Export binding name — the namespace member `_generated/server.ts` reads via `typeof`. */
    exportName: string;
}

/**
 * A `defineMutator({...})` declaration discovered in `lunora/mutators.ts`
 * (local-first sync engine, Phase 7). The emitted registry registers the
 * authoritative `server` impl into the DO's `LUNORA_FUNCTIONS` table (so
 * `handleRpc` transaction-wraps it) and records its path in
 * `LUNORA_MUTATOR_PATHS` so the DO's `isCustomMutator` override routes the
 * client-watermark push protocol. The client `client` impl is split into the
 * browser bundle separately — only the path crosses to the server side.
 */
export interface MutatorIR {
    /**
     * The mutator's `args` validator map, parsed exactly as a procedure's is, so
     * the emitted `api.mutators.<name>` reference carries the arg type a client
     * `defineMutator` infers instead of restating. `{}` for a parameterless
     * mutator (or one whose `args` isn't an inline object literal).
     */
    args: Record<string, ValidatorIR>;
    /** Export binding name — the mutator's registry key and import member. */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension — always `"mutators"`. */
    filePath: string;

    /**
     * Serialized TS source for the authoritative `server` impl's return type,
     * `Promise<T>` unwrapped. `"unknown"` when ts-morph can't resolve it — same
     * contract as {@link FunctionIR.returnType}.
     */
    returnType: string;
}

/**
 * A whole-row `ctx.db.replace(id, document)` write discovered inside a custom
 * mutator's inline `server` impl (`lunora/mutators.ts`) — the input the
 * `mutator_full_row_replace` advisor lint consumes. A `replace` overwrites the
 * entire row, so a concurrent edit to a different column on a synced table is
 * clobbered; `ctx.db.patch(id, { field })` merges at the column level instead.
 * Structurally identical to `AdvisorMutatorWrite` so it passes straight through
 * to the advisor without conversion, exactly as `InsertWriteIR` does for
 * `AdvisorInsertWrite`.
 */
export interface MutatorWriteIR {
    /** The mutator export whose `server` impl performs the replace, e.g. `renameChannel`. */
    exportName: string;
    /** Openable source path the replace appears in — always `lunora/mutators.ts`. */
    file: string;
    /** 1-based line of the `replace(...)` call. */
    line: number;
}

/**
 * A single cron job lifted from a `cronJobs()` builder in `lunora/crons.ts`.
 * Mirrors `@lunora/scheduler`'s `CronJob`: {@link CronJobIR.cron} is the compiled
 * standard cron expression, {@link CronJobIR.functionPath} is the target
 * `__lunoraRef` (`namespace:fn`), and {@link CronJobIR.args} is the static
 * argument object passed at registration.
 */
export interface CronJobIR {
    /** Static args object (source-text JSON), defaults to `{}`. */
    args: Record<string, unknown>;
    /** Compiled standard cron expression, e.g. `"0 9 * * *"`. */
    cron: string;
    /** Target function ref `namespace:fn`. Present for a function target; absent when {@link CronJobIR.workflow} is set. */
    functionPath?: string;
    /** Unique, human-readable job name. */
    name: string;

    /**
     * Set when the job targets a durable workflow (a `lunora/workflows.ts`
     * export) instead of a function: the workflow's `WORKFLOW_*` binding name
     * plus its export name. On each fire the worker starts a new workflow
     * INSTANCE (the {@link CronJobIR.args} become its `params`) rather than
     * dispatching a one-shot function.
     */
    workflow?: { binding: string; exportName: string };
}

/**
 * A container lifted from a `defineContainer()` export in
 * `lunora/containers.ts`. Carries everything the emitters and the config layer
 * need to wire wrangler (`containers[]` + the Durable Object binding +
 * migration class) and the generated `_generated/containers.ts` DO class.
 * Names are derived via `@lunora/container`'s shared helpers so codegen and
 * the config layer can never disagree.
 */
export interface ContainerIR {
    /** Durable Object binding name, e.g. `CONTAINER_TRANSCODER`. */
    bindingName: string;
    /** Static Dockerfile build args (wrangler `image_vars`), when declared as literals. */
    buildArgs?: Record<string, string>;
    /** Generated DO class name, e.g. `TranscoderContainer`. */
    className: string;

    /**
     * Whether the container may open outbound internet connections, when the
     * value was a static literal. `undefined` means the field was omitted (the
     * platform default is `true`) or wasn't a literal. Lifted for the advisor.
     */
    enableInternet?: boolean;
    /** The `lunora/containers.ts` export name, e.g. `transcoder`. */
    exportName: string;

    /**
     * Normalized image source: a local Dockerfile (`dockerfile`), a pre-built
     * registry reference (`registry`), or a Railpack source directory (`build`)
     * that the deploy step builds and pushes before wrangler runs.
     */
    image: { buildContext: string; dockerfilePath: string; kind: "dockerfile" } | { buildDir: string; kind: "build" } | { kind: "registry"; reference: string };
    /** Static `instanceType`, when declared. */
    instanceType?: string | { diskMb?: number; memoryMib?: number; vcpu?: number };
    /** Static `maxInstances`, when declared. */
    maxInstances?: number;
    /** Static wrangler `containers[].name` override, when declared. */
    name?: string;
    /** Static rolling-deploy tuning, when declared as literals. */
    rollout?: { gracePeriodSeconds?: number; stepPercentage?: number };

    /**
     * The static `sleepAfter` value, when it was a literal. `undefined` means
     * omitted (platform default `"10m"`) or non-literal. Lifted for the advisor.
     */
    sleepAfter?: number | string;
}

/**
 * A workflow lifted from a `defineWorkflow()` export in `lunora/workflows.ts`.
 * Carries what the emitters and the config layer need to wire the wrangler
 * `workflows[]` entry and the generated `_generated/workflows.ts`
 * `WorkflowEntrypoint` class. Unlike containers, workflows are NOT Durable
 * Objects — wrangler gets only a `workflows[]` entry, never a `durable_objects`
 * binding or a migration class. Names are derived via `@lunora/workflow`'s
 * shared helpers so codegen and the config layer can never disagree.
 */
export interface WorkflowIR {
    /** The Cloudflare `Workflow` binding name, e.g. `WORKFLOW_ORDER_PIPELINE`. */
    bindingName: string;
    /** Generated `WorkflowEntrypoint` class name, e.g. `OrderPipelineWorkflow`. */
    className: string;
    /** The `lunora/workflows.ts` export name, e.g. `orderPipeline`. */
    exportName: string;

    /**
     * The stable wrangler `workflows[].name`. Defaults to the kebab-cased export
     * name (`orderPipeline` → `order-pipeline`); a static `name:` literal in the
     * definition overrides it.
     */
    name: string;

    /**
     * Durable step labels lifted from the handler body — the first string-literal
     * argument of every `ctx.step.do` / `.sleep` / `.sleepUntil` / `.waitForEvent`
     * call. Feeds the duplicate-step-name lint, which flags a name used twice
     * (Cloudflare memoizes by name, so the second call silently returns the
     * first's cached result). Calls with a non-literal name are omitted (not
     * statically comparable).
     */
    steps: ReadonlyArray<WorkflowStepIR>;
}

/**
 * An agent lifted from a `defineAgent()` export in `lunora/agents.ts`. A
 * `defineAgent` compiles its durable tool-loop onto a Cloudflare Workflow, so —
 * like {@link WorkflowIR} — an agent is NOT a Durable Object: wrangler gets only
 * a `workflows[]` entry, never a `durable_objects` binding or a migration class.
 * Carries what the emitters and the config layer need to wire the generated
 * agent `WorkflowEntrypoint` class (e.g. `SupportAgentWorkflow`), the typed
 * per-agent `ctx.agents` producer, and the reconciled wrangler `workflows[]`
 * entry. Names are derived via `@lunora/agent`'s shared helpers so codegen and
 * the config layer can never disagree.
 */
export interface AgentIR {
    /** The Cloudflare `Workflow` binding name, e.g. `AGENT_SUPPORT`. */
    bindingName: string;
    /** Generated `WorkflowEntrypoint` class name, e.g. `SupportAgentWorkflow`. */
    className: string;
    /** The `lunora/agents.ts` export name, e.g. `support`. */
    exportName: string;

    /**
     * The stable wrangler `workflows[].name`. Defaults to the kebab-cased export
     * name (`support` → `agent-support`); a static `name:` literal in the
     * definition overrides it.
     */
    name: string;

    /**
     * Whether the definition declares an `onEmail` mapper on
     * `defineAgent({ onEmail: … })`. When `true` the emitter wires this agent
     * onto the worker's top-level `email()` handler (via `@lunora/agent/inbound`)
     * so inbound mail starts a durable run. Detected by AST PRESENCE — the
     * closure is never evaluated — and written to IR only when present, so
     * email-free agents (and agent-free projects) stay byte-identical.
     */
    onEmail?: boolean;

    /**
     * Whether the definition opted into public run-starts via
     * `defineAgent({ publicRun: true })` — emitted into the `ctx.agents` wiring
     * spec so the public `agents:agentRun` mutation can gate on it fail-closed.
     * Absent (falsy) means server-side starts only; the field is written to IR
     * only when the literal is `true`, so agent-free and non-opted-in output is
     * byte-identical.
     */
    publicRun?: boolean;

    /**
     * Whether the definition opted into a real-time voice session via a `voice`
     * block on `defineAgent({ voice: … })`. Unlike the durable loop (a Workflow),
     * the voice path IS a Durable Object — so when this is `true` the emitter
     * generates the `voiceClassName` `VoiceSessionDO` subclass and the
     * `api.agents.{name}Voice` client reference, and the config layer reconciles
     * a `durable_objects` binding (`voiceBindingName`) + `new_sqlite_classes`
     * migration. Written to IR only when the literal is present, so voice-free
     * agents (and agent-free projects) stay byte-identical.
     */
    voice?: boolean;

    /** The voice DO's Cloudflare `DurableObjectNamespace` binding name, e.g. `VOICE_SUPPORT`. Present only when `voice`. */
    voiceBindingName?: string;

    /** Generated `VoiceSessionDO` subclass name, e.g. `SupportVoiceDO`. Present only when `voice`. */
    voiceClassName?: string;
}

/** One durable step call lifted from a workflow handler body (the use side of {@link WorkflowIR.steps}). */
export interface WorkflowStepIR {
    /** 1-based line of the durable step call. */
    line: number;
    /** The native step method invoked: `do` / `sleep` / `sleepUntil` / `waitForEvent`. */
    method: string;
    /** The step's static label (the first string-literal argument). */
    name: string;
}

/**
 * A queue lifted from a `defineQueue()` export in `lunora/queues.ts`. Carries
 * what the emitters and the config layer need to wire the typed `ctx.queues`
 * producer, the generated worker `queue()` dispatch, and the wrangler
 * `queues.producers[]` / `queues.consumers[]` entries. Like workflows, a queue
 * is NOT a Durable Object — wrangler gets only `queues.*` entries. Names are
 * derived via `@lunora/queue`'s shared helpers so codegen and the config layer
 * can never disagree.
 */
export interface QueueIR {
    /** The Cloudflare `Queue` producer binding name, e.g. `QUEUE_EMAIL`. */
    bindingName: string;
    /** The `lunora/queues.ts` export name, e.g. `emailQueue`. */
    exportName: string;
    /** How the queue is consumed: `"push"` (a worker `queue()` handler) or `"pull"` (external HTTP). */
    mode: "pull" | "push";

    /**
     * The stable wrangler queue name (`queues.producers[].queue`). Defaults to
     * the kebab-cased export name (`emailQueue` → `email-queue`); a static
     * `name:` literal in the definition overrides it.
     */
    name: string;
    /** Push-consumer batch/retry tuning, mirrored onto the wrangler `queues.consumers[]` entry. */
    tuning: {
        deadLetterQueue?: string;
        maxBatchSize?: number;
        maxBatchTimeout?: number;
        maxRetries?: number;
        retryDelay?: number;
    };
}

/**
 * The feature-flag provider declared by the default export of `lunora/flags.ts`
 * (`defineFlags({ provider, … })`). Discovery is **metadata-only** — codegen
 * imports the real module at runtime for the provider value; this IR exists so
 * the config layer can reconcile/validate the wrangler `flagship` binding when
 * the app uses Flagship in binding mode. A `custom` provider (any other
 * OpenFeature factory) carries no binding to reconcile.
 */
export interface FlagsIR {
    /**
     * The wrangler `flagship[].binding` name — set **only** for a flagship
     * `provider` in binding mode (`flagshipProvider({ binding: "FLAGS" })`). The
     * config layer hints/validates a matching `flagship` binding from this.
     */
    bindingName?: string;

    /**
     * Flagship operating mode — `"binding"` (wrangler binding, needs a
     * `flagship` entry) or `"http"` (no binding); `undefined` for a `custom`
     * provider or when the mode can't be read statically.
     */
    mode?: "binding" | "http";
    /** `"flagship"` when the provider is `flagshipProvider(...)`, else `"custom"` (any other OpenFeature provider factory). */
    provider: "custom" | "flagship";
}

/**
 * A `ctx.workflows.get("name")…` call discovered in a function body — the
 * use-site analog of {@link WorkflowIR} (which is the declaration side). Feeds
 * the `workflow_unused` lint (a declared workflow with zero call sites) and the
 * `workflow_unknown_target` lint (a `.get("x")` whose `x` isn't declared — a
 * typo catcher). {@link WorkflowCallIR.workflow} is `""` when the `get(...)`
 * argument is not a string literal (a dynamic name — which suppresses the
 * unused-workflow heuristic rather than producing a false positive).
 */
export interface WorkflowCallIR {
    /** Export binding name of the function performing the call, e.g. `create`. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the `get(...)` call. */
    line: number;
    /** The referenced workflow export name, or `""` when the argument is not a string literal. */
    workflow: string;
}

/**
 * A `ctx.db.query("table")…` read discovered in a function body, reduced to what
 * the query advisor lints need: which table, whether the chain narrows with an
 * index, whether it filters, and which terminal materializes the result.
 * `table` is `""` when the `query(...)` argument is not a string literal (a
 * dynamic table — not lintable).
 */
export interface QueryReadIR {
    /** Exported procedure the read sits in, or `""` at module scope. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * True when the chain's `.filter()` predicate compares `_id`
     * (`(d) => d._id === args.id`) — a full scan for a row that `ctx.db.get`
     * addresses directly. Optional so a feeder predating this field still
     * typechecks; absent is treated as "not a primary-key filter".
     */
    filtersPrimaryKey?: boolean;
    /** The chain calls `.filter(...)`. */
    hasFilter: boolean;
    /** The chain narrows with `.withIndex(...)` or `.withSearchIndex(...)`. */
    hasIndex: boolean;
    /** 1-based line of the `query(...)` call. */
    line: number;
    /** Queried table name, or `""` when the argument is not a string literal. */
    table: string;

    /**
     * The materializing call the chain ends in — `"collect"`, `"take"`,
     * `"paginate"`, `"first"`, `"unique"`, … — i.e. how much of the narrowed set
     * the read actually loads.
     *
     * `undefined` when the chain reaches no recognised terminal (a reader passed
     * on, a bare `query(...)`) AND when a feeder predating this field produced
     * the read. The two are deliberately not distinguished: no consumer could act
     * on the difference, so the terminal-shaped lints skip the read either way
     * rather than guessing a terminal.
     */
    terminal?: string;
}

/**
 * A `ctx.authApi.<method>(...)` call discovered in a function body, attributed
 * to the exported function (and its file = api namespace) that performs it.
 * Structurally identical to `AdvisorAuthApiCall` so it passes straight through
 * to the advisor lint without conversion, exactly as `InsertWriteIR` does for
 * `AdvisorInsertWrite`.
 */
export interface AuthApiCallIR {
    /** Export binding name of the function performing the call, e.g. "createOrg". */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** True when the call's argument object includes a `headers` property. */
    hasHeaders: boolean;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The better-auth method invoked (e.g. `banUser`); empty when not statically known. */
    method: string;
}

/**
 * A `ctx.db.insert("table", …)` write discovered in a function body, attributed
 * to the exported function (and its file = api namespace) that performs it — the
 * write-side analog of {@link QueryReadIR}. Lets tooling wire a table's write
 * action by behavior (which function inserts into it) rather than by naming.
 * {@link InsertWriteIR.table} is `""` when the argument is not a string literal.
 */
export interface InsertWriteIR {
    /** Export binding name of the function performing the insert, e.g. "send". */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the `insert(...)` call. */
    line: number;
    /** Target table name, or `""` when the argument is not a string literal. */
    table: string;
}

/**
 * A non-deterministic API call (`Date.now`, `Math.random`, `crypto.randomUUID`,
 * `crypto.getRandomValues`, `fetch`) discovered lexically inside a `query(...)`
 * or `mutation(...)` handler body — the `nondeterministic_query_mutation` lint
 * input. Structurally identical to `AdvisorNondeterministicCall` so values pass
 * straight through to the advisor without conversion, exactly as `AuthApiCallIR`
 * does for `AdvisorAuthApiCall`. `action(...)` handlers are never recorded —
 * actions are the determinism escape hatch.
 */
export interface NondeterministicCallIR {
    /** The non-deterministic API invoked, e.g. `Date.now` / `Math.random` / `crypto.randomUUID` / `fetch`. */
    callee: string;
    /** Export binding name of the function performing the call, e.g. `sendMessage`. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the call lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
}

/**
 * One `ctx.<property>` access lexically inside a `query`/`mutation` handler —
 * the feeder shape behind every "action-only surface used outside an action"
 * advisor lint (`hyperdrive_outside_action` for `ctx.sql`,
 * `r2sql_outside_action` for `ctx.r2sql`). Structurally identical to the
 * advisor's `AdvisorHyperdriveCall` / `AdvisorR2sqlCall` (same field set) so
 * values pass straight through `lintSchema` without conversion, exactly as
 * {@link NondeterministicCallIR} does. Only `query`/`mutation` handlers are
 * recorded; `action(...)` is the only context where these surfaces are even
 * typed, so it is the intended home and is skipped.
 */
export interface ContextPropertyCallIR {
    /** The accessed surface, e.g. `ctx.sql.query` / `ctx.r2sql.from` — the property, suffixed with the method when one is called on it. */
    callee: string;
    /** Export binding name of the function performing the access. */
    exportName: string;
    /** Source file relative to the lunora dir, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the access lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the access. */
    line: number;
}

/**
 * Per-procedure RLS usage snapshot, produced by `discoverRlsProcedures` for the
 * `rls_uncovered_table` advisor lint. Structurally identical to
 * `AdvisorRlsProcedure` (they share the same field set) so values pass straight
 * through to the advisor without conversion, exactly as `AuthApiCallIR` does for
 * `AdvisorAuthApiCall`.
 */
export interface RlsProcedureIR {
    /** Export binding name of the procedure (e.g. `listDocuments`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * Table names extracted from the `rls(policies)` array literal. Empty when the
     * policies argument is not a statically-readable array literal.
     */
    rlsTables: string[];
    /** Tables read by the procedure via `ctx.db.query/findMany/findFirst/…`. */
    tablesRead: string[];
    /** Tables written by the procedure via `ctx.db.insert/patch/replace/delete`. */
    tablesWritten: string[];
    /** `true` when the procedure's builder chain includes `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One procedure reduced to the facts the `mask_uncovered_pii_column` lint needs:
 * whether its builder chain includes `.use(mask(...))`, which `(table, column)`
 * pairs that mask declares, and which tables the procedure reads/writes. The
 * column-level analogue of {@link RlsProcedureIR}. Structurally identical to
 * `AdvisorMaskProcedure` so values pass straight through without conversion.
 */
export interface MaskProcedureIR {
    /** Export binding name of the procedure (e.g. `listUsers`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;

    /**
     * `(table, column)` pairs this procedure's `mask(policies)` object literal
     * declares. Empty when the policies argument is not a statically-readable
     * object literal (conservative: `usesMask` is still `true`).
     */
    maskColumns: { column: string; table: string }[];
    /** Tables read by the procedure via `ctx.db.query/findMany/findFirst/get`. */
    tablesRead: string[];
    /** Tables written by the procedure via `ctx.db.insert/patch/replace/delete`. */
    tablesWritten: string[];
    /** `true` when the procedure's builder chain includes `.use(mask(...))`. */
    usesMask: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One masked column surfaced to the studio's data-browser mask preview: a
 * `(table, column)` pair plus the declared {@link MaskProcedureIR} strategy so
 * the preview can pick redact-vs-hash-vs-custom rendering. Aggregated across the
 * project's `.use(mask(...))` chains by `discoverMaskMetadata`; the descriptive
 * twin of {@link RlsPolicyIR}. `"custom"` covers any non-string strategy (a
 * `(value, ctx) => …` function) — its logic is an opaque closure, never read by
 * the UI; the preview renders a fixed sentinel for it.
 */
export interface MaskColumnMetadataIR {
    /** Column the mask policy redacts. */
    column: string;
    /** Declared masking strategy: `"redact"`/`"hash"` string literals, else `"custom"` for a `MaskFn`. */
    strategy: "custom" | "hash" | "redact";
    /** Logical table the masked column belongs to. */
    table: string;
}

/**
 * Schema-wide masking metadata the codegen emits into the generated ShardDO so
 * the studio's data-browser mask toggle can preview what a non-privileged caller
 * would see. Aggregated across every `.use(mask(...))` chain in the project —
 * purely descriptive (table + column + strategy), never the masking closure. The
 * column-level analogue of {@link RlsMetadataIR}.
 */
export interface MaskMetadataIR {
    /** Every statically-discovered masked column, deduped by `(table, column)` (first declaration wins). */
    columns: MaskColumnMetadataIR[];
}

/**
 * One masked column whose `mask(policies)` strategy is a statically-known
 * literal (`"hash"` or `"redact"`) — the `mask_weak_hash_strategy_on_pii` lint
 * input. Unlike {@link MaskColumnMetadataIR} (app-wide, deduped by `(table,
 * column)`, studio-preview evidence), this is per declaration site (file + line
 * + enclosing export), undeduped, so the lint can point at the exact
 * `mask(...)` call that applies a weak strategy. A `MaskFn` (custom, non-literal)
 * strategy carries no lint-relevant signal and is never recorded here.
 * Structurally identical to `AdvisorMaskStrategy`.
 */
export interface MaskStrategyIR {
    /** Masked column name. */
    column: string;
    /** Export binding name of the procedure whose `.use(mask(...))` chain declared this column, or `"<module>"` when declared at file scope. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the masked column's strategy property. */
    line: number;
    /** The statically-known strategy literal: `"hash"` or `"redact"`. */
    strategy: string;
    /** Logical table the masked column belongs to. */
    table: string;
}

/**
 * One statically-readable policy entry from an `rls([...])` array literal,
 * surfaced to the studio's read-only RLS inspector via the generated
 * `rlsPolicies()` hook. Captures the policy's `table` + `on` operation and the
 * procedure it guards — never the `when` predicate, which is an opaque JS
 * closure (its logic stays in code, not the UI). Produced by
 * `discoverRlsProcedures` alongside the lint IR.
 */
export interface RlsPolicyIR {
    /** Source file (relative to `lunora/`, without extension) the policy is declared in. */
    file: string;
    /** Operation the policy gates: `read` covers get/query/findMany, the rest are writes. */
    on: "delete" | "insert" | "read" | "update";
    /** Export name of the procedure whose `.use(rls(...))` chain declared this policy. */
    procedure: string;
    /** Logical table the policy applies to. Empty when not a string literal. */
    table: string;
}

/**
 * One statically-readable role entry from an `rls(policies, { roles: [...] })`
 * call, surfaced to the studio's RLS inspector. Captures the role's `name`,
 * optional `description`, and the names of the permissions it grants (string
 * literals or `definePermission("name")` calls). Produced by
 * `discoverRlsProcedures`.
 */
export interface RlsRoleIR {
    /** Optional human-readable description from `defineRole(name, { description })`. */
    description?: string;
    /** Role label attached to the request identity (e.g. `"admin"`). */
    name: string;
    /** Permission names this role grants, deduped and in declared order. */
    permissions: string[];
}

/**
 * Schema-wide RLS metadata the codegen emits into the generated ShardDO so the
 * studio's read-only inspector can list, per table, which policies guard it and
 * what roles are defined. Aggregated across every `.use(rls(...))` chain in the
 * project — purely descriptive, never the predicate logic.
 */
export interface RlsMetadataIR {
    /** Every statically-discovered policy `(table, on, procedure)` entry. */
    policies: RlsPolicyIR[];
    /** Every statically-discovered role, deduped by name (first declaration wins). */
    roles: RlsRoleIR[];
}

/** One statically-discovered `defineStorageRule({ bucket, on, prefix })` entry from a `.use(storageRules(...))` chain. */
export interface StorageRuleIR {
    bucket: string;
    /** Relative to `lunora/`. */
    file: string;
    on: "delete" | "list" | "read" | "write";
    /** Optional key-prefix scope; absent ⇒ the whole bucket. */
    prefix?: string;
    /** The exported procedure that installed the rule. */
    procedure: string;
}

/**
 * Schema-wide storage-access-rule metadata emitted into the generated ShardDO so
 * the studio's read-only inspector can list, per bucket, which operations are
 * gated and under what key prefix. Aggregated across every
 * `.use(storageRules(...))` chain — descriptive only, never the predicate logic.
 */
export interface StorageRulesMetadataIR {
    rules: StorageRuleIR[];
}

/**
 * A typed REST route declared with the `httpRoute.<verb>("/path")…` builder in
 * `@lunora/server` and mounted on `httpRouter()`. Captured statically from the
 * builder chain so the OpenAPI emitter can render a real `paths` entry: the verb
 * + path become the operation's method + URL, and the accumulated validator maps
 * become its query parameters, path parameters, and request body.
 */
export interface HttpRouteIR {
    /** `v.*` validators decoding the JSON request body (`.body({...})`), keyed by field. */
    body: Record<string, ValidatorIR>;

    /**
     * Rendered TS type of one SSE chunk — the `R` the `.stream(handler)`
     * handler yields — inferred from the handler via the type checker. Present
     * only when {@link HttpRouteIR.stream} is `true`; `"unknown"` when the
     * checker can't resolve enough context. Feeds the emitted
     * `HttpStreamRef<Chunk, …>` so the chunk type flows to the client.
     * @experimental Part of the HTTP-SSE stream surface (the `httpStreams.*` emission).
     */
    chunkType?: string;
    /** Export binding name of the route handler (used only for diagnostics / dedupe). */
    exportName: string;
    /** Path relative to `<projectRoot>/lunora/` without extension, e.g. "http". */
    filePath: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"GET"`. */
    method: string;
    /** The `.output(validator)` return schema when declared; absent ⇒ TS-inferred / best-effort. */
    output?: ValidatorIR;
    /** `v.*` validators decoding the hono path params (`.params({...})`), keyed by `:name`. */
    params: Record<string, ValidatorIR>;
    /** The route path passed to `httpRoute.<verb>(path)`, e.g. `/api/todos/:id`. */
    path: string;
    /** `v.*` validators decoding the URL query string (`.searchParams({...})`), keyed by name. */
    searchParams: Record<string, ValidatorIR>;
    /** `true` when declared via the terminal `.stream(...)` (Server-Sent Events) rather than `.handler(...)`. */
    stream: boolean;
}

/**
 * Per-procedure protective-middleware snapshot, produced by
 * `discoverProcedureMiddleware` for the security lints
 * (`public_mutation_without_ratelimit`, `user_creating_mutation_without_captcha`).
 * Records which `.use(...)` guards a procedure's builder chain carries plus the
 * behavioural facts that decide whether a guard is *expected* (does it write a
 * user/session table, does it send mail). `protectPublic({ rateLimit, captcha })`
 * is unwrapped: the bundle's object-literal keys set `usesRateLimit`/`usesCaptcha`
 * exactly as the individual `.use(rateLimit(...))` / `.use(verifyTurnstile(...))`
 * steps would. Structurally identical to `AdvisorProcedureProtection` so values
 * pass straight through to the advisor without conversion.
 */
export interface ProcedureMiddlewareIR {
    /**
     * `true` when the handler body could be read statically — an inline function
     * expression/arrow, or a same-file identifier resolved to one. `false` for a
     * genuinely cross-file handler (an imported function, or an identifier that
     * doesn't resolve in this file), in which case every behavioural fact below
     * is `undefined` rather than a false "not observed" — the feeder never saw
     * the body, so it has nothing to report.
     */
    analyzableBody: boolean;
    /** `true` when the handler (or a helper inside it) references `ctx.mail` / `ctx.email`. `undefined` when `analyzableBody` is `false`. */
    callsMail?: boolean;
    /** `true` when the handler emits a structured observability event (`ctx.log` / `ctx.span` / `ctx.trace`). */
    emitsEvent?: boolean;
    /** `true` when a `// lunora-advisor-exempt` directive sits above the export. */
    exempt: boolean;
    /** The `-- reason` from that directive, or `""`. */
    exemptReason: string;
    /** Export binding name of the procedure (e.g. `signUp`). */
    exportName: string;
    /** `true` when the handler fans work out to a privileged, cost-bearing dispatch surface (scheduler `runAfter`/`runAt`, a queue producer send, or a workflow create). Feeds the privileged-fanout lint. `undefined` when `analyzableBody` is `false`. */
    fanOut?: boolean;

    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** `true` when the handler wraps work in `try`/`catch`. */
    handlesErrors?: boolean;

    /**
     * `true` when the procedure declares an email-shaped argument (`email`,
     * `emailAddress`, `userEmail`, …), `false` when it provably declares none,
     * and **absent** when the argument list can't be read statically (a
     * `.input(sharedSchema)`, a spread, or a factory whose `args` comes from a
     * variable). Feeds `signup_mutation_without_disposable_gating`, which can
     * only be actioned when there is an address to gate — so "unreadable" must
     * stay distinguishable from "none", or the lint would clear itself on a
     * registration that may well expose one.
     */
    hasEmailArg?: boolean;
    kind: "action" | "mutation" | "query";
    /** `true` when the handler reaches an outbound surface (`ctx.fetch`, mail, queues, storage, sql, ai, …) that can fail. */
    reachesOutbound?: boolean;
    /** `true` when the handler runs any AI generation, bounded or not. */
    runsAiGeneration?: boolean;
    /** `true` when the handler throws a bare `new Error(...)` rather than a coded `LunoraError`. */
    throwsBareError?: boolean;
    /** `true` when the handler runs an AI generation (`generateText`/`streamText`/`generateObject`/`streamObject`) with no `maxOutputTokens` bound in its config literal. Feeds the `ai_unbounded_generation_public` lint. `undefined` when `analyzableBody` is `false`. */
    unboundedAiGeneration?: boolean;
    /** `true` when the chain carries `.use(verifyTurnstile(...))` or a `protectPublic({ captcha })` bundle. */
    usesCaptcha: boolean;
    /** `true` when the chain carries `.use(emailGateMiddleware(...))` (`@lunora/auth`). Feeds the `signup_mutation_without_disposable_gating` lint. */
    usesEmailGate: boolean;
    /** `true` when the handler calls `ctx.db.insertManyUnsafe(...)`, bypassing validators and triggers. Feeds the `insert_many_unsafe_user_data` lint. `undefined` when `analyzableBody` is `false`. */
    usesInsertManyUnsafe?: boolean;
    /** `true` when the chain carries `.use(mask(...))`. */
    usesMask: boolean;
    /** `true` when the chain carries `.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle. */
    usesRateLimit: boolean;
    /** `true` when the chain carries `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
    /** `true` when the handler inserts into a user/session/account-shaped table. `undefined` when `analyzableBody` is `false`. */
    writesUserTable?: boolean;
}

/**
 * Per-procedure argument-validator snapshot, produced by the
 * argument-validator discoverer for the input-hardening lints
 * (`public_arg_uses_any`, `unbounded_string_arg`). Only public procedures are
 * recorded — internal functions take server-trusted input. Structurally identical
 * to `AdvisorArgumentValidator` so it passes straight through to the advisor
 * without conversion.
 */
export interface ArgumentValidatorIR {
    /** Arg names declared as `v.any()` (unvalidated, untyped input). */
    anyArgs: string[];
    /** Export binding name of the procedure (e.g. `updateProfile`). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the registration call, or `0` when unknown. */
    line: number;
    /** Arg names declared as `v.string()` with no statically-visible max-length bound. */
    unboundedStringArgs: string[];
}

/**
 * One factory/constructor call in `lunora/` whose config object literal a
 * security lint inspects for a present-or-absent key — the shared input for the
 * config-call security lints (payment authorize, inbound-mail verify, rate-limit
 * store, browser private-targets). Structurally identical to `AdvisorConfigCall`
 * so it passes straight through to the advisor without conversion.
 */
export interface ConfigCallIR {
    /** `true` when the config argument was a static object literal the feeder could read. */
    analyzable: boolean;
    /** The factory function or constructor name at the call site, e.g. `createPayment` / `RateLimiter`. */
    callee: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the call site, or `0` when unknown. */
    line: number;
    /** Keys present in the config object literal (empty when not `analyzable`). */
    presentKeys: string[];
    /** Keys in the config object literal explicitly assigned the literal `true`. */
    trueKeys: string[];
}

/**
 * One secret-shaped string literal discovered in `lunora/` source — the
 * `hardcoded_secret` lint input. Complements the pre-commit `vis secrets` scan by
 * surfacing the same class of finding in-IDE via the studio Advisors table.
 * Structurally identical to `AdvisorSecretLiteral`.
 */
export interface SecretLiteralIR {
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `aws_access_key` / `pem_private_key` / `high_entropy`. */
    kind: string;
    /** 1-based line of the literal, or `0` when unknown. */
    line: number;
    /** Redacted preview of the literal (first few chars + length) for the finding detail — never the full secret. */
    preview: string;
}

/**
 * One `ctx.sql.query(text, …)` / `ctx.sql.unsafe(text, …)` call whose `text`
 * argument is built in place rather than passed as a fixed statement — the
 * `sql_injection_risk` lint input. The Hyperdrive driver binds ONLY the `params`
 * array; the `text` string is spliced verbatim into the SQL, so a `text` assembled
 * from a string concatenation or a substitution template literal is an injection
 * vector. A fixed string literal / no-substitution template is safe. Structurally
 * identical to `AdvisorSqlInterpolation`.
 */
export interface SqlInterpolationIR {
    /** Export binding name of the procedure performing the `ctx.sql` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the interpolation, or `0` when unknown. */
    line: number;
}

/**
 * One `ctx.fetch(url, …)` call inside an action whose URL argument is derived
 * from the handler's `args` — the `action_fetch_ssrf` lint input. `ctx.fetch` is
 * the action-only outbound-request escape hatch with no host allowlist, so a URL
 * assembled from request input is a server-side request forgery vector (cloud
 * metadata endpoints, internal services). Only arg-derived URLs reach here; a
 * fixed literal or a URL built from config/`ctx.*` is not recorded. Structurally
 * identical to `AdvisorArgumentDerivedFetch`.
 */
export interface ArgumentDerivedFetchIR {
    /** Export binding name of the action performing the `ctx.fetch` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.fetch` call, or `0` when unknown. */
    line: number;
}

/**
 * One `ctx.kv.<method>(key, …)` call whose namespace key is derived from the
 * handler's `args` with no server-side scoping — the `kv_unscoped_user_key_idor`
 * lint input. Workers KV is a single flat namespace, so a key taken straight from
 * request input lets any caller read, overwrite, or delete another user's entry
 * (IDOR). Only arg-derived, unscoped keys reach here; a fixed literal, or a key
 * prefixed with a server-trusted identity (`${ctx.auth.userId}:…` — references
 * `ctx`, so treated as scoped), is not recorded. `list` is excluded (it takes a
 * prefix, not a per-entry key). Structurally identical to `AdvisorKvKeyAccess`.
 */
export interface KvKeyAccessIR {
    /** Export binding name of the procedure performing the `ctx.kv` access. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.kv` call, or `0` when unknown. */
    line: number;
    /** The `ctx.kv` method invoked: `get` / `getRaw` / `getWithMetadata` / `put` / `delete`. */
    method: string;
}

/**
 * One `ctx.db` write (`insert` / `replace` / `patch` / `insertManyUnsafe`) that sets
 * an ownership / identity column — `userId`, `ownerId`, `tenantId`, and the like —
 * from the handler's `args` instead of the server-trusted identity. The
 * `owner_field_from_args_not_auth` lint input: the ownership column decides who a
 * row belongs to, so a value taken from request input lets any caller write rows
 * owned by another user or tenant (the act-as-any-user / cross-tenant IDOR vector).
 * A column stamped from `ctx.*`, or set to a fixed literal, is not recorded; only an
 * arg-derived identity write reaches here. Structurally identical to
 * `AdvisorOwnerFieldWrite`.
 */

/**
 * One branching `defineShape({ where })` / `definePolicy({ when })` predicate arm
 * that returns an unrestricted predicate — the `unrestricted_where_branch` lint
 * input. A denial arm must match NO rows (`deny()` / `{ OR: [] }`); `{}` matches
 * every row, so the near-miss silently replicates the whole table.
 */
export interface UnrestrictedWhereBranchIR {
    /** Export binding name of the shape / policy the predicate belongs to. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which unrestricted form was returned. */
    form: "empty-object" | "undefined";
    /** The config key carrying the predicate (`where` for a shape, `when` for a policy). */
    key: string;
    /** 1-based line of the offending returned expression. */
    line: number;
    /** The declaring call (`defineShape` / `definePolicy`). */
    owner: string;
}

export interface OwnerFieldWriteIR {
    /** Export binding name of the procedure performing the write. */
    exportName: string;
    /** The identity column being written from `args` (e.g. `userId`). */
    field: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.db` write call, or `0` when unknown. */
    line: number;
    /** The `ctx.db` write method (`insert` / `replace` / `patch` / `insertManyUnsafe`). */
    method: string;

    /**
     * Visibility of the enclosing procedure. `internal` procedures are not
     * reachable by a caller, so the lint's premise ("any caller can write rows
     * owned by another user") does not hold there — see
     * `owner_field_from_args_not_auth`. `undefined` when the write sits outside
     * any recognised procedure (a bare helper).
     */
    visibility?: "internal" | "public";
}

/**
 * One `ctx.storage.<bucket>.<method>(key, …)` call whose R2 object key is derived
 * from the handler's `args` with no server-side scoping — the
 * `storage_key_from_user_args` lint input. The bucket read/write/URL/delete methods
 * key by their first argument, so an object key taken straight from request input is
 * object-level IDOR (read/overwrite/delete anyone's object). A key referencing a
 * server-trusted `ctx.*` value (e.g. `${ctx.auth.userId}/…`) is treated as scoped
 * and is not recorded; only an arg-derived, `ctx`-free key reaches here.
 * Structurally identical to `AdvisorStorageKeyAccess`.
 */
export interface StorageKeyAccessIR {
    /** Export binding name of the procedure performing the storage call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the storage call, or `0` when unknown. */
    line: number;
    /** The bucket method invoked with the arg-derived key, e.g. `get` / `put` / `delete` / `download`. */
    method: string;

    /**
     * Visibility of the enclosing procedure. `internal` procedures have no
     * untrusted caller by construction — see `owner_field_from_args_not_auth`'s
     * identical split — so `storage_key_from_user_args` drops the finding to
     * INFO rather than ERROR there. `undefined` when the access sits outside any
     * registered procedure the feeder could attribute it to.
     */
    visibility?: "internal" | "public";
}

/**
 * One `ctx.containers.<exportName>.get(name, …)` call whose instance key is derived
 * from the handler's `args` with no server-side scoping — the
 * `container_instance_key_from_user_input` lint input. Each container definition's
 * `.get(name)` accessor routes to one instance per `name`, so a key taken straight from
 * request input lets any caller reach another tenant's container (a cross-tenant IDOR). A
 * fixed literal key, or one derived from a server-trusted identity (`${ctx.auth.userId}` —
 * references `ctx`, so treated as scoped), is not recorded; only an arg-derived, unscoped
 * key reaches here. `.any()`/`.pool()` take no key and are not sinks. Structurally
 * identical to `AdvisorContainerKeyAccess`.
 */
export interface ContainerKeyAccessIR {
    /** Export binding name of the procedure performing the `ctx.containers` access. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.containers.*.get` call, or `0` when unknown. */
    line: number;
    /** The container accessor method invoked — always `get`. */
    method: string;
}

/**
 * One `ctx.ai.run(model, …)` call whose model-id argument is derived from the handler's
 * `args` with no server-side scoping — the `ai_raw_run_escape_hatch` lint input.
 * `ctx.ai.run` is the raw Workers AI binding passthrough, bypassing the typed
 * `ctx.ai.model(...)` + AI-SDK layer (`generateText`/`streamText`/…) that caps output and
 * enforces a schema, so an arg-derived model id lets any caller select an arbitrary model.
 * A fixed literal model, or one scoped by a server-trusted `ctx.*` value, is not recorded;
 * only an arg-derived, unscoped model id reaches here (an arg-derived `inputs` argument is
 * normal usage and is never inspected). Structurally identical to `AdvisorAiRawRun`.
 */
export interface AiRawRunIR {
    /** Export binding name of the procedure performing the `ctx.ai.run` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.ai.run` call, or `0` when unknown. */
    line: number;
}

/**
 * One `ctx.vectors.<method>(indexName, input)` call whose `input.namespace` is derived
 * from the handler's `args` with no server-side scoping — the
 * `vectors_namespace_from_user_input` lint input. A Vectorize namespace partitions one
 * index into isolated sub-collections, so a namespace taken straight from request input
 * lets any caller read or poison another tenant's vectors. A fixed literal namespace, or
 * one prefixed with a server-trusted identity (`${ctx.auth.orgId}` — references `ctx`, so
 * treated as scoped), is not recorded; only an arg-derived, unscoped namespace reaches
 * here. Structurally identical to `AdvisorVectorNamespaceAccess`.
 */
export interface VectorNamespaceAccessIR {
    /** Export binding name of the procedure performing the `ctx.vectors` access. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.vectors` call, or `0` when unknown. */
    line: number;
    /** The `ctx.vectors` method invoked: `query` / `upsert` / `upsertMany`. */
    method: string;
}

/**
 * One `ctx.mail`/`ctx.email` `send`/`queue` call whose recipient field (`to`/`cc`/`bcc`)
 * is derived from the handler's `args` with no server-side scoping — the
 * `mail_recipient_from_request_input` lint input. A recipient taken straight from request
 * input turns the deployment into an open relay / spam amplifier (any caller can direct
 * mail to an arbitrary address). A fixed literal recipient, or one scoped by a
 * server-trusted `ctx.*` value (e.g. `ctx.auth.user.email`), is not recorded; only an
 * arg-derived, unscoped recipient reaches here. Structurally identical to
 * `AdvisorMailRecipientAccess`.
 */
export interface MailRecipientAccessIR {
    /** Export binding name of the procedure performing the `ctx.mail`/`ctx.email` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.mail`/`ctx.email` call, or `0` when unknown. */
    line: number;
    /** The mailer method invoked: `send` / `queue`. */
    method: string;
}

/**
 * One `ctx.browser.<method>(url, …)` call whose navigation URL (`arguments[0]`)
 * is derived from the handler's `args` with no server-side scoping — the
 * `browser_user_url_without_allowlist` lint input. The lint additionally
 * cross-references `createBrowser` config-call evidence to suppress findings
 * when the browser is hardened with an `allowedHosts` allowlist or
 * `resolveDns`. Structurally identical to `AdvisorBrowserUrlAccess`.
 */
export interface BrowserUrlAccessIR {
    /** Export binding name of the procedure performing the `ctx.browser` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.browser` call, or `0` when unknown. */
    line: number;
    /** The browser method invoked: `content` / `pdf` / `scrape` / `screenshot`. */
    method: string;
}

/**
 * One runtime container-override call: a `<handle>.start({ enableInternet: true, … })`
 * launch override, or a `<handle>.egress.<method>(...)` runtime firewall mutation
 * (`allow` / `deny` / `setAllowed`) — the `container_start_enable_internet_override`
 * and `container_runtime_egress_relaxation` lint input. Both shapes re-open network
 * access the static `defineContainer` declaration (and its `container_public_internet`
 * lint) assumes is locked down. Matched structurally by call shape, independent of the
 * receiver's resolved type. Structurally identical to `AdvisorContainerOverride`.
 */
export interface ContainerOverrideIR {
    /** e.g. the egress method name, or `"enableInternet: true"`. */
    detail: string;
    /** Export binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which override shape matched. */
    kind: "egress_relaxation" | "enable_internet";
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
}

/**
 * One `buildImageDeliveryUrl({ key, … })` call (`@lunora/bindings/images`) whose
 * `key` — the CDN transform's source image, an absolute URL or an
 * origin-relative key — is derived from the handler's `args` with no
 * server-side scoping — the `images_url_source_from_user_input` lint input.
 * `ctx.images.transform`/`info` take image *bytes*, never a URL, so they are not
 * sinks; only the `key` of `buildImageDeliveryUrl` accepts a URL-or-key source
 * and is inspected. An arg-derived `key` lets any caller point the CDN's
 * `/cdn-cgi/image/` transform at an attacker-chosen origin (SSRF / open proxy)
 * or at an arbitrary key under the account's own store. A fixed literal, or a
 * key scoped by a server-trusted `ctx.*` value, is not recorded. Structurally
 * identical to `AdvisorImageDeliveryUrlAccess`.
 */
export interface ImageDeliveryUrlAccessIR {
    /** Export binding name of the procedure performing the `buildImageDeliveryUrl` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `buildImageDeliveryUrl` call, or `0` when unknown. */
    line: number;
}

/**
 * One `createAuth({...})` call's configuration snapshot — the shared input for
 * the five `auth_*` security lints (trusted-origins wildcard, CSRF check
 * disabled, secure cookies disabled, email verification disabled, session
 * freshAge zero). Matched by callee NAME (an `import`-agnostic, fail-closed
 * convention the other feeders share), so a re-export or alias still resolves.
 * When the config argument isn't a statically-analyzable object literal (a
 * top-level spread, or not an object literal at all), `analyzable` is `false`
 * and every boolean fact defaults to its SAFE (not-flagged) value — an opaque
 * config can't be relied on either way. Structurally identical to
 * `AdvisorAuthConfig`.
 */
export interface AuthConfigIR {
    /** `true` when the call's config argument was a static object literal the feeder could read. */
    analyzable: boolean;
    /** `advanced.disableCSRFCheck === true`. */
    disableCsrfCheck: boolean;
    /** `emailAndPassword.enabled === true`. */
    emailPasswordEnabled: boolean;
    /** Export binding name enclosing the `createAuth(...)` call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `createAuth(...)` call, or `0` when unknown. */
    line: number;
    // eslint-disable-next-line no-secrets/no-secrets -- the dotted config-path in the doc comment, not a credential
    /** `emailAndPassword.requireEmailVerification === true` present. */
    requireEmailVerification: boolean;
    /** `trustedOrigins` array literal contains a `"*"` element. */
    /** `plugins` includes `scim(...)` while `database` is a non-transactional Lunora adapter — a combination that throws at runtime. */
    scimOnNonTransactionalAdapter: boolean;
    /** `advanced.useSecureCookies === false`. */
    secureCookiesDisabled: boolean;
    /** `session.freshAge === 0` (explicit literal). */
    sessionFreshAgeZero: boolean;
    trustedOriginsWildcard: boolean;
}

/**
 * One `rateLimit`/`dbRateLimit` middleware call (`@lunora/ratelimit`) whose
 * `key` selector — the per-caller rate-limit sub-key, `(ctx) => string |
 * undefined` — is derived from the handler's `args` with no server-side
 * scoping (no reference to the trusted `ctx` binding anywhere in the selector)
 * — the `ratelimit_key_spoofable_or_global` lint input. A key an attacker
 * controls lets them rotate it per request and bypass the limit entirely,
 * defeating its purpose. A selector scoped by `ctx` (e.g. `ctx.auth.userId`,
 * `ctx.ip`), or one with no `args` reference at all (a fixed/global bucket —
 * the "no key" case this lint deliberately does not flag, to keep it low-FP),
 * is not recorded. Structurally identical to `AdvisorRatelimitKeySelector`.
 */
export interface RatelimitKeySelectorIR {
    /** The `rateLimit`/`dbRateLimit` callee invoked. */
    callee: string;
    /** Export binding name of the procedure whose `.use(...)` chain carries the call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The rate limit's `name` argument (the second positional argument), or `""` when not a string literal. */
    limitName: string;
    /** 1-based line of the `rateLimit`/`dbRateLimit` call, or `0` when unknown. */
    line: number;
}

/**
 * One payload-derived privileged dispatch — a `ctx.run`/`context.run` back into a
 * Lunora function from inside a `defineQueue` push handler or a `defineWorkflow`
 * handler, whose args reference the handler's untrusted payload (`context.params`
 * for a workflow, a `for (… of batch.messages)` body for a queue) — the
 * `privileged_dispatch_unvalidated_payload` lint input. Both handler kinds run
 * under the **system identity** (RLS disabled), so forwarding attacker-influenced
 * payload into the dispatch bypasses the target's row policy. The resolved
 * `targetFile`/`targetExport` let the lint join RLS-procedure evidence and fire
 * only for RLS-gated targets. Structurally identical to `AdvisorPrivilegedDispatch`.
 */
export interface PrivilegedDispatchIR {
    /** `"queue"` for a `defineQueue` handler, `"workflow"` for a `defineWorkflow` handler. */
    dispatchKind: "queue" | "workflow";
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Export binding name of the handler performing the dispatch. */
    handlerExport: string;
    /** 1-based line of the dispatch call, or `0` when unknown. */
    line: number;
    /** Export name of the dispatched target (`send` in `api.messages.send`). */
    targetExport: string;
    /** File path of the dispatched target relative to `lunora/` (`messages` in `api.messages.send`). */
    targetFile: string;
}

/**
 * One discovered `httpRoute.<verb>("/admin/…")` route on an admin/privileged-looking
 * path, with whether its builder chain references an auth/admin guard — the
 * `admin_route_without_guard` lint input. Structurally identical to
 * `AdvisorAdminRoute`.
 */
export interface AdminRouteIR {
    /** Export binding name of the route handler. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"POST"`. */
    method: string;
    /** The route path, e.g. `/admin/users`. */
    path: string;
    /** `true` when the handler body references an auth/session/admin guard (`ctx.auth`, `getSession`, `requireAdmin`, …). */
    usesGuard: boolean;
}

/**
 * One tracked `ctx.storage.<bucket>.<method>(...)` upload/signing call — the
 * shared input for the storage config-hygiene security lints
 * (`storage_upload_without_content_type_allowlist`, `storage_upload_without_max_size`,
 * `storage_generate_upload_url_no_content_type_pin`, `storage_presigned_url_for_private_content`).
 * `upload`/`store` carry the `UploadOptions` guards (`allowedContentTypes` /
 * `maxSize`); `generateUploadUrl` carries the signed-PUT `contentType` pin;
 * `getPresignedUrl`/`getSignedUrl` carry a statically-known `expiresInSeconds`
 * literal. `presentKeys` is empty (and `expiresInSeconds` unset) when the
 * options argument was absent, a non-literal, or a spread — see `analyzable`.
 * Structurally identical to `AdvisorStorageUpload`.
 */
export interface StorageUploadIR {
    /** `true` when the call's options-object argument (or its deliberate absence) was statically resolvable. */
    analyzable: boolean;
    /** Numeric literal value of an `expiresInSeconds` option, when statically known (`getSignedUrl` / `getPresignedUrl` only). */
    expiresInSeconds?: number;
    /** Export binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the call, or `0` when unknown. */
    line: number;
    /** The `ctx.storage` method invoked. */
    method: "generateUploadUrl" | "getPresignedUrl" | "getSignedUrl" | "store" | "upload";
    /** Options-object keys present at the call site (empty when not `analyzable`, or when no options argument was passed). */
    presentKeys: string[];
}

/**
 * One discovered `httpAction`/`httpRoute` handler in `lunora/` that performs a
 * side effect (`ctx.runMutation` / `ctx.runAction` / a `ctx.db.{insert,patch,
 * replace,delete,insertManyUnsafe}` write) from the HTTP edge, with whether it
 * reads `ctx.auth` — the `http_action_missing_auth_guard` lint input. A handler
 * that mutates state or dispatches an action without ever consulting the request
 * identity is an unauthenticated write bypassing identity/RLS. Only handlers with
 * a statically-resolvable inline body and `ctx` binding are recorded (fail-safe
 * under-report); read-only handlers are never recorded. Structurally identical to
 * `AdvisorHttpActionGuard`.
 */
export interface HttpActionGuardIR {
    /** Export binding name of the handler (or `"<module>"` when mounted inline / not a named binding). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** Which HTTP surface the handler is: a raw `httpAction` or a typed `httpRoute` route. */
    kind: "httpAction" | "httpRoute";
    /** 1-based line of the handler call, or `0` when unknown. */
    line: number;
    /** For an `httpRoute`, the uppercased verb (`"POST"`); absent for a raw `httpAction`. */
    method?: string;
    /** `true` when the handler reads `ctx.auth` (a direct member access or a `const { auth } = ctx` destructure). */
    readsAuth: boolean;
    /** The first side effect found, as a stable label: `runMutation`, `runAction`, or `db.<method>`. */
    sideEffect: string;
}

/**
 * One response-header write, inside an `httpAction` handler, whose value is derived
 * from raw request input (`request.headers`, `request.url`/query, `await
 * request.json()`) with no CR/LF sanitizer — the
 * `http_action_response_header_injection` lint input. A `Request`-derived string
 * placed verbatim into a response header lets a caller smuggle `\r\n` and inject
 * extra headers or split the response (header injection / response splitting). Only
 * sites whose value is request-tainted AND unguarded are recorded: a value routed
 * through a CR/LF guard (`isSafeHeaderValue`), a URL/URI encoder
 * (`encodeURIComponent`/`encodeURI`), a numeric coercion (`Number`/`parseInt`/
 * `parseFloat`), or `btoa` is treated as safe and never recorded (`String(...)` /
 * `.toString()` are NOT sanitizers — they don't strip CR/LF). Structurally
 * identical to `AdvisorHttpHeaderWrite`.
 */
export interface HttpHeaderWriteIR {
    /** Export binding name of the enclosing handler, or `"<module>"` when mounted inline. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The header name being written (`"location"`), or `""` when the key is not a string literal. */
    headerName: string;
    /** 1-based line of the request-tainted header value. */
    line: number;
    /** How the header was written. */
    via: "headers-append" | "headers-ctor" | "headers-set" | "response-init";
}

/**
 * One rate-limit / Turnstile middleware call in `lunora/` — the
 * `ratelimit_middleware_fail_open` lint input. `rateLimit`/`dbRateLimit`
 * (`@lunora/ratelimit`) and `verifyTurnstileMiddleware` (`@lunora/auth`) each
 * accept a `failOpen` escape hatch that admits every request when the
 * limiter/siteverify is unavailable; `failOpen` is `true` only when the options
 * literal set it to the boolean literal `true` (anything else is fail-closed).
 * The lint escalates a fail-open guard to a finding when the guarded procedure
 * (`exportName`/`limitName`) looks auth/payment-sensitive. Structurally
 * identical to `AdvisorFailOpenGuard`.
 */
export interface FailOpenGuardIR {
    /** The middleware factory at the call site: `rateLimit` / `dbRateLimit` / `verifyTurnstileMiddleware`. */
    callee: string;
    /** Export binding name of the procedure the guard is attached to, or `"<module>"` at file scope. */
    exportName: string;
    /** `true` only when the options literal set `failOpen: true` as a boolean literal; a non-literal or absent option is treated as fail-closed. */
    failOpen: boolean;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The rate-limit `name` (second string argument) for `rateLimit`/`dbRateLimit`; `""` for `verifyTurnstileMiddleware`. */
    limitName: string;
    /** 1-based line of the middleware call, or `0` when unknown. */
    line: number;
}

/* eslint-disable no-secrets/no-secrets -- the referenced advisor evidence type name in the doc comment, not a credential */

/**
 * One `ctx.flags.boolean("key", <boolean-literal>)` read in `lunora/` — the
 * `flag_gates_security_with_unsafe_default` lint input. OpenFeature returns the
 * `defaultValue` when the provider errors, so a fail-open default on a
 * security-shaped key silently opens access during an outage. Only reads with a
 * statically-known string key and boolean-literal default are recorded; the lint
 * owns the security-shape + polarity judgment. Structurally identical to
 * `AdvisorFlagSecurityDefault`.
 */
export interface FlagSecurityDefaultIR {
    /** The boolean-literal default returned on a provider outage (fail-open value). */
    defaultValue: boolean;
    /** Export binding name of the procedure performing the flag read, or `"<module>"` at file scope. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The flag key — the first string-literal argument of `ctx.flags.boolean`. */
    key: string;
    /** 1-based line of the `ctx.flags.boolean` call, or `0` when unknown. */
    line: number;
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the FlagSecurityDefaultIR doc block */

/* eslint-disable no-secrets/no-secrets -- the referenced advisor lint rule id in the doc comment, not a credential */

/**
 * One `ctx.flags` read lexically inside a `query(...)` handler — the
 * `flag_read_in_subscription` advisor lint input. Flag changes append nothing to
 * `__cdc_log`, so a subscribed query is never re-run when a flag flips and keeps
 * serving the branch it last picked; `useFlag` is the reactive path. Structurally
 * identical to the advisor's `AdvisorFlagRead` (same field set) so values pass
 * straight through `lintSchema` without conversion, exactly as `ContextPropertyCallIR` does.
 *
 * Only `query` handlers are recorded — unlike `ContextPropertyCallIR` / `NondeterministicCallIR`
 * there is no `kind` field, because `mutation`/`action` handlers run once and have
 * no subscription staleness to warn about, so the feeder drops them rather than
 * handing the lint rows it would discard.
 */
export interface FlagReadIR {
    /** The accessed `ctx.flags` surface, e.g. `ctx.flags.boolean` / `ctx.flags.details.string`. */
    callee: string;
    /** Export binding name of the query performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the FlagReadIR doc block */

/**
 * One `generateText` / `streamText` call in `lunora/` whose `tools` reach a
 * privileged side effect (a DB write, function dispatch, or outbound
 * fetch/mail/queue send). `userInputDerived` records whether the model input
 * (`prompt`/`messages`/`system`) flows from the handler's `args`; the
 * `ai_tool_side_effect_prompt_injection` lint fires only when it does.
 * Structurally identical to `AdvisorAiToolSideEffect`.
 */
export interface AiToolSideEffectIR {
    /** Export binding name of the procedure performing the call. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the generation call, or `0` when unknown. */
    line: number;
    /** The generation entrypoint invoked. */
    method: "generateText" | "streamText";
    /** The privileged side-effect sink a model-callable tool reaches (`ctx.db.insert`, `ctx.run`, `ctx.fetch`, …). */
    sideEffect: string;
    /** `true` when a model-input option is derived from the handler's `args` (a bare `args.x`, or a name destructured from `args`). */
    userInputDerived: boolean;
}

/**
 * One `<receiver>.identity.<key>` claim read in `lunora/`, where `<receiver>` is
 * an RLS/mask policy `auth` (or `ctx.auth`/`context.auth`). `declared` records
 * whether `<key>` is in the app's `defineIdentity({ ... })` contract (or the
 * always-present `userId`); the `identity_undeclared_claim_trusted` lint fires on
 * the undeclared reads. Emitted only when a resolvable identity contract exists.
 * Structurally identical to `AdvisorIdentityClaimRead`.
 */
export interface IdentityClaimReadIR {
    /** `true` when `key` is a declared claim (in the `defineIdentity` contract, or the always-present `userId`). */
    declared: boolean;
    /** Export binding name of the enclosing declaration (`<module>` at file scope). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** The claim key read off the identity bag. */
    key: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
}

/**
 * One payment webhook-adapter construction in `lunora/` (`createStripeAdapter` /
 * `createPolarAdapter` / `createAutumnAdapter` / `createDodoPaymentsAdapter`).
 * `toleranceSeconds` carries the statically-known `webhookToleranceSeconds`
 * replay window when it is a plain numeric literal; the payment-webhook
 * wide-tolerance lint fires when it exceeds a conservative ceiling. Structurally
 * identical to `AdvisorPaymentWebhook`.
 */
export interface PaymentWebhookIR {
    /** The adapter factory invoked. */
    callee: "createAutumnAdapter" | "createDodoPaymentsAdapter" | "createPolarAdapter" | "createStripeAdapter";
    /** Export binding name of the enclosing declaration (`<module>` at file scope). */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the construction, or `0` when unknown. */
    line: number;
    /** Statically-known `webhookToleranceSeconds` literal, when present and a plain numeric literal. */
    toleranceSeconds?: number;
}

/**
 * One `ctx.db.<table>.findMany({ includeDeleted })` list read whose
 * `includeDeleted` is either a hardcoded `true` or derived from the handler's
 * `args` — the `soft_delete_include_deleted_from_args` lint input. The lint joins
 * `table` against the schema's soft-delete tables and `visibility` against
 * `.public()` before flagging. Structurally identical to `AdvisorSoftDeleteRead`
 * so values pass straight through without conversion.
 */
export interface SoftDeleteReadIR {
    /** Export binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** `true` when `includeDeleted` was derived from the handler's `args` (any caller can flip it). */
    fromArgs: boolean;
    /** `true` when `includeDeleted` was a hardcoded `true` literal (always resurfaces soft-deleted rows). */
    hardcodedTrue: boolean;
    /** 1-based line of the read call. */
    line: number;
    /** Table read, or `""` when the table-arg form's first argument wasn't a string literal. */
    table: string;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/**
 * One `ctx.db.<table>.findMany({ with: { <rel> } })` relation-hydrating list read
 * — the `masked_relation_leak_via_with` lint input. Column masking does not
 * descend into `with`-hydrated relations, so a masked table surfaced only through
 * a `with` on an unprotected parent read is returned in the clear. The lint
 * resolves each relation accessor to its target table and joins it against the
 * discovered mask evidence before flagging. Structurally identical to
 * `AdvisorRelationLoad` so values pass straight through without conversion.
 */
export interface RelationLoadIR {
    /** Export binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the read call. */
    line: number;
    /** Parent table the read targets, or `""` when the table-arg form's first argument wasn't a string literal. */
    parentTable: string;
    /** Relation accessor names named in the read's `with: { … }` map — matched against the parent table's declared relations. */
    relations: string[];
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}

/* eslint-disable no-secrets/no-secrets -- the referenced advisor lint rule id in the doc comment, not a credential */

/**
 * One `query` handler whose `return` hands back the raw rows of a table — the
 * result of a `ctx.db.<table>.findMany()` / `.findFirst()` / `.get()` read, or a
 * `ctx.db.query("<table>")…collect()` fluent chain — returned directly (or through
 * one local `const` hop) with no hand-built projection. The
 * `output_projection_missing_on_public_read` lint keeps only `visibility ===
 * "public"` rows with no `.output(...)` / `.use(mask(...))` on the chain, then
 * joins `table` against the schema and flags one whose columns are PII-named.
 * Structurally identical to `AdvisorRawRowReturn` so values pass straight through
 * without conversion.
 */
export interface RawRowReturnIR {
    /** Export binding name of the query returning the raw rows. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `return` (or concise-body) expression. */
    line: number;
    /** Table whose raw rows are returned, or `""` when the read's table wasn't a string literal. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(mask(...))` step. */
    usesMask: boolean;
    /** `true` when the procedure's builder chain carries an `.output(...)` return-shape projection. */
    usesOutput: boolean;
    /** `"internal"` for `internalQuery`; `"public"` for `query`. */
    visibility: "internal" | "public";
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the RawRowReturnIR doc block */

/* eslint-disable no-secrets/no-secrets -- the referenced advisor lint rule id in the doc comment, not a credential */

/**
 * One `query`/`mutation` handler that gates a `ctx.db.get`/`patch`/`delete` on a
 * null-checked `ctx.db.normalizeId(table, id)` result — the
 * `normalize_id_used_as_authorization` lint input. `normalizeId` validates an id's
 * structural shape only (it never reads the database), so a non-null result proves
 * the id is well-formed, never that the caller owns the row; gating access on it is
 * an IDOR. The lint owns the negative proof — it keeps only `visibility === "public"`
 * rows with no `.use(rls(...))` and no ownership/identity mention (`mentionsOwnership`),
 * then joins `table` against the schema's RLS mode before flagging. Structurally
 * identical to `AdvisorNormalizeIdAuthorization` so values pass straight through.
 */
export interface NormalizeIdAuthorizationIR {
    /** Export binding name of the procedure performing the normalize-then-access. */
    exportName: string;
    /** Source file relative to `<projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the `ctx.db.normalizeId(...)` call the access is gated on. */
    line: number;
    /** `true` when the handler anywhere reads an ownership-named identifier or `ctx.auth`/`ctx.identity`/… — an intervening ownership signal. */
    mentionsOwnership: boolean;
    /** The id-first `ctx.db` sink the normalized id reaches. */
    sinkMethod: "delete" | "get" | "patch";
    /** Table named in the `normalizeId` call, or `""` when its table argument wasn't a string literal. */
    table: string;
    /** `true` when the procedure's builder chain carries a `.use(rls(...))` step. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery`/`internalMutation`; `"public"` for `query`/`mutation`. */
    visibility: "internal" | "public";
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the NormalizeIdAuthorizationIR doc block */

/**
 * One committed `wrangler.jsonc` `vars` entry whose value is a plaintext secret —
 * the `plaintext_secret_in_wrangler_vars` lint input. `vars` are baked into the
 * deployed Worker in cleartext and checked into source control, so a real API key
 * / token / private key there ships the secret to every reader of the repo and the
 * bundle; it belongs in a Secrets Store binding or `wrangler secret put`. Produced
 * by `@lunora/config` (which reads `wrangler.jsonc`), not a ts-morph feeder —
 * codegen only passes it through. Structurally identical to `AdvisorWranglerVariable`.
 */
export interface WranglerVariableIR {
    /** The `wrangler.jsonc` file the var was read from, relative to the project root. */
    file: string;
    /** The offending `vars` key (e.g. `STRIPE_SECRET_KEY`). */
    key: string;
    /** Heuristic that matched, e.g. `stripe_live_key` / `private_key` / `secret_named_var`. */
    kind: string;
    /** Redacted preview of the value (first few chars + length) for the finding detail — never the full secret. */
    preview: string;
}

export interface ProjectIR {
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    /** Typed REST routes discovered from `httpRoute.<verb>(...)` builder chains. */
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    migrations: ReadonlyArray<MigrationIR>;
    schema: SchemaIR;
}

/**
 * One import of a migrated-away platform's SDK still present in `lunora/`
 * source. Structurally identical to the advisor's `AdvisorStaleMigrationImport`
 * so it passes through the feeder without conversion.
 */
export interface StaleMigrationImportIR {
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the import, or `0` when unknown. */
    line: number;
    /** The imported module, e.g. `@supabase/supabase-js`. */
    moduleSpecifier: string;
    /** Which migration guide covers this platform. */
    platform: "convex" | "firebase" | "supabase";
}
