import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

// The two Workflow classes must be exported from the entry, or wrangler provisions no binding for them.
export * from "../../lunora/_generated/workflows.js";

export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | undefined;

/**
 * Minimal Worker entry. The privacy package needs no binding of its own: its tables
 * live in the shard, and its durable workflows run from the generated Workflow classes.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        worker ??= createWorker({ openApiSpec, shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
