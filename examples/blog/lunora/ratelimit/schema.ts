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
    /** Draft autosave fires on every debounced keystroke, so it needs headroom. */
    autosave: { kind: "token bucket", period: 60_000, rate: 120 },
    write: { kind: "token bucket", period: 60_000, rate: 30 },
    // Each upload mints a signed URL and costs R2 storage; keep it deliberate.
    upload: { kind: "fixed window", period: 60_000, rate: 20 },
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
