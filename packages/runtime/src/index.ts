export type {
    AdminTableResolver,
    AuthIntrospector,
    AuthPage,
    AuthSession,
    AuthUser,
    BackupManifest,
    BackupStore,
    CronHandler,
    ExecutionContextLike,
    FunctionDescriptor,
    FunctionRegistryEntry,
    FunctionRegistryLike,
    GlobalExportFn,
    GlobalImportFn,
    GlobalIntrospector,
    GlobalTableInfo as GlobalTableInfoMeta,
    GlobalTablePage as GlobalTablePageMeta,
    HttpActionContext,
    HttpActionLike,
    HttpRouterLike,
    Route,
    RpcContext,
    RpcEnvelope,
    ScheduledControllerLike,
    ShardingInfo,
    StorageListFn,
    StorageObject,
    WorkerOptions,
} from "./create-worker.js";
export { createWorker, defineRpcEnvelope } from "./create-worker.js";
export type { DynamicShardRegistry, DynamicShardRegistryOptions } from "./dynamic-shard-registry.js";
export { createDynamicShardRegistry, DEFAULT_REGISTRY_CACHE_TTL_MS, SHARD_REGISTRY_DO_NAME } from "./dynamic-shard-registry.js";
export type { CirrusErrorBody } from "./errors.js";
export { CirrusError, toErrorResponse } from "./errors.js";
/* eslint-disable perfectionist/sort-exports -- conflicts with simple-import-sort/exports on the observability/observability-sinks ordering; simple-import-sort's autofix wins, so we follow it and disable perfectionist for these lines */
export type { ObservabilityEvent, ObservabilitySink } from "./observability.js";
export { emitRpcEvent } from "./observability.js";
export type { SentrySinkOptions, WebhookSinkOptions } from "./observability-sinks.js";
export { combineSinks, consoleSink, sentrySink, webhookSink } from "./observability-sinks.js";
/* eslint-enable perfectionist/sort-exports */
export type {
    ExportFanOutRequest,
    ExportFanOutResult,
    FanOutRequest,
    FanOutResult,
    FanOutSpec,
    ImportFanOutRequest,
    ImportFanOutResult,
    MergeStrategy,
    MigrationFanOutRequest,
    MigrationFanOutResult,
    QueryCoordinator,
    QueryCoordinatorOptions,
    ShardError,
    ShardExportOutcome,
    ShardImportOutcome,
    ShardMigrationOutcome,
    ShardRegistry,
} from "./query-coordinator.js";
export { createQueryCoordinator, createStaticShardRegistry, mergeStrategyForAggregate } from "./query-coordinator.js";
export type { ResolvedShard, ShardNamespaceLike } from "./resolve-shard.js";
export { resolveShard } from "./resolve-shard.js";

export const VERSION: string = "0.0.0";
