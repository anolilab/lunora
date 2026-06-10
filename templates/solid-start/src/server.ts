import type { ExecutionContextLike, ShardNamespaceLike } from "@cirrus/runtime";
import { createWorker } from "@cirrus/runtime";
// SolidStart's `cloudflare-module` preset emits a fetch handler for the SSR app.
// We treat it as a framework-neutral `HttpRouterLike` and compose it into the
// Cirrus worker — class-A integration (PLAN4 §3): we own the worker entry.
// @ts-expect-error -- virtual module provided by the SolidStart Cloudflare preset at build time.
import solidStartHandler from "@solidjs/start/server-handler";

import { CIRRUS_FUNCTIONS } from "../cirrus/_generated/functions.js";
import { openApiSpec } from "../cirrus/_generated/openapi.js";
import { createShardDO } from "../cirrus/_generated/shard.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`; the
 * class is bound as `SHARD` in `wrangler.jsonc`. Pass `scheduler` / `storage` /
 * `d1` thunks here once you add `@cirrus/scheduler`, `@cirrus/storage`, or
 * `.global()` tables.
 */
export const ShardDO = createShardDO();

interface Env {
    SHARD: ShardNamespaceLike;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * One Cloudflare Worker, two dispatch flows (PLAN4 §1):
 *
 * - `/_cirrus/rpc` + `/_cirrus/ws` + `/_cirrus/admin/*` → Cirrus realtime
 *   (queries, mutations, subscriptions, studio).
 * - everything else → the SolidStart SSR handler via `httpRouter`. A route
 *   loader that calls `preloadQuery` runs here, server-side, then the client
 *   hydrates it into a live subscription with `@cirrus/solid`'s
 *   `hydratePreloaded`.
 *
 * The two never collide: the runtime checks the reserved `/_cirrus/*` paths
 * first and only falls through to `httpRouter.fetch` for app routes.
 */
export default {
    async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
        worker ??= createWorker({
            // Exposes /_cirrus/admin/functions for the studio's function runner.
            functions: CIRRUS_FUNCTIONS,
            // The SolidStart SSR app — structurally an `HttpRouterLike`
            // (`{ fetch(request, env?, ctx?) }`), so it plugs straight in.
            httpRouter: solidStartHandler,
            // The generated OpenAPI document backs the studio's API-reference tab.
            openApiSpec,
            // better-auth / OAuth callbacks etc. mount here; empty to start.
            routes: {},
            shardDO: env.SHARD,
        });

        return worker.fetch(request, env, context);
    },
};
