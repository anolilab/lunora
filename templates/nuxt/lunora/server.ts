import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * Standalone Lunora worker for the two-worker Nuxt split, composed with the
 * generated `defineApp` builder. This worker owns `/_lunora/*` (RPC + WebSocket
 * realtime) and the `ShardDO` class; the Nuxt/Nitro SSR worker is a SEPARATE
 * deployment. Nitro doesn't expose its emitted fetch handler as an importable
 * module, so `/_lunora/*` can't be composed into the Nitro output — hence the
 * standalone `.build()` here (not `.buildFrameworkWorker()`). The browser client
 * connects its WebSocket here via `NUXT_PUBLIC_LUNORA_URL`.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .build();

export const ShardDO = app.ShardDO;
export default app;
