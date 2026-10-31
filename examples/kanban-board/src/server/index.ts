import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

// Records revoked named admin tokens where a restore of the shard cannot rewind them.
export { AdminRevocationDO } from "../../lunora/_generated/adminRevocations.js";

export const ShardDO = createShardDO();

interface Env {
    ADMIN_REVOCATIONS: ShardNamespaceLike;
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | undefined;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        // `openApiSpec` (regenerated on every `lunora/` change) backs the
        // studio's always-current API-reference tab.
        worker ??= createWorker({ openApiSpec, adminRevocations: env.ADMIN_REVOCATIONS, shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
