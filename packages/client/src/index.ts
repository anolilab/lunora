// The `api` / `internal` proxy the generated `_generated/api.ts` imports.
// Served from here as well as `@lunora/server` so a SIBLING package (a web
// app, another Worker) consuming `<backend>/api` needs only the client
// package at runtime, not the server runtime. One shared implementation, so
// the two cannot drift.
export { anyApi } from "../../../shared/any-api";
export type { OptimisticMessage, ReconcileDurableMessage } from "./agent-chat-reconcile";
export { maxSeq, reconcileOptimistic, RETIRE_AFTER_DURABLE_SEQ_ADVANCE } from "./agent-chat-reconcile";
export type { AsyncStorageLike, AsyncStoragePersistenceOptions } from "./async-storage-persistence";
export { createAsyncStoragePersistence } from "./async-storage-persistence";
export type { AsyncStorageQueryCacheOptions } from "./async-storage-query-cache";
export { createAsyncStorageQueryCache } from "./async-storage-query-cache";
export { default as createInMemoryBookmarkStorage } from "./bookmark";
export { createCallRunner } from "./call-runner";
export type { ClientQueryRef } from "./client-query-store";
export { createClientQuery } from "./client-query-store";
export { TabCoordinator } from "./cross-tab";
export type { MutationDelta } from "./delta-merge";
export { applyDelta, isMutationDelta } from "./delta-merge";
export type { LunoraErrorCode } from "./errors";
export {
    CONFLICT_ERROR_CODE,
    getErrorCode,
    getRetryAfterMs,
    isConflictError,
    isForbiddenError,
    isRateLimitedError,
    isUnauthorizedError,
    TransportError,
} from "./errors";
export type { HttpStreamOptions } from "./http-stream";
export { httpStream } from "./http-stream";
export type { OptimisticLocalStore, OptimisticUpdate } from "./local-store";
export { createLocalStore } from "./local-store";
export type {
    ActionCallOptions,
    BatchSlot,
    ClientDebugShard,
    ClientDebugSnapshot,
    ClientDebugSubscription,
    ConnectionStatus,
    LunoraClientError,
    MutationCallOptions,
    MutationSettledEvent,
    SyncWatermark,
} from "./lunora-client";
export { LunoraClient } from "./lunora-client";
export type { MutatorHandle, MutatorRunnerSinks, MutatorTransaction } from "./mutator-runner";
export { createMutatorRunner } from "./mutator-runner";
export type { QueuedMutation } from "./offline-queue";
export { OfflineQueue } from "./offline-queue";
export type { IndexedDbPersistenceOptions } from "./persistence";
export { createIndexedDbPersistence, createInMemoryPersistence } from "./persistence";
export { preloadedQueryResult, preloadQuery } from "./preload";
export type { IndexedDbQueryCacheOptions } from "./query-cache";
export { createIndexedDbQueryCache, createInMemoryQueryCache, queryCacheKey } from "./query-cache";
export type { ReconnectCalculator } from "./reconnect";
export { createReconnect } from "./reconnect";
export { default as createSnapshotPrecondition } from "./snapshot-precondition";
export type { StreamHandle, StreamIterable } from "./stream";
export { createStream, DEFAULT_MAX_BUFFER } from "./stream";
export type { SubscriptionCallback, SubscriptionError, SubscriptionErrorCallback, SubscriptionState } from "./subscription";
export { SubscriptionRegistry } from "./subscription";
export type { ClientSwOptions, ServiceWorkerStatus } from "./sw/client-sw";
export { ClientServiceWorker } from "./sw/client-sw";
export type { ClientToSwMessage, SwToClientMessage } from "./sw/message-bridge";
export { createReply, sendToSw } from "./sw/message-bridge";
export type {
    ArgsOf,
    AuthCapabilities,
    AuthConfigInfo,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthUser,
    AuthUserFieldSpec,
    BookmarkStorage,
    CachedQuery,
    ClientMessage,
    ClientShapeSubscribeMessage,
    ClientShapeUnsubscribeMessage,
    CronJobInfo,
    FunctionArgumentDescriptor,
    FunctionDescriptor,
    FunctionReference,
    GlobalFacetResult,
    GlobalFacetValue,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    HttpStreamArgsOf,
    HttpStreamCallArgs,
    HttpStreamChunkOf,
    HttpStreamRef,
    KvKeyEntry,
    KvKeyListResult,
    KvNamespaceSummary,
    KvValueResult,
    LunoraClientOptions,
    OfflineQueueOptions,
    OutboxMutation,
    OutboxSink,
    PersistedMutation,
    PersistenceAdapter,
    PipelineLogColumnMap,
    PipelineLogCursor,
    PipelineLogField,
    PipelineLogPage,
    PipelineLogQuery,
    PipelineLogRow,
    Preloaded,
    QueryCacheAdapter,
    ReconnectOptions,
    ReturnOf,
    RowOp,
    RpcEnvelope,
    RpcResponseBody,
    ScheduleRecord,
    ScheduleRetryPolicy,
    SchedulerPoolStatus,
    SchedulerStatus,
    ServerMessage,
    ServerPokeEndMessage,
    ServerPokePartMessage,
    ServerPokeStartMessage,
    ShardTrafficEntry,
    ShardTrafficResult,
    StorageListPage,
    StorageObject,
    StoredQuery,
    Unsubscribe,
    User,
    VectorIndexSummary,
    VectorQueryMatch,
    WorkflowInstanceAction,
    WorkflowInstanceDetail,
    WorkflowInstancePage,
    WorkflowInstanceStatus,
    WorkflowInstanceSummary,
    WorkflowStepDetail,
    WsTokenProvider,
} from "./types";
