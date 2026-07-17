import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "./_generated/app.js";

interface Env extends Record<string, unknown> {
    SHARD: ShardNamespaceLike;
}

/**
 * Standalone Lunora worker for the two-worker Next.js split, composed with the
 * generated `defineApp` builder. This worker owns `/_lunora/*` (RPC + WebSocket
 * realtime) and the `ShardDO` class; the Next.js SSR worker (built by the
 * OpenNext Cloudflare adapter) is a SEPARATE deployment. OpenNext owns the
 * worker entry it emits and exposes no supported hook to compose extra routes
 * or DO classes into it, so `/_lunora/*` can't ride inside the Next output —
 * hence the standalone `.build()` here. The RSC loader and the browser client
 * reach this worker via `NEXT_PUBLIC_LUNORA_URL`.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .build();

export const ShardDO = app.ShardDO;
export default app;
