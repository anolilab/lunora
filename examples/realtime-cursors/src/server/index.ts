import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

export { ShardDO } from "./ShardDO.js";

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        if (!worker) {
            worker = createWorker({ shardDO: env.SHARD });
        }

        return worker.fetch(request, env, ctx);
    },
};
