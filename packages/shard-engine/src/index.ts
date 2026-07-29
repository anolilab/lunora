/**
 * `@lunora/shard-engine` — host-neutral reactive engine for Lunora.
 *
 * The engine consumes the provider-neutral contracts from `@lunora/platform`
 * (`ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`) and implements
 * per-shard state, OCC, CDC, reactive subscriptions, and the poke protocol.
 */

export { AGGREGATE_SQL_FUNCTION, aggregateSqlFunction, matchesStaticWhere, normalizeCountArgument, throwingScheduler } from "./aggregate-sql";
export type { AggregateTally } from "./aggregate-tally";
export { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally, readAggregateValue } from "./aggregate-tally";
export { CountRlsUnsupportedError, mergeWhere, planAggregateLookup, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy } from "./aggregates";
// Reactive engine core, moved from `@lunora/do` (plan 114 §5.2). The export
// list mirrors what that package's barrel published, so its re-exports keep
// the same public surface.
export type { AuditEntry } from "./audit-log";
export type { AppendAuditEntry } from "./audit-log";
export { appendAuditEntry, AUDIT_LOG_TABLE, ensureAuditTable, readAuditLog } from "./audit-log";
export type { CdcChange, Clock, CountArgs, CtxDbOptions, IdGenerator, SqlCursor, SqlExec, WriteEvent, WriteHook } from "./ctx-db";
export {
    applyCdcChanges,
    assertValidClientId,
    backfillAggregateIndexes,
    backfillRankIndexes,
    backfillSearchIndexes,
    CDC_LOG_TABLE,
    createShardCtxDb,
    normalizeIdStructurally,
    NotUniqueError,
    readCdcChanges,
    runShardMigrations,
    trimCdcChanges,
} from "./ctx-db";
export { backfillSearchIndexesForTable } from "./ctx-db-backfill";
export { appendCdcChange, bumpCdcEpoch, CDC_META_TABLE, migrateCdcLog, migrateCdcMeta, minCdcSeq, readCdcCursor, readCdcEpoch } from "./ctx-db-cdc";
export { advanceClientWatermark, CLIENT_WATERMARK_TABLE, migrateClientWatermark, readClientWatermark } from "./ctx-db-client-watermark";
export type { CompanionSync, CompanionSyncDeps } from "./ctx-db-companions";
export { createCompanionSync } from "./ctx-db-companions";
export {
    deleteGlobalShapeSnapshot,
    deleteGlobalShapeSnapshotsForConnection,
    GLOBAL_SHAPE_SNAPSHOT_TABLE,
    migrateGlobalShapeSnapshot,
    readGlobalShapeSnapshot,
    writeGlobalShapeSnapshot,
} from "./ctx-db-global-shape-snapshot";
export type { IdempotentRecord } from "./ctx-db-idempotency";
export { IDEMPOTENCY_TABLE, migrateIdempotency, readIdempotent, trimIdempotent, writeIdempotent } from "./ctx-db-idempotency";
export type { RankPageComputation, RankPageDeps } from "./ctx-db-rank-page";
export { computeRankPage, hydrateDocsById } from "./ctx-db-rank-page";
export { migrateSearchState, readSearchBackfillState, SEARCH_STATE_TABLE, writeSearchBackfillState } from "./ctx-db-search-state";
export type { ShapeRow } from "./ctx-db-shapes";
export { selectShapeMemberIds, selectShapeRows } from "./ctx-db-shapes";
export type { DependencyTracker } from "./dependency-tracker";
export { createDependencyTracker, depKey, SCAN_DEP, tableFromDepKey } from "./dependency-tracker";
export { runDrizzle, runSql } from "./do-exec";
export {
    AGG_COUNT,
    AGG_KEY,
    AGG_VALUE,
    aggUpsertSql,
    createIndexSql,
    DOC_COLUMN,
    geoTableName,
    isFtsAvailable,
    jsonPath,
    jsonPathSql,
    qualifiedJsonPath,
    qualifiedJsonPathSql,
    quoteIdentifier,
    rowToDocument,
    tableColumns,
    tryRowToDocument,
} from "./do-sql";
export type { RenderedSql, SqlEngine } from "./drizzle";
export { param, renderSql } from "./drizzle";
export { liftSourceId, normalizeSourceDocument, normalizeSourceValue } from "./external-source-lift";
export type { GeoBoundingBox, GeoPoint } from "./geo";
export { boundingBoxCenter, boundingBoxGeohashes, coveringGeohashes, encodeGeohash, GEO_DEFAULT_PRECISION, haversineMeters, pointInBoundingBox } from "./geo";
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
export type {
    CreateWorkflowInstanceResult,
    FanoutMetricsResult,
    FanoutPathCounters,
    FanoutTopicStat,
    FilterClause,
    FilterOperator,
    FunctionScanAttribution,
    OrderByClause,
    StorageReference,
    StorageReferenceResult,
    SubscriptionConnection,
    SubscriptionInfo,
    SubscriptionsResult,
    WorkflowInstanceState,
    WorkflowInstanceStatusResult,
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
export {
    createFanoutCounters,
    DEFAULT_FANOUT_TOPIC_LIMIT,
    findStorageReferences,
    MAX_PAGE_SIZE,
    recordFanoutPass,
    summarizeFanoutTopics,
    summarizeSubscriptions,
} from "./introspect";
export { NotFoundError } from "./not-found-error";
export { applySelect, buildSeekBeforeWhere, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, softDeleteScope } from "./query-args";
export { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankKeyFromDoc, rankTableName, resolveRankPartition, sortColumnName } from "./rank";
export type { CacheEntry, ReactiveCacheOptions } from "./reactive-cache";
export { ReactiveCache, reactiveCacheKey, stableStringify, stableWireKey } from "./reactive-cache";
export type { RelationExistsMarker, ResolveRelationPredicatesOptions } from "./relation-predicates";
export {
    assertFlatPredicate,
    assertShapeShardable,
    containsRelationPredicate,
    DEFAULT_MAX_RELATION_KEYS,
    isRelationPredicate,
    resolveRelationPredicates,
} from "./relation-predicates";
export { applyOnDelete, distinctValues, fanOutScalarCounts, resolveWith, runRowValidators } from "./relations";
export type {
    OwnerRelayFrame,
    PromotionState,
    PromotionThresholds,
    RelayAttach,
    RelayDetach,
    RelayFrame,
    RelayShapePoke,
    RelayShapeSeed,
    RelayShapeSubscribe,
} from "./relay";
export { clampPromotionThresholds, DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, relayCountFor, shapeRoutingKey } from "./relay";
export type { RelayHost } from "./relay-hub";
export { createRelayLink, DEFAULT_MAX_RELAYS, OwnerRelay, RelayMember } from "./relay-hub";
export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "./rls-guard";
export type {
    AggregateIndexDefinitionLike,
    AggregateOp,
    AggregateOptions,
    AggregateResult,
    ApplyOnDeleteOptions,
    BroadcastDelta,
    ColumnMetaLike,
    DatabaseWriterLike,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    GroupByEntry,
    GroupByOptions,
    GuardableSchema,
    IndexDefinitionLike,
    IndexRangeBuilderLike,
    NestedWith,
    OnDeleteActionLike,
    OrderByInput,
    OrderKey,
    PaginationOptions,
    QueryArgs,
    QueryPage,
    RankBeforeOptions,
    RankBeforeResult,
    RankDirection,
    RankIndexDefinitionLike,
    RankOptions,
    RankPage,
    RankPageOptions,
    RankPageRow,
    RankPageRowKey,
    RankResult,
    RankSortKeyLike,
    ReadHook,
    RelationDefinitionLike,
    ResolveWithOptions,
    ResolveWithResult,
    RestrictableQueryOptions,
    SchedulableWorkflowReferenceLike,
    SchedulerLike,
    SchemaLike,
    SearchFilterBuilderLike,
    SearchIndexDefinitionLike,
    ServerDefaultContextLike,
    ShardRankPageResult,
    SortDirection,
    TableDefinitionLike,
    TableReaderLike,
    TriggerContextLike,
    TriggerDefinitionLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
    ValidatorLike,
    WithInput,
} from "./schema-types";
export { serializeSqlValue } from "./serialize-sql";
export type { PokeFrameMeta, ShapePokePart, ShapeRowOp } from "./shape-global-diff";
export { buildPokeFrames, diffGlobalMembership, encodeRowsPatch, projectColumns } from "./shape-global-diff";
export type { ShardRunnerOptions } from "./shard-runner";
export { ShardRunner } from "./shard-runner";
export { runSocketPool } from "./socket-pool";
export { awaitWsDrain, sendDeltaFrames, subscriptionListDeltas, trySendFrame } from "./subscription-delivery";
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
export type { StorageMetadata } from "./system-reader";
export { createSystemReader } from "./system-reader";
export type { ConflictKind } from "./transaction";
export type { TransactionSqlLike } from "./transaction";
export { ConflictError } from "./transaction";
export type { RunTriggersOptions } from "./triggers";
export { hasTrigger, runTriggers } from "./triggers";
export type {
    LifecycleDispatchInfo,
    LifecycleEvent,
    MutationDelta,
    ResolvedShape,
    RpcRequest,
    ShapeSubscriptionQuery,
    ShardSocketLike,
    SocketAttachment,
    SubscriptionEnvelope,
    SubscriptionIdentity,
    SubscriptionQuery,
} from "./types";
export type { WhereSqlStrategy } from "./where-sql";
export { compileWhereSql } from "./where-sql";
export type { FieldOperators, WhereInput } from "./where-types";
export { RELATION_EXISTS_KEY } from "./where-types";
export { SCHEMA_HISTORY_MAX_VERSIONS, readSchemaHistory, readSchemaVersion, recordSchemaVersion } from "./schema-history";
