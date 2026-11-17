/**
 * Rate-limit functions — added by `lunora add ratelimit`.
 *
 * This file is YOURS: it's a normal Lunora module, copied into your project so
 * you own and edit it. Re-export the functions you want from your `lunora/`
 * entry so codegen picks them up — they surface in the generated `internal`
 * (server-only) namespace as `ratelimit/consume`, `ratelimit/check`,
 * `ratelimit/reset`, i.e. `internal.ratelimit.consume`.
 *
 * The actual limiting is done by `@lunora/ratelimit`'s `RateLimiter` over a
 * durable, `ctx.db`-backed store (see `./schema`). `consume` and `reset` are
 * mutations (they persist token state); `check` is a query (read-only peek).
 *
 * **These are `internal*` procedures, not public RPC, on purpose.** They are the
 * *management plane* of your limiter, and every one of them takes the bucket
 * `key` from the caller. Exposed as public RPC:
 *
 *   - `reset` lets anyone clear any bucket, which nullifies every limit the app
 *     enforces — the limiter becomes decorative.
 *   - `consume` lets anyone burn a *known victim's* bucket (their user id, their
 *     IP) and lock them out.
 *   - `check` is a free oracle over the same key space.
 *
 * No public guard fixes that: a guard on the management endpoints is itself
 * keyed by the caller, while the damage is done to *another* key. So these are
 * server-only. The way a request gets limited is the middleware — attach
 * `ratelimit.middleware` (or `rateLimit(...)` from `@lunora/ratelimit`) to the
 * procedures you actually want limited, where the key is derived server-side
 * from `ctx.auth.userId` / `ctx.ip` rather than taken from `args`:
 *
 * ```ts
 * export const sendInvite = mutation
 *     .input({ email: v.string() })
 *     .use(rateLimit(makeRateLimiter(ctx), "send", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" }))
 *     .mutation(async ({ args, ctx }) => { … });
 * ```
 *
 * Call these from your own handlers with `ctx.runMutation(internal.ratelimit.consume, …)`
 * once you have decided — server-side — which key the caller is allowed to touch.
 */
import { internalMutation, internalQuery, v } from "#lunora/_generated/server.js";

import { limits, makeRateLimiter } from "./schema.js";

/** Validator for a configured limit name (e.g. `"send"`). */
const limitName = v.union(...(Object.keys(limits) as (keyof typeof limits)[]).map((name) => v.literal(name)));

/**
 * Consume capacity against a named limit for an optional sub-key (per user / IP
 * / team). Returns the limiter status: `{ ok, retryAfter, reason? }`. Persists
 * the new token state, so it must be a mutation.
 */
export const consume = internalMutation
    .input({
        count: v.optional(v.number()),
        key: v.optional(v.string().max(256)),
        name: limitName,
    })
    .mutation(async ({ args: { count, key, name }, ctx }) => makeRateLimiter(ctx).limit(name, { count, key }));

/**
 * Peek at whether a request would be permitted **without** consuming. Read-only,
 * so it's a query.
 */
export const check = internalQuery
    .input({
        count: v.optional(v.number()),
        key: v.optional(v.string().max(256)),
        name: limitName,
    })
    .query(async ({ args: { count, key, name }, ctx }) => makeRateLimiter(ctx).check(name, { count, key }));

/** Clear accounting for a `(name, key)` pair — e.g. on a successful login. */
export const reset = internalMutation
    .input({
        key: v.optional(v.string().max(256)),
        name: limitName,
    })
    .mutation(async ({ args: { key, name }, ctx }) => {
        await makeRateLimiter(ctx).reset(name, { key });

        return { ok: true as const };
    });

// Re-export the plugin so callers can `import { ratelimit } from "./ratelimit"`
// and attach the middleware: `c.mutation.use(ratelimit.middleware)`.
export { limits, ratelimit } from "./schema.js";
