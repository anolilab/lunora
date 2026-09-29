import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * The Lunora app, composed with the generated `defineApp` builder. It exposes
 * one fluent method per capability THIS app uses — right now just `.shard()`.
 * Add `@lunora/storage` / `@lunora/scheduler` / `@lunora/auth` or a `.global()`
 * table and codegen surfaces `.storage()` / `.scheduler()` / `.auth()` /
 * `.global()` here automatically (IntelliSense lists what you can configure).
 *
 * Two Worker entries finish it: `src/lunora.ts` (`.build()`, the Lunora-only
 * Worker `rsbuild dev` runs) and `src/worker.ts` (`.buildFrameworkWorker()`,
 * with the TanStack Start SSR handler folded in, for deploy).
 */
export const lunora = defineApp<Env>()
    .shard((env) => env.SHARD)
    // Demo/local default: this app has no auth, so shard access is left OPEN
    // (any caller may target any shard). Nothing else guards the data either: the
    // demo schema declares no RLS, so any caller can read and write every row.
    // Without this line the `.shardBy(...)` demo in `lunora/schema.ts`
    // default-denies and every sharded socket 403s.
    // Before deploying: add auth, give your tables row-level security
    // (`.rls(...)` in lunora/schema.ts), and replace this line with a shard gate — e.g.
    // `.extend(() => ({ authorizeShard: ({ identity, shardKey }) => shardKey === "__root__" || identity?.userId === ownerOf(shardKey) }))`.
    .extend(() => ({ allowUnauthenticatedShardAccess: true }));
