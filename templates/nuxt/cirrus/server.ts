import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";

import { CIRRUS_FUNCTIONS } from "./_generated/functions.js";
import { openApiSpec } from "./_generated/openapi.js";
import { createShardDO } from "./_generated/shard.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`;
 * the class is bound as `SHARD` in `wrangler.cirrus.jsonc`. Pass `scheduler` /
 * `storage` / `d1` thunks here once you add `@cirrus/scheduler`,
 * `@cirrus/storage`, or `.global()` tables.
 */
export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Standalone Cirrus worker for the two-worker Nuxt split.
 *
 * This worker owns `/_cirrus/*` (RPC + WebSocket realtime) and the `ShardDO`
 * class. The Nuxt/Nitro SSR worker is a separate deployment (`wrangler.jsonc`);
 * the browser client connects its WebSocket here via `runtimeConfig.public.cirrusUrl`
 * (set NUXT_PUBLIC_CIRRUS_URL to this worker's URL in production).
 *
 * Why two workers? Nitro does not expose its emitted fetch handler as an
 * importable virtual module, so composing `/_cirrus/*` into the Nitro output is
 * not achievable through any documented mechanism. See `nuxt.config.ts` and the
 * README for the full rationale.
 */
export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        worker ??= createWorker({
            // Exposes /_cirrus/admin/functions for the studio's function runner.
            functions: CIRRUS_FUNCTIONS,
            // The generated OpenAPI document (regenerated on every `cirrus/`
            // change) backs the studio's always-current API-reference tab.
            openApiSpec,
            // better-auth / OAuth callbacks etc. mount here; empty to start.
            routes: {},
            shardDO: env.SHARD,
        });

        return worker.fetch(request, env, context);
    },
};
