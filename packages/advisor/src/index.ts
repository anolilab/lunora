/**
 * `@lunora/advisor` — schema & runtime lints (splinter-style advisors) for Lunora.
 *
 * Each {@link Lint} is a pure rule over a {@link LintContext}; {@link runAdvisor}
 * runs a set of them and flattens their {@link Finding}s for the studio Advisors
 * table. The interface is shaped after Supabase's splinter so the UI can render
 * any lint uniformly, but the rules run against Lunora's declared schema (and,
 * later, observed runtime signal) rather than Postgres catalog views.
 */
import constraintValidator from "./lints/runtime/constraint-validator";
import hotShard from "./lints/runtime/hot-shard";
import indexUtilization from "./lints/runtime/index-utilization";
import adminRouteWithoutGuard from "./lints/static/admin-route-without-guard";
import authApiCallWithoutHeaders from "./lints/static/auth-api-call-without-headers";
import circularFk from "./lints/static/circular-fk";
import containerOversizedInstance from "./lints/static/container-oversized-instance";
import containerPublicInternet from "./lints/static/container-public-internet";
import duplicateIndex from "./lints/static/duplicate-index";
import emptyIndex from "./lints/static/empty-index";
import filterWithoutIndex from "./lints/static/filter-without-index";
import hardcodedSecret from "./lints/static/hardcoded-secret";
import hyperdriveOutsideAction from "./lints/static/hyperdrive-outside-action";
import indexReferencesUnknownField from "./lints/static/index-references-unknown-field";
import maskUncoveredPiiColumn from "./lints/static/mask-uncovered-pii-column";
import mutatorFullRowReplace from "./lints/static/mutator-full-row-replace";
import nondeterministicQueryMutation from "./lints/static/nondeterministic-query-mutation";
import policyReferencesUnknownTable from "./lints/static/policy-references-unknown-table";
import publicArgumentUsesAny from "./lints/static/public-argument-uses-any";
import publicMutationWithoutRatelimit from "./lints/static/public-mutation-without-ratelimit";
import r2sqlOutsideAction from "./lints/static/r2sql-outside-action";
import relationReferencesUnknownField from "./lints/static/relation-references-unknown-field";
import relationReferencesUnknownTable from "./lints/static/relation-references-unknown-table";
import rlsUncoveredTable from "./lints/static/rls-uncovered-table";
import shapeTargetsGlobalTable from "./lints/static/shape-targets-global-table";
import shapeUnknownTable from "./lints/static/shape-unknown-table";
import sqlInjectionRisk from "./lints/static/sql-injection-risk";
import tableWithoutInsert from "./lints/static/table-without-insert";
import unboundedStringArgument from "./lints/static/unbounded-string-argument";
import unindexedForeignKey from "./lints/static/unindexed-foreign-key";
import unindexedRelationTarget from "./lints/static/unindexed-relation-target";
import userCreatingMutationWithoutCaptcha from "./lints/static/user-creating-mutation-without-captcha";
import workflowDuplicateStepName from "./lints/static/workflow-duplicate-step-name";
import workflowUnknownTarget from "./lints/static/workflow-unknown-target";
import workflowUnused from "./lints/static/workflow-unused";
import type { Finding, Lint, LintContext, LintSource } from "./types";

export type { AdvisorAdminRoute } from "./admin-routes";
export type { AnalyticsMetricsOptions, AnalyticsMetricsSource, AnalyticsRuntimeMetrics } from "./ae-metrics";
export { AE_METRIC_EVENTS, loadAnalyticsRuntimeMetrics } from "./ae-metrics";
export type { AdvisorArgumentValidator } from "./argument-validators";
export type { AdvisorAuthApiCall } from "./authapi-calls";
export type { AdvisorContainer } from "./containers";
export type { AdvisorHyperdriveCall } from "./hyperdrive-calls";
export type { AdvisorIndexHit, AdvisorTableScan } from "./index-usage";
export type { AdvisorInsertWrite } from "./inserts";
export { default as constraintValidator } from "./lints/runtime/constraint-validator";
export { default as hotShard } from "./lints/runtime/hot-shard";
export { default as indexUtilization } from "./lints/runtime/index-utilization";
export { default as adminRouteWithoutGuard } from "./lints/static/admin-route-without-guard";
export { default as authApiCallWithoutHeaders } from "./lints/static/auth-api-call-without-headers";
export { default as circularFk } from "./lints/static/circular-fk";
export { default as containerOversizedInstance } from "./lints/static/container-oversized-instance";
export { default as containerPublicInternet } from "./lints/static/container-public-internet";
export { default as duplicateIndex } from "./lints/static/duplicate-index";
export { default as emptyIndex } from "./lints/static/empty-index";
export { default as filterWithoutIndex } from "./lints/static/filter-without-index";
export { default as hardcodedSecret } from "./lints/static/hardcoded-secret";
export { default as hyperdriveOutsideAction } from "./lints/static/hyperdrive-outside-action";
export { default as indexReferencesUnknownField } from "./lints/static/index-references-unknown-field";
export { default as maskUncoveredPiiColumn } from "./lints/static/mask-uncovered-pii-column";
export { default as mutatorFullRowReplace } from "./lints/static/mutator-full-row-replace";
export { default as nondeterministicQueryMutation } from "./lints/static/nondeterministic-query-mutation";
export { default as policyReferencesUnknownTable } from "./lints/static/policy-references-unknown-table";
export { default as publicArgumentUsesAny } from "./lints/static/public-argument-uses-any";
export { default as publicMutationWithoutRatelimit } from "./lints/static/public-mutation-without-ratelimit";
export { default as r2sqlOutsideAction } from "./lints/static/r2sql-outside-action";
export { default as relationReferencesUnknownField } from "./lints/static/relation-references-unknown-field";
export { default as relationReferencesUnknownTable } from "./lints/static/relation-references-unknown-table";
export { default as rlsUncoveredTable } from "./lints/static/rls-uncovered-table";
export { default as shapeTargetsGlobalTable } from "./lints/static/shape-targets-global-table";
export { default as shapeUnknownTable } from "./lints/static/shape-unknown-table";
export { default as sqlInjectionRisk } from "./lints/static/sql-injection-risk";
export { default as tableWithoutInsert } from "./lints/static/table-without-insert";
export { default as unboundedStringArgument } from "./lints/static/unbounded-string-argument";
export { default as unindexedForeignKey } from "./lints/static/unindexed-foreign-key";
export { default as unindexedRelationTarget } from "./lints/static/unindexed-relation-target";
export { default as userCreatingMutationWithoutCaptcha } from "./lints/static/user-creating-mutation-without-captcha";
export { default as workflowDuplicateStepName } from "./lints/static/workflow-duplicate-step-name";
export { default as workflowUnknownTarget } from "./lints/static/workflow-unknown-target";
export { default as workflowUnused } from "./lints/static/workflow-unused";
export type { AdvisorMaskProcedure } from "./mask-procedures";
export type { AdvisorMutatorWrite } from "./mutator-writes";
export type { AdvisorNondeterministicCall } from "./nondeterministic-calls";
export type { AdvisorProcedureProtection } from "./procedure-protections";
export type { AdvisorQueryRead } from "./queries";
export type { AdvisorR2sqlCall } from "./r2sql-calls";
export type { AdvisorRlsProcedure } from "./rls-procedures";
export type { AdvisorIndex, AdvisorRelation, AdvisorSchema, AdvisorTable } from "./schema";
export { fromServerSchema } from "./schema";
export type { AdvisorSecretLiteral } from "./secrets";
export type { AdvisorShape } from "./shapes";
export type { AdvisorShardTraffic } from "./shard-traffic";
export type { AdvisorSqlInterpolation } from "./sql-interpolation";
export type { AdvisorTableSample } from "./table-samples";
export type { Category, Facing, Finding, Level, Lint, LintContext, LintSource } from "./types";
export type { AdvisorWorkflow, AdvisorWorkflowCall } from "./workflows";

/**
 * Every lint that runs against the declared schema (and, for
 * `filter_without_index`, the discovered query reads) — no running shard
 * required. Correctness lints (`*_unknown_*`, `empty_index`) come first so a
 * broken schema's errors surface above the performance advisories.
 */
export const STATIC_LINTS: ReadonlyArray<Lint> = [
    indexReferencesUnknownField,
    relationReferencesUnknownTable,
    relationReferencesUnknownField,
    workflowUnknownTarget,
    workflowDuplicateStepName,
    shapeUnknownTable,
    emptyIndex,
    circularFk,
    unindexedForeignKey,
    unindexedRelationTarget,
    duplicateIndex,
    tableWithoutInsert,
    workflowUnused,
    filterWithoutIndex,
    shapeTargetsGlobalTable,
    mutatorFullRowReplace,
    nondeterministicQueryMutation,
    hyperdriveOutsideAction,
    r2sqlOutsideAction,
    authApiCallWithoutHeaders,
    policyReferencesUnknownTable,
    rlsUncoveredTable,
    maskUncoveredPiiColumn,
    containerOversizedInstance,
    containerPublicInternet,
    publicMutationWithoutRatelimit,
    userCreatingMutationWithoutCaptcha,
    publicArgumentUsesAny,
    unboundedStringArgument,
    hardcodedSecret,
    sqlInjectionRisk,
    adminRouteWithoutGuard,
];

/**
 * Every lint that needs observed runtime signal (recorded metrics) rather than
 * just the declared schema. They read the feeder-supplied
 * {@link LintContext.shardTraffic} / {@link LintContext.tableScans} /
 * {@link LintContext.indexHits}; absent that signal (a static caller) each is a
 * no-op. Run them with `runAdvisor(ctx, { source: "runtime" })` against a live
 * deployment's aggregated metrics.
 */
export const RUNTIME_LINTS: ReadonlyArray<Lint> = [hotShard, indexUtilization, constraintValidator];

/** The default lint set: the static lints, then the runtime lints. A caller filters by `source` to run one tier. */
export const ALL_LINTS: ReadonlyArray<Lint> = [...STATIC_LINTS, ...RUNTIME_LINTS];

/** Options for {@link runAdvisor}. */
export interface RunAdvisorOptions {
    /** Lints to run (default: {@link ALL_LINTS}). */
    lints?: ReadonlyArray<Lint>;
    /** Restrict to a single evidence source — e.g. `"static"` at codegen time. */
    source?: LintSource;
}

/**
 * Run lints against a context and return their findings in lint-declaration
 * order. Filtering by {@link RunAdvisorOptions.source} lets a caller run only
 * `static` lints at build time and defer `runtime` lints to a live shard.
 */
export const runAdvisor = (context: LintContext, options: RunAdvisorOptions = {}): Finding[] => {
    const lints = options.lints ?? ALL_LINTS;
    const findings: Finding[] = [];

    for (const lint of lints) {
        if (options.source !== undefined && lint.source !== options.source) {
            continue;
        }

        findings.push(...lint.run(context));
    }

    return findings;
};
