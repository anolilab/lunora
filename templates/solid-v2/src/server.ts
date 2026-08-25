import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * Worker entry, composed with the generated `defineApp` builder. It exposes one
 * fluent method per capability THIS app uses — right now just `.shard()`. Add
 * `@lunora/storage` / `@lunora/scheduler` / `@lunora/auth` or a `.global()`
 * table and codegen surfaces `.storage()` / `.scheduler()` / `.auth()` /
 * `.global()` here automatically (IntelliSense lists what you can configure).
 *
 * `@lunora/vite` serves this Worker on the same origin as the Vite dev server,
 * so the browser client can point at `location.origin` and the built SPA is
 * served by the same deployment.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard) and data is protected by per-row RLS.
    // It belongs HERE rather than on the Vite plugin: `lunora({
    // allowUnauthenticatedShardAccess })` only reaches the generated
    // `virtual:lunora/worker` entry that meta-framework templates use, and this
    // one is its own hand-written entry — without this line the `.shardBy(...)`
    // demo in `lunora/schema.ts` default-denies and every sharded socket 403s.
    // A PRODUCTION sharded app must gate this instead — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;
export default app;
