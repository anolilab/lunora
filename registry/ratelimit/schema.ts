/**
 * Rate-limit schema extension + plugin — added by `lunora add ratelimit`.
 *
 * This file is YOURS to own and edit. `lunora add` splices a managed
 * `.extend(ratelimit.extension)` into `lunora/schema.ts` so the `buckets` table
 * below merges into your schema as **`ratelimit_buckets`** (extension tables are
 * auto-prefixed with the plugin key — write the bare name here).
 *
 * The column layout matches what `@lunora/ratelimit`'s `createDbStore` reads and
 * writes for every `(limit-name, key)` pair:
 *
 *   - `key`   — opaque storage key the limiter derives from the limit name + sub-key.
 *   - `value` — tokens left (token bucket / fixed window) or requests made (sliding window).
 *   - `ts`    — last-refill time (token bucket) or window start (windowed algorithms).
 *   - `prev`  — previous-window count, sliding-window only (hence optional).
 *
 * The `by_key` index is what `createDbStore` looks rows up by; keep it.
 */
import type { Middleware } from "@lunora/server";
import { defineSchemaExtension, defineTable, definePlugin, v } from "@lunora/server";
import { createDbStore, RateLimiter } from "@lunora/ratelimit";
import type { RateLimitConfigMap } from "@lunora/ratelimit";

/**
 * Named limits this app enforces. Edit freely — add your own named limits and
 * reference them by name from `consume` / `check` (see `index.ts`) or from the
 * `ratelimit.middleware`.
 */
export const limits = {
    /** Default per-key limit: 10 requests, refilling continuously over 60s. */
    default: { kind: "token bucket", period: 60_000, rate: 10 },
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
 * (`ctx.api.ratelimit`). `lunora/schema.ts` wires the extension in via the
 * managed `.extend(ratelimit.extension)` block; attach the middleware yourself
 * with `c.mutation.use(ratelimit.middleware)`.
 */
export const ratelimit = definePlugin("ratelimit", {
    extension: defineSchemaExtension("ratelimit", {
        tables: {
            // Bare name — auto-prefixes to `ratelimit_buckets` at merge time.
            buckets: defineTable({
                key: v.string(),
                value: v.number(),
                ts: v.number(),
                prev: v.optional(v.number()),
            }).index("by_key", ["key"]),
        },
    }),
    middleware,
});
