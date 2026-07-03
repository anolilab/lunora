import { LunoraError } from "@lunora/errors";

import type { RateLimitReason, RateLimitStatus } from "./types";

const describe = (status: RateLimitStatus): string => {
    if (status.reason === "deny") {
        return "request denied (deny list)";
    }

    return Number.isFinite(status.retryAfter) ? `rate limit exceeded; retry after ${String(Math.ceil(status.retryAfter))}ms` : "rate limit exceeded";
};

/**
 * Thrown by `RateLimiter.limit` when called with `{ throws: true }`. A
 * `LunoraError` subclass (`code: "TOO_MANY_REQUESTS"`, `status: 429`); the
 * `@lunora/ratelimit` middleware itself throws a bare structural `LunoraError`,
 * so this is for direct callers that prefer exceptions. Keeps `reason`/`retryAfter`.
 */
export default class RateLimitError extends LunoraError {
    public readonly reason: RateLimitReason | undefined;

    public readonly retryAfter: number;

    public constructor(status: RateLimitStatus, message?: string) {
        super("TOO_MANY_REQUESTS", message ?? describe(status), { name: "RateLimitError" });
        this.reason = status.reason;
        this.retryAfter = status.retryAfter;
    }
}
