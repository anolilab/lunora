import type { RateLimiter } from "lunorash/ratelimit";

import type { MutationCtx } from "./_generated/server.js";
import type { LimitName } from "./ratelimit/schema.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/**
 * The limiter every public write uses. Privacy requests and task writes share one
 * bucket per caller, so a caller who files requests in a loop is throttled like one
 * who writes tasks in a loop, and the export and erasure workflows cannot be started
 * faster than that.
 */
export const limiter = (ctx: MutationCtx): RateLimiter<LimitName> => makeRateLimiter(ctx);

/** Keyed by the signed-in user, or by IP for a call with no session, so a bucket always exists. */
export const byCaller = {
    key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon",
};
