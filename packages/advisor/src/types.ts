import type { AdvisorInsertWrite } from "./inserts";
import type { AdvisorQueryRead } from "./queries";
import type { AdvisorSchema } from "./schema";

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
     * Insert writes discovered in function bodies (the `table_without_insert`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the write-shaped lints simply find nothing.
     */
    inserts?: ReadonlyArray<AdvisorInsertWrite>;

    /**
     * Query reads discovered in function bodies (the `filter_without_index`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the query-shaped lints simply find nothing.
     */
    queries?: ReadonlyArray<AdvisorQueryRead>;
    /** The declared schema under audit, normalized to the feeder-agnostic {@link AdvisorSchema}. */
    schema: AdvisorSchema;
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
