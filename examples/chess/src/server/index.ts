import type { D1DatabaseLike } from "@lunora/d1";
import type { ShardNamespaceLike } from "lunorash/runtime";

import { authOptions } from "../../lunora/auth.js";
import { defineApp } from "../../lunora/_generated/app.js";

interface Env {
    AUTH_SECRET: string;
    DB: D1DatabaseLike;
    SHARD: ShardNamespaceLike;
}

/**
 * The composed worker.
 *
 * `defineApp()` is generated from this project's schema; each declaration wires
 * a capability's `ctx.*` surface and its admin/studio surface together. Here
 * that is two lines: the shard namespace every RPC routes through, and
 * better-auth over D1 — which builds the instance, runs the migration sweep on
 * first request, serves `/api/auth/*`, and resolves `ctx.auth.userId` for the
 * guards in `lunora/`.
 *
 * No `authorizeShard`: this schema declares no `.shardBy` table, so every
 * function resolves to the root shard and there is no client-chosen shard key to
 * authorise. The runtime default-denies a client-named shard anyway. Add the
 * callback the moment a table gains a shard key — see `examples/team-chat`.
 */
const app = defineApp<Env>()
    .shard((env) => env.SHARD)
    .auth({ d1: (env) => env.DB, options: authOptions })
    .build();

export const ShardDO = app.ShardDO;

// The composed app IS the module worker — exported wholesale rather than
// re-wrapped, so every handler `.build()` composes reaches Cloudflare. A
// hand-built `{ fetch }` object drops `scheduled`/`queue`/`email`, and those
// appear the moment a `lunora/crons.ts`, a `defineQueue` or `.onEmail(...)` is
// added — while `lunora deploy` provisions the matching trigger from the same
// discovery, so the trigger fires into nothing.
export default app;
