/**
 * Rate-limit schema extension + plugin.
 *
 * Defines the `ratelimit_buckets` table used by `createDbStore` for durable,
 * DO-backed rate limiting. Included automatically in every Lunora project.
 */
import type { RateLimitConfigMap } from "lunorash/ratelimit";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import type { Middleware } from "lunorash/server";
import { definePlugin, defineSchemaExtension, defineTable, v } from "lunorash/server";

/**
 * Named limits this app enforces. This is the one place they live — tuning
 * `write` here is what changes the budget of every mutation in
 * `lunora/tasks.ts` and `lunora/requests.ts`.
 */
export const limits = {
    /** Todo writes: 60 per caller per minute, refilling continuously over 60s. */
    write: { kind: "token bucket", period: 60_000, rate: 60 },
} as const satisfies RateLimitConfigMap;

/** The limit names you've configured above. */
export type LimitName = keyof typeof limits;

/**
 * Build a durable {@link RateLimiter} bound to this request's `ctx.db`. State is
 * persisted in the `ratelimit_buckets` table, so limits survive Durable Object
 * hibernation/eviction and are shared across every call into the same DO. Each
 * `get`→`set` runs under the DO input gate, so the read-modify-write is atomic.
 */
export const makeRateLimiter = (ctx: { db: unknown }): RateLimiter<LimitName> =>
    new RateLimiter<LimitName>({
        config: limits,
        // The merged table name carries the plugin prefix.
        store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
    });

/**
 * Middleware that injects `ctx.api.ratelimit` — a per-request limiter helper —
 * for any procedure that opts in with `.use(ratelimit.middleware)`. Convention
 * (see `@lunora/server` `definePlugin`): helpers hang off `ctx.api.<key>`.
 */
const middleware: Middleware<{ api?: Record<string, unknown>; db: unknown }, { api: Record<string, unknown>; db: unknown }> = ({ ctx, next }) =>
    next({
        ctx: {
            ...ctx,
            api: { ...ctx.api, ratelimit: makeRateLimiter(ctx) },
        },
    });

/**
 * The rate-limit plugin: a schema extension (`ratelimit_buckets`) + middleware
 * (`ctx.api.ratelimit`). `lunora/schema.ts` wires the extension in with
 * `.extend(ratelimit.extension)`; attach the middleware yourself with
 * `c.mutation.use(ratelimit.middleware)`.
 */
export const ratelimit = definePlugin("ratelimit", {
    extension: defineSchemaExtension("ratelimit", {
        tables: {
            // Bare name — auto-prefixes to `ratelimit_buckets` at merge time.
            // `externallyManaged`: rows are written by `createDbStore` (via
            // `makeRateLimiter`), not a discoverable `ctx.db.insert(...)`, so the
            // `table_without_insert` advisor correctly skips it.
            buckets: defineTable({
                key: v.string(),
                value: v.number(),
                ts: v.number(),
                prev: v.optional(v.number()),
            })
                .index("by_key", ["key"])
                .index("by_ts", ["ts"])
                .externallyManaged(),
        },
    }),
    middleware,
});
