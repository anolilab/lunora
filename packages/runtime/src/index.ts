export type {
    AdminTableResolver,
    AuthIntrospector,
    AuthPage,
    AuthSession,
    AuthUser,
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
export type { ObservabilityEvent, ObservabilitySink } from "./observability.js";
export { emitRpcEvent } from "./observability.js";
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
