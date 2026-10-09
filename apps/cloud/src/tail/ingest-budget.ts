/**
 * The per-organization ceiling on runtime log lines the tail ingest writes.
 *
 * A Lunora app logs through `ctx.log`; a plain Cloudflare Worker's every
 * `console.log` is a line too (`./parse.ts`), and every line is a row in the
 * control plane's own database. The tail worker bounds one script per flush;
 * this bounds an organization over time, so one chatty Worker cannot write rows
 * without end. Lines over the ceiling are dropped and counted in one notice
 * line — itself rate-limited, so the notices cannot become the flood.
 */
import type { RateLimitConfigMap, RateLimitStatus } from "@lunora/ratelimit";

import type { TailLogLine } from "./parse";

/** Runtime log lines an organization may ingest per minute through the tail. */
export const TAIL_LOG_LINES_PER_MINUTE = 6000;

/** The two buckets: the lines, and the "lines dropped" notices written once the lines run out. */
export const TAIL_LOG_LIMITS = {
    tailLogDropNotices: { capacity: 5, kind: "token bucket", period: 60_000, rate: 5 },
    tailLogLines: { capacity: TAIL_LOG_LINES_PER_MINUTE, kind: "token bucket", period: 60_000, rate: TAIL_LOG_LINES_PER_MINUTE },
} as const satisfies RateLimitConfigMap;

/** The part of a `RateLimiter` this needs. */
export interface TailLogLimiter {
    limit: (name: keyof typeof TAIL_LOG_LIMITS, args: { count?: number; key: string }) => Promise<RateLimitStatus>;
}

/**
 * The lines of one batch the organization may store: all of them within its
 * ceiling, else none — and, while notices last, one line saying how many were
 * dropped and why.
 */
export const admitTailLines = async <Line extends TailLogLine>(
    lines: ReadonlyArray<Line>,
    limiter: TailLogLimiter,
    organizationId: string,
): Promise<ReadonlyArray<Line | TailLogLine>> => {
    if (lines.length === 0) {
        return lines;
    }

    const status = await limiter.limit("tailLogLines", { count: lines.length, key: organizationId });

    if (status.ok) {
        return lines;
    }

    const notice = await limiter.limit("tailLogDropNotices", { key: organizationId });

    return notice.ok
        ? [
              {
                  level: "warn",
                  message: `${String(lines.length)} log line(s) dropped: this organization's runtime logs are over ${String(TAIL_LOG_LINES_PER_MINUTE)} lines a minute`,
              },
          ]
        : [];
};
