import type { ExecutionContextLike, ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Minimal Worker entry: just hand the ShardDO binding to `createWorker`. No
 * D1, no R2, no auth — pure root-scoped storage is all this demo needs.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            // `openApiSpec` (regenerated on every `lunora/` change) backs the
            // studio's always-current API-reference tab.
            worker = createWorker({ openApiSpec, shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
