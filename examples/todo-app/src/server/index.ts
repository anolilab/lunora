import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { ShardDO } from "./shard-do.js";

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
            worker = createWorker({ shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
