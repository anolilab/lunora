import { LunoraError } from "@lunora/errors";

import { STATUS_BY_REASON } from "./middleware";
import type { RateLimitReason, RateLimitStatus } from "./types";

const describe = (status: RateLimitStatus): string => {
    if (status.reason === "deny") {
        return "request denied (deny list)";
    }

    return Number.isFinite(status.retryAfter) ? `rate limit exceeded; retry after ${String(Math.ceil(status.retryAfter))}ms` : "rate limit exceeded";
};

/**
 * Thrown by `RateLimiter.limit` when called with `{ throws: true }`. A
 * `LunoraError` subclass whose code/status track `status.reason`: a rate
 * rejection is `TOO_MANY_REQUESTS`/429, a deny-list hit is `FORBIDDEN`/403 —
 * the same mapping the middleware applies, so both entry points surface the
 * identical wire code (a permanent deny is never a retryable 429). The
 * middleware itself throws a bare structural `LunoraError`, so this is for
 * direct callers that prefer exceptions. Keeps `reason`/`retryAfter`.
 */
export default class RateLimitError extends LunoraError {
    public readonly reason: RateLimitReason | undefined;

    public readonly retryAfter: number;

    public constructor(status: RateLimitStatus, message?: string) {
        const { code, status: httpStatus } = STATUS_BY_REASON[status.reason ?? "rate"];

        super(code, message ?? describe(status), { name: "RateLimitError", status: httpStatus });
        this.reason = status.reason;
        this.retryAfter = status.retryAfter;
    }
}
