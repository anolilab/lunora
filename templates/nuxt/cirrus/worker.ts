import type { WithCirrusOptions } from "@cirrus/vue/worker";

import { CIRRUS_FUNCTIONS } from "./_generated/functions.js";
import { openApiSpec } from "./_generated/openapi.js";
import { createShardDO } from "./_generated/shard.js";

/**
 * The Durable Object that backs every shard's SQLite state. `createShardDO`
 * folds the generated dispatch table + live schema into the base `ShardDO`; the
 * class is bound as `SHARD` in `wrangler.jsonc`. The composed server entry
 * (`server/cirrus-entry.ts`) re-exports it so Wrangler registers the DO class.
 * Pass `scheduler` / `storage` / `d1` thunks once you add `@cirrus/scheduler`,
 * `@cirrus/storage`, or `.global()` tables.
 */
export const ShardDO = createShardDO();

/**
 * Environment bindings the Cirrus realtime plane needs. Nuxt/Nitro injects the
 * same `env` into the composed Worker; `SHARD` is the Durable Object namespace
 * declared in `wrangler.jsonc`.
 */
interface CirrusEnv {
    SHARD: WithCirrusOptions["shardDO"];
}

/**
 * Build the Cirrus options for `withCirrus` (the Class-B single-worker
 * composition for Nuxt — PLAN4 §3, M4). These mirror what a Class-A template
 * passes to `createWorker`, minus `httpRouter`: `withCirrus` supplies that from
 * Nitro's emitted handler. Grow this by adding auth, storage listing, admin
 * introspectors, custom `routes`, crons, etc.
 *
 * Kept as a factory (not a module-level constant) because `env.SHARD` is only
 * available per-request inside the Worker.
 */
export const cirrusOptions = (env: CirrusEnv): WithCirrusOptions => ({
    // Exposes /_cirrus/admin/functions for the studio's function runner.
    functions: CIRRUS_FUNCTIONS,
    // The generated OpenAPI document (regenerated on every `cirrus/` change)
    // backs the studio's always-current API-reference tab.
    openApiSpec,
    // better-auth / OAuth callbacks etc. mount here; empty to start.
    routes: {},
    shardDO: env.SHARD,
});
