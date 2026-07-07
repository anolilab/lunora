import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * The Lunora-only worker for this SvelteKit project — RPC + WebSocket realtime
 * under `/_lunora/*`, and the `ShardDO` Durable Object class.
 *
 * This is NOT the deploy entry: production ships the single composed worker
 * `src/worker.ts` (SvelteKit SSR + Lunora in one `withLunora` worker). This
 * entry exists for **local dev only** — SvelteKit's own dev server runs SSR in
 * Node and cannot host a Durable Object (its `@sveltejs/adapter-cloudflare` uses
 * wrangler's `getPlatformProxy`, which doesn't emulate internal DOs). So
 * `lunora dev` runs `vite` (SvelteKit SSR + HMR, the front door) alongside a
 * `wrangler dev` sidecar pointed here (via `wrangler.dev.jsonc`) that owns the
 * real `ShardDO` in `workerd`; Vite proxies `/_lunora/*` to it, so the browser
 * client stays same-origin.
 *
 * `default` is the app (its `fetch` entrypoint); `ShardDO` is the bound Durable
 * Object class.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard) and data is protected by per-row RLS.
    // A PRODUCTION sharded app must gate this instead — e.g.
    // `.extend(() => ({ authorizeShard: (identity, shardKey) => identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;
export default app;
