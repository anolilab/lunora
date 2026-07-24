export type {
    ExportRow,
    ExportShardAdminArgs,
    ExportShardArgs,
    ImportError,
    ImportShardAdminArgs,
    ImportShardArgs,
    ImportShardResult,
} from "./admin-export-import";
export {
    exportShardRows,
    exportShardTable,
    importShardRows,
    parseExportShardArgs,
    parseImportShardArgs,
    selectExportTables,
    validateImportRow,
} from "./admin-export-import";
export { AGGREGATE_SQL_FUNCTION, aggregateSqlFunction, matchesStaticWhere, normalizeCountArgument, throwingScheduler } from "./aggregate-sql";
export type { AggregateTally } from "./aggregate-tally";
export { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally, readAggregateValue } from "./aggregate-tally";
export type {
    AggregateIndexDefinitionLike,
    AggregateOp,
    AggregateOptions,
    AggregateResult,
    GroupByEntry,
    GroupByOptions,
    RestrictableQueryOptions,
} from "@lunora/shard-engine";
export { CountRlsUnsupportedError, mergeWhere, planAggregateLookup, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "@lunora/shard-engine";
export type { AuditEntry } from "./audit-log";
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
export type { ContextMetrics, ContextTracer, MetricsDeps, SpanHandle, TraceAnchor, TracerDeps } from "./context-telemetry";
export { createMetrics, createTracer, dispatchRootSpan } from "./context-telemetry";
export type {
    BroadcastDelta,
    CdcChange,
    Clock,
    ColumnMetaLike,
    CountArgs,
    CtxDbOptions,
    DatabaseWriterLike,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    IdGenerator,
    IndexDefinitionLike,
    IndexRangeBuilderLike,
    PaginationOptions,
    ReadHook,
    SchemaLike,
    SearchFilterBuilderLike,
    ServerDefaultContextLike,
    SqlCursor,
    SqlExec,
    TableDefinitionLike,
    TableReaderLike,
    ValidatorLike,
    WriteEvent,
    WriteHook,
} from "./ctx-db";
export {
    applyCdcChanges,
    assertValidClientId,
    backfillAggregateIndexes,
    backfillRankIndexes,
    CDC_LOG_TABLE,
    createShardCtxDb,
    normalizeIdStructurally,
    NotUniqueError,
    readCdcChanges,
    runShardMigrations,
    trimCdcChanges,
} from "./ctx-db";
export type {
    DataMigrationDocument,
    DataMigrationLike,
    DataMigrationTransform,
    MigrationDirection,
    MigrationRunResult,
    MigrationStatus,
    MigrationStatusRow,
    RunDataMigrationOptions,
} from "./data-migration";
export { DATA_MIGRATION_STATE_TABLE, readMigrationStatus, runDataMigration } from "./data-migration";
// `external-source-cursor` is an internal ingest detail (the durable watermark
// codec + reserved-table helpers), consumed only by `external-source-pull` and its
// own tests — not re-exported, mirroring `external-source-diff`'s module-private
// `projectExternalSourceRow`.
export type { ExternalSourceDiffResult } from "./external-source-diff";
export { diffExternalSource } from "./external-source-diff";
export type { IncrementalMaterializeResult, MaterializeResult } from "./external-source-materialize";
export { materializeExternalRows, materializeExternalRowsIncremental, readExternalSourceBaseline, runExternalSourceTick } from "./external-source-materialize";
export type { ExternalSourceLike, SourceClientLike, SourceCursorLike, SourceRefresh } from "./external-source-pull";
export { isSoftDeleted, isSourceDue, liftSourceId, pullExternalSourceIncrementalTick, pullExternalSourceTick } from "./external-source-pull";
export type { FunctionMetricBucket, FunctionMetricIndexHit, RecordFunctionMetricInput } from "./function-metrics";
export {
    ensureFunctionMetricsTables,
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKET_RETENTION,
    FUNCTION_METRICS_BUCKETS_TABLE,
    FUNCTION_METRICS_INDEX_TABLE,
    FUNCTION_METRICS_TABLE,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "./function-metrics";
export type {
    AdvisoriesResult,
    AdvisoryFinding,
    AuditLogResult,
    ColumnMeta,
    DeployInfo,
    FacetColumnOptions,
    FacetColumnResult,
    FacetValue,
    FlagEvaluation,
    FlagsResult,
    FunctionCallStat,
    FunctionStatsResult,
    MaskColumnMetadata,
    MaskPoliciesResult,
    QueueMetadata,
    QueuesResult,
    ReadTablePageOptions,
    RlsPoliciesResult,
    RlsPolicyMetadata,
    RlsRoleMetadata,
    SelectMatchingIdsOptions,
    SettingEntry,
    SettingKind,
    SettingsResult,
    StorageRuleMetadata,
    StorageRulesResult,
    StudioFeaturesResult,
    TableColumnsResult,
    TableIndexesResult,
    TableIndexInfo,
    TableInfo,
    TablePage,
    TablesColumnsResult,
    WorkflowMetadata,
    WorkflowsResult,
} from "./introspect";
export {
    ADMIN_FUNCTION_PREFIX,
    ADMIN_FUNCTIONS,
    facetColumn,
    FLAGS_FUNCTION_PREFIX,
    listTables,
    readTablePage,
    RELATION_FUNCTION_PREFIX,
    selectMatchingIds,
} from "./introspect";
export type { LogEntry, LogLevel } from "./log-buffer";
export { LogBuffer } from "./log-buffer";
export type { CapturedMailRow, RecordMailInput } from "./mail-catcher";
export { clearCapturedMail, ensureMailTable, MAIL_RETENTION, MAIL_TABLE, readCapturedMail, recordCapturedMail } from "./mail-catcher";
export type { PitrBookmarkResult, PitrRestoreArgs, PitrRestoreResult, PitrStorage } from "./pitr";
export { armRestore, readBookmark } from "./pitr";
export type { OrderByInput, OrderKey, QueryArgs, QueryPage, SortDirection } from "@lunora/shard-engine";
export { applySelect, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, softDeleteScope } from "@lunora/shard-engine";
export type {
    RankDirection,
    RankIndexDefinitionLike,
    RankOptions,
    RankPage,
    RankPageOptions,
    RankPageRow,
    RankPageRowKey,
    RankResult,
    RankSortKeyLike,
    ShardRankPageResult,
} from "@lunora/shard-engine";
export { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankTableName, resolveRankPartition, sortColumnName } from "@lunora/shard-engine";
export { serveRelationFanout } from "./relation-fanout";
export type { ResolveRelationPredicatesOptions } from "./relation-predicates";
export {
    assertFlatPredicate,
    assertShapeShardable,
    containsRelationPredicate,
    DEFAULT_MAX_RELATION_KEYS,
    isRelationPredicate,
    resolveRelationPredicates,
} from "./relation-predicates";
export type { ApplyOnDeleteOptions, NestedWith, OnDeleteActionLike, RelationDefinitionLike, ResolveWithOptions, WithInput } from "./relations";
export { applyOnDelete, fanOutScalarCounts, resolveWith, runRowValidators } from "./relations";
export type { LogEventInput } from "./request-log";
export type { SecurityAuditResult, SecurityFinding, SecurityFindingKind, SecurityFindingLevel } from "./security-audit";
export { buildSecurityAudit, MIN_ADMIN_TOKEN_LENGTH, MIN_AUTH_SECRET_LENGTH } from "./security-audit";
export type { SessionRecord } from "./session-do";
export { SESSION_DO_TTL_DEFAULT, SessionDO } from "./session-do";
export type {
    HibernatableWebSocket,
    LogSink,
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkDeleteArgs,
    RunShardBulkDeleteResult,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOOptions,
    ShardDOState,
    SubscriptionOutcome,
    TelemetrySink,
} from "./shard-do";
export { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO, subscriptionListDeltas } from "./shard-do";
export { SHARD_REGISTRY_DO_NAME, ShardRegistryDO } from "./shard-registry-do";
export type { SqlConsoleResult } from "./sql-console";
export { assertReadonly, MAX_SQL_ROWS, runReadonlySql } from "./sql-console";
export type {
    ScheduledFunctionDoc,
    SystemDatabaseReader,
    SystemDoc,
    SystemQuery,
    SystemReaderOptions,
    SystemReaderSchedulerLike,
    SystemReaderStorageLike,
    SystemTableName,
} from "./system-reader";
export { createSystemReader } from "./system-reader";
export type {
    RunTriggersOptions,
    SchedulableWorkflowReferenceLike,
    SchedulerLike,
    TriggerContextLike,
    TriggerDefinitionLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
} from "./triggers";
export { hasTrigger, runTriggers } from "./triggers";
export type { TtlSweepSpec } from "./ttl-sweep";
export { selectExpiredIds } from "./ttl-sweep";
export type { WhereSqlStrategy } from "@lunora/shard-engine";
export type { RenderedSql, SqlEngine } from "@lunora/shard-engine";
export type { MutationDelta, RpcRequest, ShapeSubscriptionQuery, SocketAttachment, SubscriptionEnvelope, SubscriptionQuery } from "@lunora/shard-engine";
export type { GeoBoundingBox, GeoPoint } from "@lunora/shard-engine";
export type { CacheEntry, ReactiveCacheOptions } from "@lunora/shard-engine";
export type { FieldOperators, WhereInput } from "@lunora/shard-engine";
export type { DependencyTracker } from "@lunora/shard-engine";
export type { TransactionSqlLike } from "@lunora/shard-engine";
export { compileWhereSql } from "@lunora/shard-engine";
export { renderSql } from "@lunora/shard-engine";
export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "@lunora/shard-engine";
export {
    boundingBoxCenter,
    boundingBoxGeohashes,
    coveringGeohashes,
    encodeGeohash,
    GEO_DEFAULT_PRECISION,
    haversineMeters,
    pointInBoundingBox,
} from "@lunora/shard-engine";
export { NotFoundError } from "@lunora/shard-engine";
export { ReactiveCache, reactiveCacheKey, stableStringify, stableWireKey } from "@lunora/shard-engine";
export { buildFtsMatch, ftsTableName, scoreDocument, stringifySearchText, tokenizeSearch } from "@lunora/shard-engine";
export { createDependencyTracker, depKey, SCAN_DEP } from "@lunora/shard-engine";
export { ConflictError } from "@lunora/shard-engine";
