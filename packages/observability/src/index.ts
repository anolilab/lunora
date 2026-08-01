/**
 * `@lunora/observability` — host-neutral telemetry storage and read models.
 *
 * Logs, traces, metrics, issue grouping and the security-audit view: the data
 * behind the Studio's observability pages. None of it is Cloudflare-specific —
 * it reads and writes through the SQL handle the engine hands it, and it lived
 * inside `@lunora/do` only because that is where the Durable Object it
 * instruments happens to live.
 *
 * The dependency runs `@lunora/do` → here → `@lunora/shard-engine`, never the
 * reverse, which is what makes this reusable by a second host rather than
 * merely relocated.
 *
 * This barrel is deliberately curated rather than `export *`. A star export
 * would promote every module internal to permanent public API — the exact
 * mistake `@lunora/do`'s own barrel documents having made once with the search
 * core. What is exported here is what a consumer actually needs.
 */

export type { AuthMetrics, AuthMetricsBucket, RecordAuthEventInput } from "./auth-metrics";
export {
    AUTH_METRICS_BUCKET_MS,
    AUTH_METRICS_BUCKET_RETENTION,
    AUTH_METRICS_BUCKETS_TABLE,
    AUTH_METRICS_TABLE,
    ensureAuthMetricsTables,
    readAuthMetrics,
    recordAuthEvent,
} from "./auth-metrics";
export type {
    ContextFetch,
    ContextMetrics,
    ContextTracer,
    HostSpanLike,
    HostTracingLike,
    HostTracingResolver,
    MetricEvent,
    MetricKind,
    MetricsDeps,
    SpanCollection,
    SpanCollector,
    SpanEvent,
    SpanEventPoint,
    SpanHandle,
    SpanKind,
    SpanLink,
    SpanOptions,
    TraceAnchor,
    TracedFetchDeps,
    TracerDeps,
} from "./context-telemetry";
export { createMetrics, createSpanCollector, createTracedFetch, createTracer, dispatchRootSpan } from "./context-telemetry";
export type { DatabaseInstrumentation, DatabaseTally, DatabaseTelemetryDeps } from "./database-telemetry";
export { createDatabaseTally, formatTally, instrumentDatabase } from "./database-telemetry";
export type { FunctionMetricBucket, FunctionMetricBucketsResult, FunctionMetricIndexHit, IndexHit, RecordFunctionMetricInput } from "./function-metrics";
export {
    ensureFunctionMetricsTables,
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKET_RETENTION,
    FUNCTION_METRICS_BUCKETS_TABLE,
    FUNCTION_METRICS_INDEX_TABLE,
    FUNCTION_METRICS_MAX_PATHS,
    FUNCTION_METRICS_READ_LIMIT,
    FUNCTION_METRICS_SCANS_TABLE,
    FUNCTION_METRICS_TABLE,
    mergeScanAttribution,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricScans,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "./function-metrics";
export type { AiRunBinding, ExplainIssueArgs, ExplainIssueDegradedReason, ExplainIssueGrounding, ExplainIssueResult } from "./issue-explainer";
export { DEFAULT_EXPLAIN_ISSUE_MODEL, explainIssue, parseExplainIssueArgs } from "./issue-explainer";
export type { IssueSeverity, IssueState, IssueStatePatch, IssueStatus } from "./issue-state";
export { ISSUE_SEVERITIES, ISSUE_STATE_TABLE, ISSUE_STATUSES, upsertIssueState } from "./issue-state";
export type { LogEntry, LogLevel } from "./log-buffer";
export { LogBuffer } from "./log-buffer";
export type { MetricSeries } from "./metric-buffer";
export { MetricBuffer } from "./metric-buffer";
export type { MetricHistoryOptions, MetricHistoryPoint, MetricHistoryResult, MetricHistorySeries } from "./metric-history";
export { readMetricHistory, recordMetricHistory } from "./metric-history";
export type { QueryInsightBucket, QueryInsightEntry, QueryInsightsResult, QueryStatEntry } from "./query-metrics";
export { readQueryInsights, readQueryMetrics, recordQueryMetric } from "./query-metrics";
export type {
    AppendRequestLogEntry,
    ContextLogLevel,
    ErrorIssue,
    IssuesResult,
    LogEventInput,
    ReadIssuesOptions,
    ReadRequestLogOptions,
    RequestLogEntry,
    RequestLogResult,
    RequestLogWriteOptions,
    RequestOutcome,
} from "./request-log";
export {
    appendRequestLogEntry,
    emitLogEvent,
    emitRequestLogEvent,
    ensureRequestLogTable,
    parseLogArgs,
    readErrorIssues,
    readRequestLog,
    redactArgs,
    REQUEST_LOG_TABLE,
} from "./request-log";
export type { SecurityAuditResult, SecurityFinding, SecurityFindingKind, SecurityFindingLevel } from "./security-audit";
export { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH, MIN_AUTH_SECRET_LENGTH } from "./security-audit";
export type { FoldedTraces, TraceSpan, TraceSummary } from "./span-buffer";
export { foldTraces, SpanBuffer } from "./span-buffer";
export type { DanglingReference, DanglingReferenceResult } from "./storage-correlation";
export { findDanglingReferences } from "./storage-correlation";
export { resolveTraceAnchor } from "./trace-context";
