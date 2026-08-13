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
    .build();

export const ShardDO = app.ShardDO;
export default app;
