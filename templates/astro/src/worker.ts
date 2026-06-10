import { withCirrus } from "@cirrus/astro";

import { createShardDO } from "../cirrus/_generated/shard.js";

// The worker `@astrojs/cloudflare` emits. Its default export is the SSR handler
// that renders your Astro pages/endpoints. (Astro generates this into
// `dist/_worker.js/index.js` at build time; the import path here is the
// conventional entry the Cirrus + Cloudflare build wires up.)
import astroWorker from "../dist/_worker.js/index.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`; the
 * class is bound as `SHARD` in `wrangler.jsonc`.
 */
export const ShardDO = createShardDO();

/**
 * The single Cloudflare Worker for this app — PLAN4 **class-B** composition.
 *
 * Astro owns its own Cloudflare adapter and builds its own server worker, so
 * Cirrus is *injected into* it rather than owning the entry. `withCirrus` wraps
 * Astro's handler so:
 *
 *   - `/_cirrus/rpc`, `/_cirrus/ws`, `/_cirrus/admin/*` → Cirrus realtime
 *     (forwarded to the `ShardDO` on `env.SHARD`)
 *   - everything else                                   → Astro SSR
 *
 * The two dispatch flows share one worker but never collide, and a throwing
 * Astro render is contained as a 500 without taking down the realtime plane.
 *
 * `shardDO` lives on `env`, so we build the composed worker per request (cheap —
 * it's a thin wrapper) and hand it `env.SHARD`.
 */
interface Env {
    SHARD: unknown;
}

export default {
    fetch(request: Request, env: Env, context: { passThroughOnException: () => void; waitUntil: (promise: Promise<unknown>) => void }): Promise<Response> {
        return withCirrus(astroWorker, {
            // The ShardDO namespace binding (declared in wrangler.jsonc).
            shardDO: env.SHARD as never,
            // auth, routes, resolveIdentity, observability, studio wiring … all
            // optional — add them here as the app grows.
        }).fetch(request, env, context);
    },
};
