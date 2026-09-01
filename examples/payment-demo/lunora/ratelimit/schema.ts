/**
 * Rate-limit schema extension + plugin.
 *
 * Defines the `ratelimit_buckets` table used by `createDbStore` for durable,
 * DO-backed rate limiting. Named limits live here and nowhere else.
 */
import type { Middleware } from "lunorash/server";
import { defineSchemaExtension, defineTable, definePlugin, v } from "lunorash/server";
import { createDbStore, RateLimiter } from "lunorash/ratelimit";
import type { RateLimitConfigMap } from "lunorash/ratelimit";

export const limits = {
    // Every one of these reaches Stripe over the network, on somebody's account.
    // This demo has no sign-in, so the limit keyed on `ctx.ip` is the only thing
    // between a deployed instance and a script running up an API bill.
    checkout: { kind: "fixed window", period: 60_000, rate: 5 },
    /** Metering + entitlement reads are cheap but still outbound. */
    meter: { kind: "token bucket", period: 60_000, rate: 60 },
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
