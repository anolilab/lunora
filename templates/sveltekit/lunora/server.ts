import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
    SHARD_REGISTRY: ShardNamespaceLike;
}

/**
 * The Lunora-only worker for this SvelteKit project — RPC + WebSocket realtime
 * under `/_lunora/*`, and the `ShardDO` Durable Object class.
 *
 * This is NOT the deploy entry: production ships the single composed worker
 * `src/worker.ts` (SvelteKit SSR + Lunora folded into one worker via
 * `.buildFrameworkWorker(...)`). This entry exists for **local dev only** —
 * SvelteKit's own dev server runs SSR in Node and cannot host a Durable
 * Object (its `@sveltejs/adapter-cloudflare` uses
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
