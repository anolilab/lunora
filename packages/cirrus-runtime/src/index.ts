export type { ExecutionContextLike, Route, RpcContext, RpcEnvelope, WorkerOptions } from "./createWorker.js";
export { createWorker, defineRpcEnvelope } from "./createWorker.js";
export type { CirrusErrorBody } from "./errors.js";
export { CirrusError, toErrorResponse } from "./errors.js";
export type { QueryCoordinatorOptions } from "./queryCoordinator.js";
export { createQueryCoordinator } from "./queryCoordinator.js";
export type { ResolvedShard, ShardNamespaceLike } from "./resolveShard.js";
export { resolveShard } from "./resolveShard.js";

export const VERSION: string = "0.0.0";
