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
 * Named limits this app enforces.
 *
 * Kept generous on purpose: this demo exists to show what the client does with
 * a *coded* rejection, and a rate-limit refusal is one — so a tight bucket here
 * would inject a second, unrelated rejection into the flow the demo is trying
 * to show. Reconnecting after a spell offline flushes the whole queue at once,
 * and that burst has to fit under the limit.
 */
export const limits = {
    /** Message sends: 120 per caller per minute, refilling continuously over 60s. */
    send: { kind: "token bucket", period: 60_000, rate: 120 },
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
