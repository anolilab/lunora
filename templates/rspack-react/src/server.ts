import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
    SHARD_REGISTRY: ShardNamespaceLike;
}

/**
 * Worker entry, composed with the generated `defineApp` builder. It exposes one
 * fluent method per capability THIS app uses — right now just `.shard()`. Add
 * `@lunora/storage` / `@lunora/scheduler` / `@lunora/auth` or a `.global()`
 * table and codegen surfaces `.storage()` / `.scheduler()` / `.auth()` /
 * `.global()` here automatically (IntelliSense lists what you can configure).
 *
 * In dev `lunoraRsbuild()` runs this Worker under `wrangler dev` and proxies
 * `/_lunora/*` to it. In production `wrangler.jsonc` binds the built SPA as its
 * static assets, so one deployment serves both.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .shardRegistry((env) => env.SHARD_REGISTRY)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard). Nothing else guards the data either: the
    // demo schema declares no RLS, so any caller can read and write every row.
    // Without this line the `.shardBy(...)` demo in `lunora/schema.ts`
    // default-denies and every sharded socket 403s.
    // Before deploying: add auth, give your tables row-level security
    // (`.rls(...)` in lunora/schema.ts), and replace this line with a shard gate — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }))
    .build();

export const ShardDO = app.ShardDO;
// Tracks which shards hold `.shardBy()` rows, for cross-shard export / CDC sync.
export { ShardRegistryDO } from "../lunora/_generated/shardRegistry.js";
export default app;
