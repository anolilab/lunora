import { handle } from "@astrojs/cloudflare/handler";
import { withLunora } from "@lunora/astro";
import type { ShardNamespaceLike } from "lunora/runtime";

import { createShardDO } from "../lunora/_generated/shard.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`; the
 * class is bound as `SHARD` in `wrangler.jsonc`.
 */
export const ShardDO = createShardDO();

/**
 * The single Cloudflare Worker for this app — PLAN4 **class-B** composition.
 *
 * Astro 6 + `@astrojs/cloudflare` v13 no longer emit `dist/_worker.js`; the
 * supported custom-entry pattern is to import `handle` from
 * `@astrojs/cloudflare/handler` (the adapter's built-in SSR handler) and wrap
 * it with `withLunora` so Lunora realtime mounts in the same worker.
 *
 * `withLunora` wraps the `handle` fetch function so:
 *
 *   - `/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/*` → Lunora realtime
 *     (forwarded to the `ShardDO` on `env.SHARD`)
 *   - everything else                                   → Astro SSR via `handle`
 *
 * The two dispatch flows share one worker but never collide, and a throwing
 * Astro render is contained as a 500 without taking down the realtime plane.
 *
 * `shardDO` lives on `env`, so we pass a factory — rebuilt per request — so
 * `env.SHARD` is always the live per-request binding.
 */
interface Env {
    SHARD: ShardNamespaceLike;
}

export default withLunora(
    // `handle` is the Astro adapter's SSR fetch handler (Astro 6 /
    // @astrojs/cloudflare v13 pattern). It resolves the routes Astro's build
    // emits and serves static assets via env.ASSETS — no manifest import needed.
    (request: Request, env: unknown, ctx: unknown) => handle(request, env as Env, ctx as ExecutionContext),
    // Factory form: options rebuilt per request so env.SHARD (a live DO binding)
    // is wired in at call time. Add auth, routes, observability, etc. here.
    (env) => ({
        shardDO: (env as Env).SHARD,
    }),
);
