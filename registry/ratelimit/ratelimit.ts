/**
 * Rate-limit functions — added by `lunora add ratelimit`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export the functions you want from your `lunora/`
 * entry so codegen picks them up (they'll surface in the generated `api` as
 * `ratelimit/consume`, `ratelimit/check`, `ratelimit/reset`).
 *
 * The actual limiting is done by `@lunora/ratelimit`'s `RateLimiter` over a
 * durable, `ctx.db`-backed store (see `./schema`). `consume` and `reset` are
 * mutations (they persist token state); `check` is a query (read-only peek).
 */
import { mutation, query, v } from "@lunora/server";

import { limits, makeRateLimiter } from "./schema.js";

/** Validator for a configured limit name (e.g. `"default"`). */
const limitName = v.union(...(Object.keys(limits) as (keyof typeof limits)[]).map((name) => v.literal(name)));

/**
 * Consume capacity against a named limit for an optional sub-key (per user / IP
 * / team). Returns the limiter status: `{ ok, retryAfter, reason? }`. Persists
 * the new token state, so it must be a mutation.
 */
export const consume = mutation({
    args: {
        count: v.optional(v.number()),
        key: v.optional(v.string()),
        name: limitName,
    },
    handler: async (ctx, { count, key, name }) => makeRateLimiter(ctx).limit(name, { count, key }),
});

/**
 * Peek at whether a request would be permitted **without** consuming. Read-only,
 * so it's a query.
 */
export const check = query({
    args: {
        count: v.optional(v.number()),
        key: v.optional(v.string()),
        name: limitName,
    },
    handler: async (ctx, { count, key, name }) => makeRateLimiter(ctx).check(name, { count, key }),
});

/** Clear accounting for a `(name, key)` pair — e.g. on a successful login. */
export const reset = mutation({
    args: {
        key: v.optional(v.string()),
        name: limitName,
    },
    handler: async (ctx, { key, name }) => {
        await makeRateLimiter(ctx).reset(name, { key });

        return { ok: true as const };
    },
});

// Re-export the plugin so callers can `import { ratelimit } from "./ratelimit"`
// and attach the middleware: `c.mutation.use(ratelimit.middleware)`.
export { limits, ratelimit } from "./schema.js";
