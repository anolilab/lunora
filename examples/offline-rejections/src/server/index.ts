import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Minimal Worker entry — pure root-scoped storage, no D1/R2/auth. All the demo
 * needs is the `messages` table and the `send` mutation that deterministically
 * rejects some inputs.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            worker = createWorker({ openApiSpec, shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
