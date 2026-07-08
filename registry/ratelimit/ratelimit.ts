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
import { RateLimiter, rateLimit, createMemoryStore } from "@lunora/ratelimit";

import { mutation, query, v } from "#lunora/_generated/server.js";

import { limits, makeRateLimiter } from "./schema.js";

/** Validator for a configured limit name (e.g. `"default"`). */
const limitName = v.union(...(Object.keys(limits) as (keyof typeof limits)[]).map((name) => v.literal(name)));

/**
 * A small in-memory guard on the public limiter-management endpoints themselves:
 * `consume`/`reset` are writes, so an attacker could otherwise hammer them to
 * exhaust the durable store or clear others' accounting. Separate from the app's
 * `makeRateLimiter` (which is what these endpoints operate on) and intentionally
 * generous; tune to taste.
 */
const adminGuard = new RateLimiter({
    config: {
        admin: { kind: "token bucket", period: 60_000, rate: 120 },
    },
    store: createMemoryStore(),
});

/** Rate-limit guard for the public management mutations, keyed by caller. */
const guardManagement = rateLimit(adminGuard, "admin", { key: (ctx) => ctx.auth.userId ?? "anon" });

/**
 * Consume capacity against a named limit for an optional sub-key (per user / IP
 * / team). Returns the limiter status: `{ ok, retryAfter, reason? }`. Persists
 * the new token state, so it must be a mutation.
 */
export const consume = mutation
    .input({
        count: v.optional(v.number()),
        key: v.optional(v.string().meta({ schema: { maxLength: 256 } })),
        name: limitName,
    })
    .use(guardManagement)
    .mutation(async ({ args: { count, key, name }, ctx }) => makeRateLimiter(ctx).limit(name, { count, key }));

/**
 * Peek at whether a request would be permitted **without** consuming. Read-only,
 * so it's a query.
 */
export const check = query
    .input({
        count: v.optional(v.number()),
        key: v.optional(v.string().meta({ schema: { maxLength: 256 } })),
        name: limitName,
    })
    .query(async ({ args: { count, key, name }, ctx }) => makeRateLimiter(ctx).check(name, { count, key }));

/** Clear accounting for a `(name, key)` pair — e.g. on a successful login. */
export const reset = mutation
    .input({
        key: v.optional(v.string().meta({ schema: { maxLength: 256 } })),
        name: limitName,
    })
    .use(guardManagement)
    .mutation(async ({ args: { key, name }, ctx }) => {
        await makeRateLimiter(ctx).reset(name, { key });

        return { ok: true as const };
    });

// Re-export the plugin so callers can `import { ratelimit } from "./ratelimit"`
// and attach the middleware: `c.mutation.use(ratelimit.middleware)`.
export { limits, ratelimit } from "./schema.js";
