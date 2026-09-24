import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "#lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * The Lunora app for this Nuxt project, composed with the generated `defineApp`
 * builder. It owns `/_lunora/*` (RPC + WebSocket realtime) and the `ShardDO`
 * class. In the single-worker setup, `@lunora/nuxt` mounts this app *inside*
 * Nitro (aliasing it to `#lunora/app` and forwarding the `/_lunora/**` route to
 * its `fetch`), and the project-root `worker.ts` wrapper (`wrangler.jsonc`'s
 * `main`) re-exports `ShardDO` alongside Nitro's SSR handler — so Nuxt SSR +
 * Lunora ship as one deploy.
 *
 * `default` is the app (its `fetch` entrypoint); `ShardDO` is the bound Durable
 * Object class.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard) and data is protected by per-row RLS.
    // A PRODUCTION sharded app must gate this instead — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;
export default app;
