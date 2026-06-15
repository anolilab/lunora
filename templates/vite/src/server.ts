import type { ExecutionContextLike, ShardNamespaceLike } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";

import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import { createShardDO } from "../lunora/_generated/shard.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`; the
 * class is bound as `SHARD` in `wrangler.jsonc`. Pass `scheduler` / `storage` /
 * `d1` thunks here once you add `@lunora/scheduler`, `@lunora/storage`, or
 * `.global()` tables.
 */
export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Worker entry. Hands the generated function registry to `@lunora/runtime`,
 * which routes RPC + WebSocket traffic to the `SHARD` Durable Object. Grow this
 * by passing more options to `createWorker` (auth, storage listing, admin
 * introspectors, custom routes, …).
 */
export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        worker ??= createWorker({
            // Exposes /_lunora/admin/functions for the studio's function runner.
            functions: LUNORA_FUNCTIONS,
            // The generated OpenAPI document (regenerated on every `lunora/`
            // change) backs the studio's always-current API-reference tab.
            openApiSpec,
            // better-auth / OAuth callbacks etc. mount here; empty to start.
            routes: {},
            shardDO: env.SHARD,
        });

        return worker.fetch(request, env, context);
    },
};
