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
 * Named limits this app enforces. Two buckets, because the two writes have
 * nothing in common: joining a room is a once-per-session click, while cursor
 * positions stream for as long as the pointer moves.
 *
 * `move` is deliberately permissive — it is a ceiling on a runaway client, not a
 * throttle. `updateCursor` is meant to run at the ~30fps the client throttles
 * to, so the budget is sized well above that and only a client that stopped
 * throttling will ever hit it. Tighten it here and you will rate-limit ordinary
 * pointer movement.
 */
export const limits = {
    /** Room joins: 20 per caller per minute. */
    join: { kind: "token bucket", period: 60_000, rate: 20 },
    /** Cursor positions: 3 000 per caller per minute — ~50/s, above the client's ~30fps throttle. */
    move: { kind: "token bucket", period: 60_000, rate: 3000 },
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
