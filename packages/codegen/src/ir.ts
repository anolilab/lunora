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
    /** For `v.id("table")` — the table name. */
    tableName?: string;
    valueType?: ValidatorIR;
}

export interface IndexIR {
    fields: ReadonlyArray<string>;
    name: string;
    unique?: boolean;
}

export interface SearchIndexIR {
    /** Primary text-search field. */
    field: string;
    /** Optional filter fields surfaced alongside the FTS column. */
    filterFields?: ReadonlyArray<string>;
    name: string;
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

export interface TableIR {
    indexes: ReadonlyArray<IndexIR>;
    name: string;
    /** Rank indexes declared inline via `.rankIndex(name, …)`. */
    rankIndexes: ReadonlyArray<RankIndexIR>;
    /** Declared relations (via `.relations((r) => …)`), keyed in source order. */
    relations: ReadonlyArray<RelationIR>;
    searchIndexes: ReadonlyArray<SearchIndexIR>;
    shape: Record<string, ValidatorIR>;
    shardMode: "global" | "root" | { field: string; kind: "shardBy" };
    /** Vector indexes declared inline via `.vectorize()` (DSL Shape A). */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

export interface SchemaIR {
    tables: ReadonlyArray<TableIR>;
    /** All vector indexes (inline Shape A hoisted + standalone Shape B), flattened. */
    vectorIndexes: ReadonlyArray<VectorIndexIR>;
}

export interface FunctionIR {
    args: Record<string, ValidatorIR>;
    exportName: string;
    /** Path relative to `&lt;projectRoot>/lunora/` without extension, e.g. "messages". */
    filePath: string;
    kind: "action" | "mutation" | "query" | "stream";

    /**
     * Serialized TS source for the handler's return type, with `Promise&lt;T>`
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
 * import wiring needs {@link MigrationIR.exportName}/{@link MigrationIR.filePath}. {@link MigrationIR.table} is
 * informational (the runtime object carries the authoritative value).
 */
export interface MigrationIR {
    /** Export binding name, used to reference the module member in generated imports. */
    exportName: string;
    /** Path relative to `&lt;projectRoot>/lunora/` without extension, e.g. "migrations". */
    filePath: string;
    /** Stable migration id — the registry key and per-shard run-state key. */
    id: string;
    /** Table the migration iterates; `""` when not a static string literal. */
    table: string;
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
    /** Target function ref `namespace:fn`. */
    functionPath: string;
    /** Unique, human-readable job name. */
    name: string;
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** 1-based line of the `get(...)` call. */
    line: number;
    /** The referenced workflow export name, or `""` when the argument is not a string literal. */
    workflow: string;
}

/**
 * A `ctx.db.query("table")…` read discovered in a function body, reduced to what
 * the `filter_without_index` advisor lint needs: which table, whether the chain
 * narrows with an index, and whether it filters. `table` is `""` when the
 * `query(...)` argument is not a string literal (a dynamic table — not lintable).
 */
export interface QueryReadIR {
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
    file: string;
    /** The chain calls `.filter(...)`. */
    hasFilter: boolean;
    /** The chain narrows with `.withIndex(...)` or `.withSearchIndex(...)`. */
    hasIndex: boolean;
    /** 1-based line of the `query(...)` call. */
    line: number;
    /** Queried table name, or `""` when the argument is not a string literal. */
    table: string;
}

/**
 * A `ctx.authApi.&lt;method>(...)` call discovered in a function body, attributed
 * to the exported function (and its file = api namespace) that performs it.
 * Structurally identical to `AdvisorAuthApiCall` so it passes straight through
 * to the advisor lint without conversion, exactly as `InsertWriteIR` does for
 * `AdvisorInsertWrite`.
 */
export interface AuthApiCallIR {
    /** Export binding name of the function performing the call, e.g. "createOrg". */
    exportName: string;
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension (the api namespace). */
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the call lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the call, or `0` when unknown. */
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
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
 * A typed REST route declared with the `httpRoute.&lt;verb>("/path")…` builder in
 * `@lunora/server` and mounted on `httpRouter()`. Captured statically from the
 * builder chain so the OpenAPI emitter can render a real `paths` entry: the verb
 * + path become the operation's method + URL, and the accumulated validator maps
 * become its query parameters, path parameters, and request body.
 */
export interface HttpRouteIR {
    /** `v.*` validators decoding the JSON request body (`.body({...})`), keyed by field. */
    body: Record<string, ValidatorIR>;
    /** Export binding name of the route handler (used only for diagnostics / dedupe). */
    exportName: string;
    /** Path relative to `&lt;projectRoot>/lunora/` without extension, e.g. "http". */
    filePath: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"GET"`. */
    method: string;
    /** The `.output(validator)` return schema when declared; absent ⇒ TS-inferred / best-effort. */
    output?: ValidatorIR;
    /** `v.*` validators decoding the hono path params (`.params({...})`), keyed by `:name`. */
    params: Record<string, ValidatorIR>;
    /** The route path passed to `httpRoute.&lt;verb>(path)`, e.g. `/api/todos/:id`. */
    path: string;
    /** `v.*` validators decoding the URL query string (`.searchParams({...})`), keyed by name. */
    searchParams: Record<string, ValidatorIR>;
    /** `true` when declared via the terminal `.stream(...)` (Server-Sent Events) rather than `.handler(...)`. */
    stream: boolean;
}

export interface ProjectIR {
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    /** Typed REST routes discovered from `httpRoute.&lt;verb>(...)` builder chains. */
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    migrations: ReadonlyArray<MigrationIR>;
    schema: SchemaIR;
}
