import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * The Lunora app for this Nuxt project, composed with the generated `defineApp`
 * builder. It owns `/_lunora/*` (RPC + WebSocket realtime) and the `ShardDO`
 * class. In the single-worker setup, `@lunora/nuxt` mounts this app *inside*
 * Nitro (aliasing it to `#lunora/app` and forwarding the `/_lunora/**` route to
 * its `fetch`), and `exports.cloudflare.ts` re-exports `ShardDO` onto the same
 * Cloudflare worker entry — so Nuxt SSR + Lunora ship as one deploy.
 *
 * `default` is the app (its `fetch` entrypoint); `ShardDO` is the bound Durable
 * Object class.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .build();

export const ShardDO = app.ShardDO;
export default app;
