import type { Middleware } from "@cirrus/server";

import type { RateLimiter } from "./rate-limiter.js";
import type { RateLimitReason } from "./types.js";

/**
 * Either a fixed {@link RateLimiter} or a function that derives one from `ctx`
 * — the latter lets a procedure bind a durable, ORM-backed limiter at call time
 * (e.g. `(ctx) => new RateLimiter({ config, store: createDbStore({ db: ctx.db }) })`).
 */
export type LimiterResolver<Ctx> = ((ctx: Ctx) => Promise<RateLimiter> | RateLimiter) | RateLimiter;

export interface RateLimitMiddlewareOptions<Ctx> {
    /** Units to consume per call. Defaults to `1`. */
    count?: number;
    /** Sub-key derived from `ctx` (per-user/IP). Omit for a global limit. */
    key?: (ctx: Ctx) => string | undefined;
    /** Override the error message thrown on rejection. */
    message?: string;
}

const STATUS_BY_REASON: Record<RateLimitReason, { code: string; status: number }> = {
    deny: { code: "FORBIDDEN", status: 403 },
    rate: { code: "TOO_MANY_REQUESTS", status: 429 },
};

const defaultMessage = (name: string, reason: RateLimitReason, retryAfter: number | undefined): string => {
    if (reason === "deny") {
        return `request denied for "${name}"`;
    }

    return retryAfter === undefined ? `rate limit "${name}" exceeded` : `rate limit "${name}" exceeded; retry after ${retryAfter}ms`;
};

/**
 * Procedure middleware that enforces a named rate limit before the handler
 * runs. Attach it with `.use()`. On rejection it throws a structural
 * `CirrusError` (`TOO_MANY_REQUESTS`/429, or `FORBIDDEN`/403 for deny-list
 * hits) carrying `retryAfter` in milliseconds — the runtime maps it to the
 * matching RPC/HTTP status without any import of `@cirrus/server` at runtime.
 */
export const rateLimit =
    <Ctx>(limiter: LimiterResolver<Ctx>, name: string, options: RateLimitMiddlewareOptions<Ctx> = {}): Middleware<Ctx, Ctx> =>
    async ({ ctx, next }) => {
        const resolved = typeof limiter === "function" ? await limiter(ctx) : limiter;
        const status = await resolved.limit(name, { count: options.count, key: options.key?.(ctx) });

        if (!status.ok) {
            const reason = status.reason ?? "rate";
            const mapped = STATUS_BY_REASON[reason];
            const retryAfter = Number.isFinite(status.retryAfter) ? Math.ceil(status.retryAfter) : undefined;

            throw Object.assign(new Error(options.message ?? defaultMessage(name, reason, retryAfter)), {
                code: mapped.code,
                name: "CirrusError",
                retryAfter,
                status: mapped.status,
            });
        }

        return next();
    };
