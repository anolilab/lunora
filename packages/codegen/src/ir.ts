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
     * `true` when this validator carries a `.check(...)` refinement. The predicate
     * is a runtime closure the AST→IR step can't represent, so the node keeps its
     * base `kind` but records the refinement's presence here. The AOT args-validator
     * compiler declines any node with this flag (compiling it would silently skip
     * the predicate). `.meta(...)` is pure metadata with no parse effect and does
     * NOT set this.
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
    /** `true` when a `reconcileEveryMs` was given (the incremental-mode delete-visibility companion). */
    hasReconcile?: boolean;
    /** `true` when a `tenantBy` mapper was given — the tenant-isolation boundary the `external_source_unscoped` lint checks. */
    hasTenantBy: boolean;
    /** The `idColumn` literal, when given (defaults to `"id"` at runtime). */
    idColumn?: string;
    /** Delete-detection mode literal, when given (`"full-pull"` | `"incremental"`). */
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
    globalBackend?: "d1" | "hyperdrive";
    indexes: ReadonlyArray<IndexIR>;
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
     * Set on connection-lifecycle hooks (`onConnect`/`onDisconnect`): the socket
     * side the hook fires on. Such a function is also an internal mutation (so it
     * lands in `LUNORA_FUNCTIONS` for path dispatch); emit additionally collects
     * it into the `LUNORA_LIFECYCLE_HOOKS` manifest keyed by this side. Absent on
     * ordinary functions.
     */
    lifecycle?: "connect" | "disconnect";

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
 * A `defineShape({...})` declaration discovered in `lunora/shapes.ts`
 * (local-first sync engine, Phase 7). The emitted `LUNORA_SHAPES` registry keys
 * on {@link ShapeIR.exportName}; the generated DO's `resolveShape` override
 * dispatches a `shape_subscribe` to the matching registered shape. Discovery is
 * marker-driven (the `__lunoraShape` brand) — no field metadata is lifted here
 * because the runtime object (`columns`/`compileWhere`) carries the authority.
 */
export interface ShapeIR {
    /** Export binding name — the shape's registry key and import member. */
    exportName: string;
    /** Path relative to `&lt;projectRoot>/lunora/` without extension — always `"shapes"`. */
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
 * A `defineMutator({...})` declaration discovered in `lunora/mutators.ts`
 * (local-first sync engine, Phase 7). The emitted registry registers the
 * authoritative `server` impl into the DO's `LUNORA_FUNCTIONS` table (so
 * `handleRpc` transaction-wraps it) and records its path in
 * `LUNORA_MUTATOR_PATHS` so the DO's `isCustomMutator` override routes the
 * client-watermark push protocol. The client `client` impl is split into the
 * browser bundle separately — only the path crosses to the server side.
 */
export interface MutatorIR {
    /** Export binding name — the mutator's registry key and import member. */
    exportName: string;
    /** Path relative to `&lt;projectRoot>/lunora/` without extension — always `"mutators"`. */
    filePath: string;
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
     * Whether the definition opted into public run-starts via
     * `defineAgent({ publicRun: true })` — emitted into the `ctx.agents` wiring
     * spec so the public `agents:agentRun` mutation can gate on it fail-closed.
     * Absent (falsy) means server-side starts only; the field is written to IR
     * only when the literal is `true`, so agent-free and non-opted-in output is
     * byte-identical.
     */
    publicRun?: boolean;
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
 * One `ctx.r2sql` access lexically inside a `query`/`mutation` handler — the
 * `r2sql_outside_action` advisor lint input. Structurally identical to the
 * advisor's `AdvisorR2sqlCall` (same field set) so values pass straight through
 * `lintSchema` without conversion, exactly as `NondeterministicCallIR` does.
 * Only `query`/`mutation` handlers are recorded; `action(...)` is the intended
 * home for `ctx.r2sql` and is skipped.
 */
export interface R2sqlCallIR {
    /** The accessed `ctx.r2sql` surface, e.g. `ctx.r2sql.query` / `ctx.r2sql.from`. */
    callee: string;
    /** Export binding name of the function performing the access. */
    exportName: string;
    /** Source file relative to the lunora dir, without extension (the api namespace). */
    file: string;
    /** Which procedure kind the access lives in — only `query`/`mutation` handlers are recorded. */
    kind: "mutation" | "query";
    /** 1-based line of the access, or `0` when unknown. */
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
    /** `true` when the handler (or a helper inside it) references `ctx.mail` / `ctx.email`. */
    callsMail: boolean;
    /** Export binding name of the procedure (e.g. `signUp`). */
    exportName: string;
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
    file: string;
    /** Registration kind — only `mutation`/`action` are write-shaped; `query` is read-only. */
    kind: "action" | "mutation" | "query";
    /** `true` when the chain carries `.use(verifyTurnstile(...))` or a `protectPublic({ captcha })` bundle. */
    usesCaptcha: boolean;
    /** `true` when the chain carries `.use(mask(...))`. */
    usesMask: boolean;
    /** `true` when the chain carries `.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle. */
    usesRateLimit: boolean;
    /** `true` when the chain carries `.use(rls(...))`. */
    usesRls: boolean;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
    /** `true` when the handler inserts into a user/session/account-shaped table. */
    writesUserTable: boolean;
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the registration call, or `0` when unknown. */
    line: number;
    /** Arg names declared as `v.string()` with no statically-visible max-length bound. */
    unboundedStringArgs: string[];
}

/**
 * One secret-shaped string literal discovered in `lunora/` source — the
 * `hardcoded_secret` lint input. Complements the pre-commit `vis secrets` scan by
 * surfacing the same class of finding in-IDE via the studio Advisors table.
 * Structurally identical to `AdvisorSecretLiteral`.
 */
export interface SecretLiteralIR {
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
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
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
    file: string;
    /** 1-based line of the interpolation, or `0` when unknown. */
    line: number;
}

/**
 * One discovered `httpRoute.&lt;verb>("/admin/…")` route on an admin/privileged-looking
 * path, with whether its builder chain references an auth/admin guard — the
 * `admin_route_without_guard` lint input. Structurally identical to
 * `AdvisorAdminRoute`.
 */
export interface AdminRouteIR {
    /** Export binding name of the route handler. */
    exportName: string;
    /** Source file relative to `&lt;projectRoot>/lunora/`, without extension. */
    file: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"POST"`. */
    method: string;
    /** The route path, e.g. `/admin/users`. */
    path: string;
    /** `true` when the handler body references an auth/session/admin guard (`ctx.auth`, `getSession`, `requireAdmin`, …). */
    usesGuard: boolean;
}

export interface ProjectIR {
    crons: ReadonlyArray<CronJobIR>;
    functions: ReadonlyArray<FunctionIR>;
    /** Typed REST routes discovered from `httpRoute.&lt;verb>(...)` builder chains. */
    httpRoutes: ReadonlyArray<HttpRouteIR>;
    migrations: ReadonlyArray<MigrationIR>;
    schema: SchemaIR;
}
