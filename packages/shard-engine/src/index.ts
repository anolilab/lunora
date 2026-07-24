/**
 * `@lunora/shard-engine` — host-neutral reactive engine for Lunora.
 *
 * The engine consumes the provider-neutral contracts from `@lunora/platform`
 * (`ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`) and implements
 * per-shard state, OCC, CDC, reactive subscriptions, and the poke protocol.
 */

export type { DependencyTracker } from "./dependency-tracker";
export { createDependencyTracker, depKey, SCAN_DEP, tableFromDepKey } from "./dependency-tracker";
export type { RenderedSql, SqlEngine } from "./drizzle";
export { param, renderSql } from "./drizzle";
export type { GeoBoundingBox, GeoPoint } from "./geo";
export type { RelationExistsMarker, ResolveRelationPredicatesOptions } from "./relation-predicates";
export { boundingBoxCenter, boundingBoxGeohashes, coveringGeohashes, encodeGeohash, GEO_DEFAULT_PRECISION, haversineMeters, pointInBoundingBox } from "./geo";
export { NotFoundError } from "./not-found-error";
export type { CacheEntry, ReactiveCacheOptions } from "./reactive-cache";
export { ReactiveCache, reactiveCacheKey, stableStringify, stableWireKey } from "./reactive-cache";
export { guardWriter, RLS_UNWRAP_SYMBOL, RlsRequiredError } from "./rls-guard";
export { buildFtsMatch, ftsTableName, scoreDocument, stringifySearchText, tokenizeSearch } from "./search-text";
export { serializeSqlValue } from "./serialize-sql";
export { runSocketPool } from "./socket-pool";
export {
    applySelect,
    buildSeekBeforeWhere,
    buildSeekWhere,
    decodeCursor,
    encodeCursor,
    normalizeOrderKeys,
    softDeleteScope,
} from "./query-args";
export {
    encodePartitionKey,
    matchesRankStaticWhere,
    RANK_TIEBREAK,
    rankKeyFromDoc,
    rankTableName,
    resolveRankPartition,
    sortColumnName,
} from "./rank";
export {
    CountRlsUnsupportedError,
    mergeWhere,
    planAggregateLookup,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
} from "./aggregates";
export {
    assertFlatPredicate,
    assertShapeShardable,
    containsRelationPredicate,
    DEFAULT_MAX_RELATION_KEYS,
    isRelationPredicate,
    resolveRelationPredicates,
} from "./relation-predicates";
export { applyOnDelete, distinctValues, fanOutScalarCounts, resolveWith, runRowValidators } from "./relations";
export { awaitWsDrain, sendDeltaFrames, subscriptionListDeltas, trySendFrame } from "./subscription-delivery";
export type { ConflictKind } from "./transaction";
export type { TransactionSqlLike } from "./transaction";
export { ConflictError } from "./transaction";
export type {
    LifecycleDispatchInfo,
    LifecycleEvent,
    MutationDelta,
    ResolvedShape,
    RpcRequest,
    ShapeSubscriptionQuery,
    SocketAttachment,
    SubscriptionEnvelope,
    SubscriptionIdentity,
    SubscriptionQuery,
} from "./types";
export type { WhereSqlStrategy } from "./where-sql";
export { compileWhereSql } from "./where-sql";
export type { FieldOperators, WhereInput } from "./where-types";
export { RELATION_EXISTS_KEY } from "./where-types";
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
    SchemaLike,
    SchedulerLike,
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
