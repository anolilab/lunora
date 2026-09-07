import type { Middleware } from "@lunora/server";

import type { RateLimitMiddlewareOptions } from "./middleware";
import { rateLimit } from "./middleware";
import { RateLimiter } from "./rate-limiter";
import type { DbStoreOptions as DatabaseStoreOptions, RateLimitDb as RateLimitDatabase } from "./store";
import { createDbStore as createDatabaseStore } from "./store";
import type { RateLimitConfigMap } from "./types";

/**
 * DB-backed rate-limit middleware sugar. Collapses the common
 *
 * ```ts
 * rateLimit((ctx) => new RateLimiter({ config, store: createDbStore({ db: ctx.db }) }), name, opts)
 * ```
 *
 * into `dbRateLimit(config, name, opts)`: it builds a per-call {@link RateLimiter}
 * whose accounting lives in a Lunora table via `ctx.db` (so the bucket is durable
 * on the DO the procedure runs on). Every query/mutation/action ctx exposes a
 * compatible `db`, so it slots straight into a `.use(...)` chain.
 *
 * Pass `options.store` to point at a non-default backing table/index/key column
 * (defaults: table `rateLimits`, index `by_key`, key column `key`); the rest of
 * `options` (`key`, `count`, `failOpen`, `message`) is forwarded to
 * {@link rateLimit} unchanged. When `config` is precisely typed, `name`
 * autocompletes to its declared limit names.
 *
 * On a mutation the consumed unit commits with the handler: a handler that
 * throws rolls it back, so a failed call costs nothing. Attach it to an action
 * (whose writes commit independently) when failed attempts must count — see
 * {@link createDatabaseStore}.
 *
 * Re-exported as `dbRateLimit` from the package root.
 *
 * ```ts
 * const limits = { send: { kind: "token bucket", period: 60_000, rate: 30 } } satisfies RateLimitConfigMap;
 *
 * export const send = mutation
 *   .input({ text: v.string() })
 *   .use(dbRateLimit(limits, "send", { key: (ctx) => ctx.auth.userId ?? "anonymous" }))
 *   .mutation(async ({ ctx, args }) => ...);
 * ```
 */
const databaseRateLimit = <Context extends { db: RateLimitDatabase }, Names extends string = string>(
    config: RateLimitConfigMap<Names>,
    name: Names,
    options: RateLimitMiddlewareOptions<Context> & { store?: Omit<DatabaseStoreOptions, "db"> } = {},
): Middleware<Context, Context> =>
    rateLimit((context: Context) => new RateLimiter({ config, store: createDatabaseStore({ db: context.db, ...options.store }) }), name, options);

export default databaseRateLimit;
