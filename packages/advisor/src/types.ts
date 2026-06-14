import type { AdvisorAuthApiCall } from "./authapi-calls";
import type { AdvisorContainer } from "./containers";
import type { AdvisorIndexHit, AdvisorTableScan } from "./index-usage";
import type { AdvisorInsertWrite } from "./inserts";
import type { AdvisorMaskProcedure } from "./mask-procedures";
import type { AdvisorQueryRead } from "./queries";
import type { AdvisorRlsProcedure } from "./rls-procedures";
import type { AdvisorSchema } from "./schema";
import type { AdvisorShardTraffic } from "./shard-traffic";
import type { AdvisorWorkflow, AdvisorWorkflowCall } from "./workflows";

/**
 * Severity of a finding, mirroring splinter's `level`. `ERROR` is a definite
 * problem, `WARN` a likely one, `INFO` an advisory nudge.
 */
export type Level = "ERROR" | "INFO" | "WARN";

/**
 * Who the finding concerns, mirroring splinter's `facing`. `EXTERNAL` findings
 * affect clients of the app (performance/security a user can feel); `INTERNAL`
 * ones are operator-only hygiene.
 */
export type Facing = "EXTERNAL" | "INTERNAL";

/**
 * Concern bucket a lint belongs to. `SCHEMA` covers shape/correctness nits that
 * are neither a perf nor a security issue (missing primary key, duplicate
 * index). `PERFORMANCE` and `SECURITY` match splinter's two categories.
 */
export type Category = "PERFORMANCE" | "SCHEMA" | "SECURITY";

/**
 * Where a lint draws its evidence from.
 *
 * `static` runs against the declared {@link AdvisorSchema} alone (tables,
 * indexes, relations) — deterministic, runnable at codegen/build time, and
 * catches a problem _before_ it ships. This is the edge Cirrus has over a
 * live-DB-only advisor like Supabase's.
 *
 * `runtime` needs observed signal from a running shard (full-scan attribution,
 * function call stats). Added in a later slice; the context grows optional
 * fields the runtime lints read.
 */
export type LintSource = "runtime" | "static";

/**
 * One emitted advisory, shaped after splinter's lint-view row so the studio
 * Advisors table can render any lint uniformly. `cacheKey` is a stable,
 * content-derived id used to dedup across runs and to let an operator dismiss a
 * specific finding without silencing the whole lint.
 */
export interface Finding {
    /** Stable identifier for dedup/dismissal across runs. */
    cacheKey: string;
    /** The lint's concern buckets (usually one). */
    categories: Category[];
    /** Human-readable explanation of the rule in general terms. */
    description: string;
    /** The specific violation message for _this_ occurrence. */
    detail: string;
    /** Who the finding concerns. */
    facing: Facing;
    /** Severity. */
    level: Level;
    /** Structured context (table, field, index, …) for the UI and deep links. */
    metadata: Record<string, unknown>;
    /** The lint id that produced this finding, e.g. `unindexed_foreign_key`. */
    name: string;
    /** How to fix it — a doc URL or short imperative guidance. */
    remediation: string;
    /** Short headline for the finding. */
    title: string;
}

/**
 * Everything a lint may inspect. Static lints read only {@link LintContext.schema};
 * runtime lints will additionally read observed-signal fields added here later.
 */
export interface LintContext {
    /**
     * `ctx.authApi.&lt;method>(...)` calls discovered in function bodies (the
     * `auth_api_call_without_headers` input). Supplied by the codegen feeder; absent
     * for runtime callers, where the lint finds nothing.
     */
    authApiCalls?: ReadonlyArray<AdvisorAuthApiCall>;

    /**
     * Containers declared in `cirrus/containers.ts` — the `container_*` lint
     * input. Supplied by the codegen feeder; absent for runtime callers, where
     * the container lints find nothing.
     */
    containers?: ReadonlyArray<AdvisorContainer>;

    /**
     * Per-declared-index hit counts observed at runtime (the dead-index half of
     * the `index_utilization` lint input). Supplied by the studio backend, which
     * sums the per-`(table, index)` reads each shard records in the durable
     * `__cirrus_metrics_index` table and surfaces through the `getMetrics` admin
     * RPC (see {@link AdvisorIndexHit}). Absent for static callers, where the
     * dead-index check finds nothing.
     */
    indexHits?: ReadonlyArray<AdvisorIndexHit>;

    /**
     * Insert writes discovered in function bodies (the `table_without_insert`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the write-shaped lints simply find nothing.
     */
    inserts?: ReadonlyArray<AdvisorInsertWrite>;

    /**
     * Per-procedure column-masking usage discovered in function bodies (the
     * `mask_uncovered_pii_column` input). Carries whether each procedure's builder
     * chain includes `.use(mask(...))`, which `(table, column)` pairs its mask
     * policy declares, and which tables the procedure reads/writes. Supplied by
     * the codegen feeder; absent for runtime callers, where the lint finds
     * nothing.
     */
    maskProcedures?: ReadonlyArray<AdvisorMaskProcedure>;

    /**
     * Query reads discovered in function bodies (the `filter_without_index`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the query-shaped lints simply find nothing.
     */
    queries?: ReadonlyArray<AdvisorQueryRead>;

    /**
     * Per-procedure RLS usage discovered in function bodies (the
     * `rls_uncovered_table` input). Carries whether each procedure's builder chain
     * includes `.use(rls(...))`, which tables the procedure reads/writes, and which
     * tables its RLS policy array names. Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    rlsProcedures?: ReadonlyArray<AdvisorRlsProcedure>;

    /** The declared schema under audit, normalized to the feeder-agnostic {@link AdvisorSchema}. */
    schema: AdvisorSchema;

    /**
     * Per-shard observed traffic — the `hot_shard` lint input. Supplied by the
     * studio backend, which fans out over a sharded function's shards and reads
     * each shard's recorded request volume from the durable `__cirrus_metrics`
     * accumulator. Absent for static callers, where the lint finds nothing.
     */
    shardTraffic?: ReadonlyArray<AdvisorShardTraffic>;

    /**
     * Per-table full-scan volume observed at runtime (the hot-scan half of the
     * `index_utilization` lint input). Sourced from the per-`(function, table)`
     * full-scan attribution the runtime records (`__cirrus_metrics_scans`,
     * surfaced as `FunctionCallStat.scannedTables`), aggregated across functions
     * and shards. Absent for static callers, where the lint finds nothing.
     */
    tableScans?: ReadonlyArray<AdvisorTableScan>;

    /**
     * `ctx.workflows.get("name")` call sites discovered in function bodies — the
     * use-side input the `workflow_unused` and `workflow_unknown_target` lints
     * cross-reference against {@link LintContext.workflows}. Supplied by the
     * codegen feeder; absent for runtime callers, where the workflow lints find
     * nothing.
     */
    workflowCalls?: ReadonlyArray<AdvisorWorkflowCall>;

    /**
     * Workflows declared via `defineWorkflow` exports in `cirrus/workflows.ts` —
     * the declaration-side input for the `workflow_*` lints. Supplied by the
     * codegen feeder; absent for runtime callers, where the workflow lints find
     * nothing.
     */
    workflows?: ReadonlyArray<AdvisorWorkflow>;
}

/**
 * A single advisory rule. `run` is pure over its {@link LintContext} so lints are
 * trivially testable and order-independent. Each rule owns the static metadata
 * (`name`/`title`/…) that its findings inherit, keeping individual `Finding`
 * construction to just the per-occurrence `detail`/`metadata`/`cacheKey`.
 */
export interface Lint {
    /** Concern buckets every finding from this lint carries. */
    categories: Category[];
    /** General-purpose description shared by every finding. */
    description: string;
    /** Default audience for this lint's findings. */
    facing: Facing;
    /** Default severity for this lint's findings. */
    level: Level;
    /** Unique lint id, snake_case (e.g. `unindexed_foreign_key`). */
    name: string;
    /** Fix guidance shared by every finding. */
    remediation: string;
    /** Produce zero or more findings for the given context. */
    run: (context: LintContext) => Finding[];
    /** Evidence source — see {@link LintSource}. */
    source: LintSource;
    /** Short headline shared by every finding. */
    title: string;
}
