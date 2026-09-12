/**
 * Rate-limit schema extension + plugin.
 *
 * Defines the `ratelimit_buckets` table used by `createDbStore` for durable,
 * DO-backed rate limiting. Included automatically in every Lunora project.
 */
import type { Middleware } from "lunorash/server";
import { defineSchemaExtension, defineTable, definePlugin, v } from "lunorash/server";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import type { RateLimitConfigMap } from "lunorash/ratelimit";

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

export type LimitName = keyof typeof limits;

export const makeRateLimiter = (ctx: { db: unknown }): RateLimiter<LimitName> =>
    new RateLimiter<LimitName>({
        config: limits,
        store: createDbStore({ db: ctx.db as never, table: "ratelimit_buckets" }),
    });

const middleware: Middleware<{ api?: Record<string, unknown>; db: unknown }, { api: Record<string, unknown>; db: unknown }> = ({ ctx, next }) =>
    next({
        ctx: {
            ...ctx,
            api: { ...ctx.api, ratelimit: makeRateLimiter(ctx) },
        },
    });

export const ratelimit = definePlugin("ratelimit", {
    extension: defineSchemaExtension("ratelimit", {
        tables: {
            buckets: defineTable({
                key: v.string(),
                value: v.number(),
                ts: v.number(),
                prev: v.optional(v.number()),
            })
                .index("by_key", ["key"])
                .externallyManaged(),
        },
    }),
    middleware,
});
