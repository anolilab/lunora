import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { createWorker } from "lunorash/runtime";

import { openApiSpec } from "../../lunora/_generated/openapi.js";
import { createShardDO } from "../../lunora/_generated/shard.js";

// The two Workflow classes must be exported from the entry, or wrangler provisions no binding for them.
export * from "../../lunora/_generated/workflows.js";

// The erasure tombstones' own Durable Object (`PRIVACY_TOMBSTONES`), outside the shard.
export { PrivacyTombstonesDO } from "./privacy-tombstones-do";

export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | undefined;

/**
 * Minimal Worker entry. The privacy package's request tables live in the shard, and its
 * durable workflows run from the generated Workflow classes. Only the tombstones have
 * their own binding, so a restore of the shard cannot roll them back.
 */
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
        worker ??= createWorker({ openApiSpec, shardDO: env.SHARD });

        return worker.fetch(request, env, ctx);
    },
};
