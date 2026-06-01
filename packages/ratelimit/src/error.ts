import type { RateLimitReason, RateLimitStatus } from "./types.js";

const describe = (status: RateLimitStatus): string => {
    if (status.reason === "deny") {
        return "request denied (deny list)";
    }

    return Number.isFinite(status.retryAfter) ? `rate limit exceeded; retry after ${String(Math.ceil(status.retryAfter))}ms` : "rate limit exceeded";
};

/**
 * Thrown by `RateLimiter.limit` when called with `{ throws: true }`. The
 * `@cirrus/ratelimit` middleware does not use this — it throws a structural
 * `CirrusError` instead — so this is for direct callers that prefer exceptions.
 */
export default class RateLimitError extends Error {
    public override readonly name = "RateLimitError";

    public readonly reason: RateLimitReason | undefined;

    public readonly retryAfter: number;

    public constructor(status: RateLimitStatus, message?: string) {
        super(message ?? describe(status));
        this.reason = status.reason;
        this.retryAfter = status.retryAfter;
    }
}
