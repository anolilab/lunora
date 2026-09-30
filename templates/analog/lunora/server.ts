import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "#lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
    SHARD_REGISTRY: ShardNamespaceLike;
}

/**
 * The Lunora worker for this Analog app, composed with the generated `defineApp`
 * builder. Unlike the React/Vue/Solid/Svelte templates there is no Angular
 * worker-composition adapter, so this builds a plain standalone worker with
 * `.build()` (NOT `.buildFrameworkWorker(host)`).
 *
 * The worker runs *in-process* inside Analog's Nitro server: the server route at
 * `src/server/routes/_lunora/[...].ts` imports this `app` and calls
 * `app.fetch(request, env, ctx)` for every `/_lunora/**` request. The `ShardDO`
 * class reaches the deployed Cloudflare worker via the project root's
 * `worker.ts` wrapper (`wrangler.jsonc`'s `main`), so a single deploy carries
 * both the Analog SSR handler and the Durable Object class.
 *
 * Add `@lunora/storage` / `@lunora/scheduler` / `@lunora/auth` or a `.global()`
 * table and codegen surfaces `.storage()` / `.scheduler()` / `.auth()` /
 * `.global()` here automatically.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .shardRegistry((env) => env.SHARD_REGISTRY)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard). Nothing else guards the data either: the
    // demo schema declares no RLS, so any caller can read and write every row.
    // Before deploying: add auth, give your tables row-level security
    // (`.rls(...)` in lunora/schema.ts), and replace this line with a shard gate — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;
// Tracks which shards hold `.shardBy()` rows, for cross-shard export / CDC sync.
export { ShardRegistryDO } from "lunorash/do";
export default app;
