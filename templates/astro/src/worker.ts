import { handle } from "@astrojs/cloudflare/handler";
import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * The single Cloudflare Worker for this app — PLAN4 class-B composition,
 * expressed with the generated `defineApp` builder.
 * `.buildFrameworkWorker(host)` folds Astro's adapter SSR handler (`handle`
 * from `@astrojs/cloudflare/handler`, the Astro 6 / @astrojs/cloudflare v13
 * pattern) in as the framework host: `/_lunora/{rpc,ws,admin}` route to Lunora
 * (forwarded to the `ShardDO` on `env.SHARD`) and everything else renders via
 * Astro. Add `.storage()` / `.auth()` / `.global()` as you adopt those packages.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard) and data is protected by per-row RLS.
    // A PRODUCTION sharded app must gate this instead — e.g.
    // `.extend(() => ({ authorizeShard: (identity, shardKey) => identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .buildFrameworkWorker((request: Request, env: unknown, ctx: unknown) => handle(request, env as Env, ctx as ExecutionContext));

export const ShardDO = app.ShardDO;
export default app;
