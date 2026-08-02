// `external-source-cursor` is an internal ingest detail (the durable watermark
// codec + reserved-table helpers), consumed only by `external-source-pull` and its
// own tests — not re-exported, mirroring `external-source-diff`'s module-private
// `projectExternalSourceRow`.
export { serveRelationFanout } from "./relation-fanout";
// The search core moved out of this package. It used to be re-exported from
// here so `@lunora/sql-store` could reuse it, which turned two dozen internal
// contracts into permanent public API for no reason other than cross-package
// reach. `guardWriter` left for the same reason and now lives in
// `@lunora/shard-engine`, which re-exports it.
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
// Cloudflare implementations of the `@lunora/platform` host contracts. These
// are what `@lunora/platform-cloudflare` will re-export as the default host.
export { createShardAlarms, createShardDirectory, createShardHost, createShardKvStore, createSocketHost } from "@lunora/platform-cloudflare";
// The Cloudflare composition root: every `@lunora/platform` contract assembled
// from the two lifetimes a Worker has (DO state, worker env).
export type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
export { createShardPlatform, createWorkerPlatform } from "@lunora/platform-cloudflare";

// Every re-export below must have a named consumer (the codegen emitter's
// import builders, or an import site in this repo). Additions require one;
// drive-by re-exports are how 230 unused names got frozen here (plan 286).
//
// KEPT — the re-derived demand set (43 grep'd import sites + 9 emitter
// conditionals, see plan 286 §9.1). Undecorated: these have a real consumer.
export type { ExportRow, ImportShardResult } from "@lunora/shard-engine";
export type { DataMigrationLike, MigrationRunResult } from "@lunora/shard-engine";
export type { KeyRange } from "@lunora/shard-engine";
export type { TransactionHeadroomTracker } from "@lunora/shard-engine";
export type { DatabaseWriterLike, SchemaLike, SqlExec, ValidatorLike, WriteHook } from "@lunora/shard-engine";
export type {
    AdvisorProcedure,
    AdvisoryFinding,
    FlagsResult,
    MaskPoliciesResult,
    QueuesResult,
    RlsPoliciesResult,
    StorageRulesResult,
    StudioFeaturesResult,
    WorkflowsResult,
} from "@lunora/shard-engine";
export type { SystemReaderStorageLike } from "@lunora/shard-engine";
export type { SchedulerLike } from "@lunora/shard-engine";
export type { AggregateIndexDefinitionLike } from "@lunora/shard-engine";
export type { RankIndexDefinitionLike, ShardRankPageResult } from "@lunora/shard-engine";
export type { MutationDelta } from "@lunora/shard-engine";
export { createReadFootprint } from "@lunora/shard-engine";
export { exportShardRows, importShardRows } from "@lunora/shard-engine";
export { runDataMigration } from "@lunora/shard-engine";
export { isSourceDue, pullExternalSourceIncrementalTick, pullExternalSourceTick } from "@lunora/shard-engine";
export { applyCdcChanges, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
export { assertShapeShardable } from "@lunora/shard-engine";

// DEPRECATED — no consumer found in this repo (codegen emitter or any
// packages/apps/examples/templates/registry import site). Each statement is
// annotated so editors/tsc surface the migration hint; removed after one
// alpha release cycle of @lunora/do carrying these deprecations (plan 286 W4).
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { ExportShardAdminArgs, ExportShardArgs, ImportError, ImportShardAdminArgs, ImportShardArgs } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type {
    DataMigrationDocument,
    DataMigrationTransform,
    MigrationDirection,
    MigrationStatus,
    MigrationStatusRow,
    RunDataMigrationOptions,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { IndexKeyEntry } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { ExternalSourceDiffResult } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { IncrementalMaterializeResult, MaterializeResult } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { ExternalSourceLike, SourceClientLike, SourceCursorLike, SourceRefresh } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { CapturedMailRow, RecordMailInput } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { PitrBookmarkResult, PitrRestoreArgs, PitrRestoreResult, PitrStorage } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { SqlConsoleResult } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { TtlSweepSpec } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { AuditEntry } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type {
    BroadcastDelta,
    CdcChange,
    Clock,
    ColumnMetaLike,
    CountArgs,
    CtxDbOptions,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    IdGenerator,
    IndexDefinitionLike,
    IndexRangeBuilderLike,
    PaginationOptions,
    ReadHook,
    SearchFilterBuilderLike,
    SearchIndexDefinitionLike,
    ServerDefaultContextLike,
    SqlCursor,
    TableDefinitionLike,
    TableReaderLike,
    WriteEvent,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type {
    AdvisoriesResult,
    AdvisorProceduresResult,
    AuditLogResult,
    ColumnMeta,
    DeployInfo,
    FacetColumnOptions,
    FacetColumnResult,
    FacetValue,
    FlagEvaluation,
    FunctionCallStat,
    FunctionStatsResult,
    MaskColumnMetadata,
    QueueMetadata,
    ReadTablePageOptions,
    RlsPolicyMetadata,
    RlsRoleMetadata,
    SelectMatchingIdsOptions,
    SettingEntry,
    SettingKind,
    SettingsResult,
    StorageRuleMetadata,
    TableColumnsResult,
    TableIndexesResult,
    TableIndexInfo,
    TableInfo,
    TablePage,
    TablesColumnsResult,
    WorkflowMetadata,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type {
    ScheduledFunctionDoc,
    SystemDatabaseReader,
    SystemDoc,
    SystemQuery,
    SystemReaderOptions,
    SystemReaderSchedulerLike,
    SystemTableName,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type {
    RunTriggersOptions,
    SchedulableWorkflowReferenceLike,
    TriggerContextLike,
    TriggerDefinitionLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { AggregateTally } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { AggregateOp, AggregateOptions, AggregateResult, GroupByEntry, GroupByOptions, RestrictableQueryOptions } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { OrderByInput, OrderKey, QueryArgs, QueryPage, SortDirection } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { RankDirection, RankOptions, RankPage, RankPageOptions, RankPageRow, RankPageRowKey, RankResult, RankSortKeyLike } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { ResolveRelationPredicatesOptions } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { ApplyOnDeleteOptions, NestedWith, OnDeleteActionLike, RelationDefinitionLike, ResolveWithOptions, WithInput } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { WhereSqlStrategy } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { RenderedSql, SqlEngine } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { RpcRequest, ShapeSubscriptionQuery, SocketAttachment, SubscriptionEnvelope, SubscriptionQuery } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { GeoBoundingBox, GeoPoint } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { CacheEntry, ReactiveCacheOptions } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { FieldOperators, WhereInput } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { DependencyTracker } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export type { TransactionSqlLike } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { exportShardTable, parseExportShardArgs, parseImportShardArgs, selectExportTables, validateImportRow } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { DATA_MIGRATION_STATE_TABLE, readMigrationStatus } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { diffExternalSource } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { materializeExternalRows, materializeExternalRowsIncremental, readExternalSourceBaseline, runExternalSourceTick } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { isSoftDeleted, liftSourceId } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { clearCapturedMail, ensureMailTable, MAIL_RETENTION, MAIL_TABLE, readCapturedMail, recordCapturedMail } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { armRestore, readBookmark } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { assertReadonly, MAX_SQL_ROWS, runReadonlySql } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { selectExpiredIds } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export {
    assertValidClientId,
    backfillAggregateIndexes,
    backfillRankIndexes,
    backfillSearchIndexes,
    CDC_LOG_TABLE,
    normalizeIdStructurally,
    NotUniqueError,
    readCdcChanges,
    trimCdcChanges,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export {
    ADMIN_FUNCTION_PREFIX,
    ADMIN_FUNCTIONS,
    facetColumn,
    FLAGS_FUNCTION_PREFIX,
    listTables,
    readTablePage,
    RELATION_FUNCTION_PREFIX,
    selectMatchingIds,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { createSystemReader } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { hasTrigger, runTriggers } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { AGGREGATE_SQL_FUNCTION, aggregateSqlFunction, matchesStaticWhere, normalizeCountArgument, throwingScheduler } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally, readAggregateValue } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export {
    CountRlsUnsupportedError,
    mergeWhere,
    planAggregateLookup,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { applySelect, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, softDeleteScope } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankTableName, resolveRankPartition, sortColumnName } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export {
    assertFlatPredicate,
    containsRelationPredicate,
    DEFAULT_MAX_RELATION_KEYS,
    isRelationPredicate,
    resolveRelationPredicates,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { applyOnDelete, fanOutScalarCounts, resolveWith, runRowValidators } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { compileWhereSql } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { renderSql } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export {
    boundingBoxCenter,
    boundingBoxGeohashes,
    coveringGeohashes,
    encodeGeohash,
    GEO_DEFAULT_PRECISION,
    haversineMeters,
    pointInBoundingBox,
} from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { NotFoundError } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { ReactiveCache, reactiveCacheKey, stableStringify, stableWireKey } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { createDependencyTracker, depKey, SCAN_DEP } from "@lunora/shard-engine";
/** @deprecated Import from `@lunora/shard-engine` instead — this re-export is removed after one alpha cycle (plan 286). */
export { ConflictError } from "@lunora/shard-engine";

// Observability is NOT re-exported from here. It lives in `@lunora/observability`
// and consumers import it from there directly.
//
// Re-exporting it would put this package back in the middle of a dependency it
// does not own: every symbol that package adds would silently widen this one's
// frozen surface, and a second host would reach telemetry *through* the
// Cloudflare package — the exact coupling the extraction removed.
// Relocated to `@lunora/shard-engine` (host-neutral: these touch only SQL and
// the schema, never a Durable Object). Re-exported here because `@lunora/do`'s
// export surface is frozen by plan 114 §5.2 — codegen emits against it.
