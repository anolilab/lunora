import { isInternalCode, isLunoraError, LunoraError } from "@lunora/errors";
import type { Middleware } from "@lunora/server";

import type { RateLimiter } from "./rate-limiter";
import type { RateLimitReason } from "./types";

/**
 * Either a fixed {@link RateLimiter} or a function that derives one from `ctx`
 * — the latter lets a procedure bind a durable, ORM-backed limiter at call time
 * (e.g. `(ctx) => new RateLimiter({ config, store: createDbStore({ db: ctx.db }) })`).
 */
type LimiterResolver<Context> = ((context: Context) => Promise<RateLimiter> | RateLimiter) | RateLimiter;

interface RateLimitMiddlewareOptions<Context> {
    /** Units to consume per call. Defaults to `1`. */
    count?: number;

    /**
     * Behavior when the limiter itself throws (store unavailable, etc).
     * Defaults to `false` (fail closed: deny the request with a 503). Set to
     * `true` only when degraded availability is preferable to denying traffic
     * — note that a failing limiter then permits every request through.
     */
    failOpen?: boolean;

    /**
     * Sub-key derived from `ctx` (per-user/IP). Omit for a global limit.
     *
     * A resolver that returns `undefined` is a config bug, not a global limit:
     * the middleware throws `INTERNAL` rather than silently pooling every
     * keyless caller (e.g. every anonymous user) into one shared bucket. Fold
     * the absent case yourself — `ctx.auth.userId ?? "anonymous"` — so the
     * shared bucket is a visible choice.
     */
    key?: (context: Context) => string | undefined;
    /** Override the error message thrown on rejection. */
    message?: string;
}

/** Wire code/status a denial maps to, keyed by why it was denied. */
const STATUS_BY_REASON: Record<RateLimitReason, { code: string; status: number }> = {
    deny: { code: "FORBIDDEN", status: 403 },
    rate: { code: "TOO_MANY_REQUESTS", status: 429 },
};

const defaultMessage = (name: string, reason: RateLimitReason, retryAfterMs: number | undefined): string => {
    if (reason === "deny") {
        return `request denied for "${name}"`;
    }

    return retryAfterMs === undefined ? `rate limit "${name}" exceeded` : `rate limit "${name}" exceeded; retry after ${String(retryAfterMs)}ms`;
};

/**
 * Fail closed: a per-caller limit whose key resolves to `undefined` would
 * quietly become one global bucket that a single caller can drain for everyone.
 * INTERNAL, so the middleware's catch rethrows it as-is under both policies.
 */
const resolveKey = <Context>(name: string, context: Context, key: RateLimitMiddlewareOptions<Context>["key"]): string | undefined => {
    if (!key) {
        return undefined;
    }

    const resolved = key(context);

    if (resolved === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/ratelimit: rateLimit("${name}") key resolver returned undefined; return a fallback such as "anonymous" instead`,
        );
    }

    return resolved;
};

/**
 * Procedure middleware that enforces a named rate limit before the handler
 * runs. Attach it with `.use()`. On rejection it throws a structural
 * `LunoraError` (`TOO_MANY_REQUESTS`/429, or `FORBIDDEN`/403 for deny-list
 * hits) carrying `data.retryAfterMs` — the runtime maps it to the
 * matching RPC/HTTP status without any import of `@lunora/server` at runtime.
 *
 * **Failure policy:** if resolving or invoking the limiter throws for a genuine
 * availability reason (e.g. the persistence store is unavailable), the
 * middleware **fails closed by default**: it logs via `console.error` and
 * rejects the request with `503`. This is the safer default for
 * security-sensitive limits (auth, account creation). Pass `failOpen: true` to
 * swallow the error and admit the request instead — appropriate only when
 * degraded availability is preferable to refusal. Deterministic caller misuse
 * (an unconfigured limit name, a non-positive count, or a count that exceeds
 * capacity) throws an `INTERNAL` `LunoraError` that is re-thrown as-is under
 * **both** policies — a config bug is never masked as a 503 or silently admitted.
 */
const rateLimit =
    <Context>(limiter: LimiterResolver<Context>, name: string, options: RateLimitMiddlewareOptions<Context> = {}): Middleware<Context, Context> =>
    async ({ ctx, next }) => {
        let status;

        try {
            const resolved = typeof limiter === "function" ? await limiter(ctx) : limiter;

            status = await resolved.limit(name, { count: options.count, key: resolveKey(name, ctx, options.key) });
        } catch (error) {
            // Deterministic caller misuse (unconfigured limit, non-positive
            // count, a count that exceeds capacity) is thrown as an INTERNAL
            // LunoraError — a permanent config bug, not a store outage. Surface
            // it as-is rather than masking it behind a 503 (fail closed) or,
            // worse, silently admitting every request (fail open). Only genuine
            // availability failures fall through to the policy below.
            if (isLunoraError(error) && isInternalCode(error.code)) {
                throw error;
            }

            // No logger available at this layer; emit via console so the host
            // captures the failure regardless of platform (workerd, Node).
            // eslint-disable-next-line no-console -- intentional: no injected logger
            console.error(`@lunora/ratelimit: rateLimit("${name}") threw; ${options.failOpen ? "failing open" : "failing closed"}`, error);

            if (options.failOpen) {
                return next();
            }

            throw new LunoraError("SERVICE_UNAVAILABLE", `rate limiter unavailable for "${name}"`, { cause: error, status: 503 });
        }

        if (!status.ok) {
            const reason = status.reason ?? "rate";
            const mapped = STATUS_BY_REASON[reason];
            const retryAfterMs = Number.isFinite(status.retryAfter) ? Math.ceil(status.retryAfter) : undefined;

            throw new LunoraError(mapped.code, options.message ?? defaultMessage(name, reason, retryAfterMs), {
                status: mapped.status,
                // `retryAfterMs` — the key `protocol/fixtures/rpc.json`, the
                // reference client and all eight SDK ports read. `TOO_MANY_REQUESTS`
                // is a transient replay code, so a durable write denied here is
                // re-queued and only the hint schedules the next attempt: sending
                // it under any other name strands the write until the outbox
                // evicts it.
                data: retryAfterMs === undefined ? undefined : { retryAfterMs },
            });
        }

        return next();
    };

export type { LimiterResolver, RateLimitMiddlewareOptions };
export { rateLimit, STATUS_BY_REASON };
