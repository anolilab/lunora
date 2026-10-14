import type { Plugin } from "@lunora/server";

import type { LimiterResolver } from "./middleware";
import type { RateLimiter } from "./rate-limiter";

/** Context shape the plugin middleware widens to: a `ratelimit` limiter on `ctx.api`. */
export interface RatelimitApiContext<Context> {
    api: (Context extends { api: infer A } ? A : Record<never, never>) & { ratelimit: RateLimiter };
}

/**
 * Package `@lunora/ratelimit` as a first-party {@link Plugin}, the dogfooded
 * form of the plugin contract: instead of (or alongside) the enforcing
 * `rateLimit(...)` middleware, this exposes the resolved {@link RateLimiter}
 * under `ctx.api.ratelimit` so a handler can `limit()`/`check()`/`reset()`
 * programmatically.
 *
 * Install the middleware with one `.use(...)` (or fold it in with
 * `composePluginMiddleware([...])`):
 *
 * ```ts
 * const limiter = new RateLimiter({ config: { send: { kind: "token bucket", rate: 5, period: 60_000, capacity: 5 } } });
 * const c = initLunora.dataModel<DataModel>().create();
 * export const send = c.mutation
 *     .use(ratelimitPlugin(limiter).middleware!)
 *     .mutation(async ({ ctx, args }) => {
 *         const status = await ctx.api.ratelimit.limit("send", { key: ctx.userId });
 *         if (!status.ok) throw new Error("slow down");
 *         // …
 *     });
 * ```
 *
 * The plugin ships no schema extension — the limiter's persistence is whatever
 * store the resolved {@link RateLimiter} was built with — so it is a
 * middleware-only plugin and is skipped by `installPlugins(...)`'s schema fold.
 *
 * Built as a plain {@link Plugin} literal (the key is the fixed string
 * `"ratelimit"`, so the `definePlugin` validation adds nothing) — this keeps
 * `@lunora/server` a type-only dependency of `@lunora/ratelimit`.
 */
export const ratelimitPlugin = <Context = unknown>(
    limiter: LimiterResolver<Context>,
): Plugin<Record<never, never>, Context, Context & RatelimitApiContext<Context>> => {
    return {
        key: "ratelimit",
        middleware: async ({ ctx, next }) => {
            const resolved = typeof limiter === "function" ? await limiter(ctx) : limiter;
            const existingApi = (ctx as { api?: Record<string, unknown> }).api ?? {};

            return next({ ctx: { api: { ...existingApi, ratelimit: resolved } } }) as Promise<Context & RatelimitApiContext<Context>>;
        },
    };
};
