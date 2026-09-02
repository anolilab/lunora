/**
 * `@lunora/shard-engine` — host-neutral reactive engine for Lunora.
 *
 * The engine consumes the provider-neutral contracts from `@lunora/platform`
 * (`ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`) and implements
 * per-shard state, OCC, CDC, reactive subscriptions, and the poke protocol.
 */

// Relocated from `@lunora/do`: host-neutral admin/ops, external-source ingest and
// dev catchers — they touch only SQL and the schema, never a Durable Object.
// Exactly the names `@lunora/do` published, so its frozen surface is unchanged.
export type {
    ExportRow,
    ExportShardAdminArgs,
    ExportShardArgs,
    ImportError,
    ImportShardAdminArgs,
    ImportShardArgs,
    ImportShardResult,
} from "./admin-export-import";
export { exportShardRows, importShardRows, parseExportShardArgs, parseImportShardArgs, selectExportTables, validateImportRow } from "./admin-export-import";
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
export type {
    CdcChange,
    CdcChangeKey,
    Clock,
    CountArgs,
    CtxDbOptions,
    IdGenerator,
    SearchBackfillProgress,
    SqlCursor,
    SqlExec,
    WriteEvent,
    WriteHook,
} from "./ctx-db";
export {
    applyCdcChanges,
    assertNoExplicitUndefined,
    assertValidClientId,
    backfillAggregateIndexes,
    backfillRankIndexes,
    backfillSearchIndexes,
    CDC_LOG_TABLE,
    cdcCanVouchFor,
    cdcSeqLeavingRows,
    cdcTouchesTables,
    cdcTrimmedError,
    compactCdcDocs,
    createShardCtxDb,
    cursorBelowRetainedFloor,
    minCdcReplayableSeq,
    normalizeIdStructurally,
    NotUniqueError,
    readCdcChangeKeys,
    readCdcChanges,
    runShardMigrations,
    trimCdcChanges,
} from "./ctx-db";
export { backfillSearchIndexesForTable } from "./ctx-db-backfill";
export {
    appendCdcChange,
    bumpCdcEpoch,
    CDC_LOG_TABLE_SEQ_INDEX,
    CDC_META_TABLE,
    migrateCdcLog,
    migrateCdcMeta,
    minCdcSeq,
    readCdcCursor,
    readCdcEpoch,
} from "./ctx-db-cdc";
export type { CdcArchiveScope } from "./ctx-db-cdc-archive";
export { archiveCdcSegment, readArchivedCdcChanges, readCdcArchivedThrough, writeCdcArchivedThrough } from "./ctx-db-cdc-archive";
export { advanceClientWatermark, CLIENT_WATERMARK_TABLE, migrateClientWatermark, readClientWatermark } from "./ctx-db-client-watermark";
export { allocateCommitSeq, COMMIT_SEQ_FIELD, COMMIT_SEQ_TABLE, migrateCommitSeq, readCommitSeq } from "./ctx-db-commit-seq";
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
export { clearMemoryTables, isMemoryTable, memoryTableNames } from "./ctx-db-memory";
export type { RankPageComputation, RankPageDeps } from "./ctx-db-rank-page";
export { computeRankPage, resolveRankSeekTuple } from "./ctx-db-rank-page";
export { migrateSearchState, readSearchBackfillState, SEARCH_STATE_TABLE, writeSearchBackfillState } from "./ctx-db-search-state";
export type { ShapePokeCursorRow } from "./ctx-db-shape-poke-cursor";
export {
    deleteShapePokeCursor,
    deleteShapePokeCursorsForConnection,
    migrateShapePokeCursor,
    minShapePokeCursor,
    readShapePokeCursor,
    SHAPE_POKE_CURSOR_TABLE,
    writeShapePokeCursor,
    writeShapePokeCursors,
} from "./ctx-db-shape-poke-cursor";
export type { ShapeRow } from "./ctx-db-shapes";
export { selectShapeMembers, selectShapeRows } from "./ctx-db-shapes";
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
export { param, renderSql, sqliteInList, unionAll } from "./drizzle";
export type { DurableStreamRun } from "./durable-stream";
export {
    appendStreamChunk,
    claimStreamRun,
    deleteStreamRun,
    finishStreamRun,
    migrateDurableStreams,
    readStreamChunks,
    readStreamRun,
    trimStreamRuns,
} from "./durable-stream";
export type { DurableAttachDecision, DurableStreamAttach, DurableStreamSink } from "./durable-stream-runner";
export { decideDurableAttach, DurableStreamRunner, MAX_DURABLE_STREAM_BYTES, MAX_DURABLE_STREAM_CHUNKS } from "./durable-stream-runner";
export { envOptionalPositiveInt, envPositiveInt } from "./env-int";
export type { ExternalSourceDiffResult } from "./external-source-diff";
export { diffExternalSource } from "./external-source-diff";
export { liftSourceId, normalizeSourceDocument, normalizeSourceValue } from "./external-source-lift";
export type { IncrementalMaterializeResult, MaterializeResult } from "./external-source-materialize";
export { materializeExternalRows, materializeExternalRowsIncremental, readExternalSourceBaseline, runExternalSourceTick } from "./external-source-materialize";
export type { ExternalSourceLike, SourceClientLike, SourceCursorLike, SourceRefresh } from "./external-source-pull";
export { isSoftDeleted, isSourceDue, pullExternalSourceIncrementalTick, pullExternalSourceTick } from "./external-source-pull";
export type { GeoBoundingBox, GeoPoint } from "./geo";
export { boundingBoxCenter, boundingBoxGeohashes, coveringGeohashes, encodeGeohash, GEO_DEFAULT_PRECISION, haversineMeters, pointInBoundingBox } from "./geo";
export { default as GlobalPollTick } from "./global-poll-tick";
export type {
    AdvisoriesResult,
    AdvisorProcedure,
    AdvisorProceduresResult,
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
    ReactorMetadata,
    ReactorsResult,
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
    TablesIndexesResult,
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
    GlobalPollCounters,
    OrderByClause,
    ShapeProbeCounters,
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
    createGlobalPollCounters,
    createShapeProbeCounters,
    DEFAULT_FANOUT_TOPIC_LIMIT,
    findStorageReferences,
    MAX_PAGE_SIZE,
    recordFanoutPass,
    recordGlobalPollPass,
    recordShapeProbePass,
    summarizeFanoutTopics,
    summarizeSubscriptions,
} from "./introspect";
export type { CapturedMailRow, RecordMailInput } from "./mail-catcher";
export { clearCapturedMail, ensureMailTable, MAIL_RETENTION, MAIL_TABLE, readCapturedMail, recordCapturedMail } from "./mail-catcher";
export { NotFoundError } from "./not-found-error";
export type { PitrBookmarkResult, PitrRestoreArgs, PitrRestoreResult, PitrStorage } from "./pitr";
export { armRestore, readBookmark } from "./pitr";
export {
    applySelect,
    buildSeekBeforeWhere,
    buildSeekWhere,
    CURSOR_PREFIX,
    decodeCursor,
    encodeCursor,
    normalizeOrderKeys,
    softDeleteScope,
    tiebreakDirectionFor,
} from "./query-args";
// Consumed by `@lunora/do` internals rather than by end users: these were
// module-private inside `@lunora/do` before the relocation, and are published
// here only because the import now crosses a package boundary. They are not
// part of `@lunora/do`'s frozen surface and it does not re-export them.
export type { QueueMessageOutcome, QueueMessageRow, RecordQueueMessageInput } from "./queue-catcher";
export { clearQueueMessages, isLossyBody, QUEUE_TABLE, readQueueMessageById, readQueueMessages, recordQueueMessages } from "./queue-catcher";
export { encodePartitionKey, matchesRankStaticWhere, RANK_TIEBREAK, rankKeyFromDoc, rankTableName, resolveRankPartition, sortColumnName } from "./rank";
export type { CacheEntry, ReactiveCacheOptions } from "./reactive-cache";
export { ReactiveCache, reactiveCacheKey, stableStringify, stableWireKey } from "./reactive-cache";
export type { ReactorDispatchResult, ReactorState, ReactorStats } from "./reactor-state";
export { listReactorStates, migrateReactorState, REACTOR_STATE_TABLE, reactorNeedsRun, readReactorState, writeReactorState } from "./reactor-state";
export type { ReadFootprint } from "./read-footprint";
export { createReadFootprint, markUnvouchableReads, UNVOUCHABLE_DEP } from "./read-footprint";
export type { IndexKeyEntry, KeyRange } from "./read-write-set";
export { buildIndexRange, indexKeysForRow, keysTouchRanges } from "./read-write-set";
export type { RelationExistsMarker, ResolveRelationPredicatesOptions } from "./relation-predicates";
export {
    assertFlatPredicate,
    assertShapeShardable,
    containsRelationPredicate,
    DEFAULT_MAX_RELATION_KEYS,
    isRelationPredicate,
    resolveRelationPredicates,
} from "./relation-predicates";
export { applyOnDelete, distinctValues, fanOutScalarCounts, relationHooks, resolveWith, runRowValidators } from "./relations";
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
    RelayShapeUnsubscribe,
} from "./relay";
export { clampPromotionThresholds, DEFAULT_PROMOTION_THRESHOLDS, nextPromotionState, relayCountFor, shapeRoutingKey } from "./relay";
export type { RelayHost } from "./relay-hub";
export { createRelayLink, DEFAULT_MAX_RELAYS, OwnerRelay, RelayMember } from "./relay-hub";
export type { ReplicaFollowerHost, ReplicaOwnerHost, ReplicaReadiness, ShardSiblingHost } from "./replica";
export { createReplicaLink, gateReplicaDispatch, handleReplicaControl } from "./replica";
export {
    buildReprojectionMigration,
    countLegacyRows,
    reprojectableFields,
    REPROJECTION_MIGRATION_PREFIX,
    reprojectionMigrationId,
    reprojectionTables,
} from "./reprojection-backfill";
export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "./rls-guard";
export { readSchemaHistory, readSchemaVersion, recordSchemaVersion, SCHEMA_HISTORY_MAX_VERSIONS } from "./schema-history";
export type {
    AggregateIndexDefinitionLike,
    AggregateOp,
    AggregateOptions,
    AggregateResult,
    ApplyOnDeleteOptions,
    BroadcastDelta,
    ColumnMetaLike,
    CrossShardReadArgs,
    DatabaseWriterLike,
    FanOutBudget,
    GeoFilterBuilderLike,
    GeoIndexDefinitionLike,
    GeoScoredDocument,
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
    ScoredDocument,
    SearchFilterBuilderLike,
    SearchIndexDefinitionLike,
    SearchScoredDocument,
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
export { buildSettings, isDevEnvironment } from "./settings";
export { buildShapeDiff } from "./shape-diff";
export { createShapeDiffCache, globalShapeReadKey, ShapeDiffCache } from "./shape-diff-cache";
export type { PokeFrameMeta, ShapePokePart, ShapeRowOp } from "./shape-global-diff";
export { buildPokeFrames, diffGlobalMembership, encodeRowsPatch, projectColumns } from "./shape-global-diff";
export type { ShardRunnerOptions } from "./shard-runner";
export { ShardRunner } from "./shard-runner";
export { runSocketPool } from "./socket-pool";
export type { SqlConsoleResult } from "./sql-console";
export type { SqlLintResult } from "./sql-console";
export { assertReadonly, MAX_SQL_ROWS, runReadonlySql } from "./sql-console";
export { lintReadonlySql } from "./sql-console";
// The canonical order-preserving bigint key. `@lunora/sql-store` builds the
// same key for the `.global()` plane and the two are compared by a parity
// test, so there must be exactly one encoder.
export { BIGINT_KEY_DIGITS, BIGINT_KEY_NEGATIVE, BIGINT_KEY_NON_NEGATIVE, bigintSqlKey } from "./sql-projection";
export { awaitWsDrain, subscriptionFrames, subscriptionListDeltas, trySendFrame } from "./subscription-delivery";
export type { ChangedKeys, SubscriptionReadFootprint } from "./subscription-range-gate";
export { mergeChangedKeys, recordChangedKeys, writeTouchesMemo } from "./subscription-range-gate";
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
export type { TransactionHeadroom, TransactionLimits } from "./transaction-headroom";
export { DEFAULT_TRANSACTION_LIMITS, TransactionHeadroomTracker } from "./transaction-headroom";
export type { RunTriggersOptions } from "./triggers";
export { hasTrigger, runTriggers } from "./triggers";
export type { TtlSweepSpec } from "./ttl-sweep";
export { selectExpiredIds } from "./ttl-sweep";
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
export { compileWhereSql, literalInList } from "./where-sql";
export type { FieldOperators, WhereInput } from "./where-types";
export { RELATION_EXISTS_KEY } from "./where-types";
