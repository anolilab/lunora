import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
    SHARD_REGISTRY: ShardNamespaceLike;
}

/**
 * The Lunora app, composed with the generated `defineApp` builder. Add
 * `.storage()` / `.auth()` / `.global()` etc. as you adopt those packages
 * (codegen surfaces the methods automatically).
 *
 * Defined once, here, and finished by two Worker entries: `lunora/server.ts`
 * (`.build()`, the Lunora-only Worker `lunora dev` runs as its sidecar) and
 * `src/worker.ts` (`.buildFrameworkWorker()`, with the SvelteKit handler folded
 * in, for deploy). Configuring the app in one place is what keeps auth or a
 * shard gate added for dev from silently missing in production.
 */
export const lunora = defineApp<Env>()
    .shard((env) => env.SHARD)
    .shardRegistry((env) => env.SHARD_REGISTRY)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard). Nothing else guards the data either: the
    // demo schema declares no RLS, so any caller can read and write every row.
    // Before deploying: add auth, give your tables row-level security
    // (`.rls(...)` in lunora/schema.ts), and replace this line with a shard gate — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }));
