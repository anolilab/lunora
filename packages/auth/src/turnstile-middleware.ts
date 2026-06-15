import type { Middleware } from "@cirrus/server";

import type { FetchLike } from "./turnstile";
import { verifyTurnstile } from "./turnstile";

interface VerifyTurnstileMiddlewareOptions<Context> {
    /**
     * Behavior when the siteverify call itself throws (network error, non-2xx).
     * Defaults to `false` (**fail closed**: reject with 403). Set `true` only
     * when degraded availability is preferable to denying traffic — a failing
     * siteverify then admits every request. Mirrors `@cirrus/ratelimit`'s
     * `rateLimit` failure policy.
     */
    failOpen?: boolean;

    /**
     * Inject a `fetch` implementation (forwarded to {@link verifyTurnstile}).
     * Primarily for tests.
     */
    fetch?: FetchLike;
    /** Override the error message thrown on a failed verdict. */
    message?: string;

    /**
     * Selector that pulls the visitor IP from `ctx` (the procedure context has
     * no raw `Headers`, so this must come from `args`/ctx). Optional.
     */
    remoteip?: (context: Context) => string | undefined;
    /** Your Turnstile secret key (the `TURNSTILE_SECRET_KEY` env var). */
    secret: string;

    /**
     * Selector that pulls the `cf-turnstile-response` token from `ctx`. The
     * procedure context carries only the resolved identity, **not** the raw
     * inbound `Headers` (see `withAuthPlugins` in `./middleware`), so the token
     * must travel in the function `args` and be read out here.
     */
    token: (context: Context) => string | undefined;
}

/**
 * Procedure middleware that enforces a Turnstile (CAPTCHA) check before the
 * handler runs. Attach it with `.use()`. It reads the token (and optional IP)
 * from `ctx` via the provided selectors — because the procedure context does
 * not carry raw request headers, the token must be passed through the function
 * `args`. To gate the better-auth sign-in/sign-up flow itself, prefer
 * better-auth's native `captcha` plugin (re-exported from `@cirrus/auth/plugins`)
 * — this middleware is for non-auth Cirrus procedures.
 *
 * On a `success: false` verdict (or a missing token) it throws a structural
 * `CirrusError` (`{ name: "CirrusError", code: "FORBIDDEN", status: 403 }`) —
 * the runtime maps it to the matching RPC/HTTP status without any runtime
 * import of `@cirrus/server` (the `Middleware` import is type-only).
 *
 * **Failure policy:** if the siteverify call itself throws, the middleware
 * **fails closed by default** (logs and rejects with 403). Pass
 * `failOpen: true` to admit the request instead — mirrors `@cirrus/ratelimit`.
 */
export const verifyTurnstileMiddleware =
    <Context>(options: VerifyTurnstileMiddlewareOptions<Context>): Middleware<Context, Context> =>
    async ({ ctx, next }) => {
        const token = options.token(ctx);

        if (token === undefined || token === "") {
            throw Object.assign(new Error(options.message ?? "turnstile token missing"), {
                code: "FORBIDDEN",
                name: "CirrusError",
                status: 403,
            });
        }

        let result;

        try {
            result = await verifyTurnstile({
                fetch: options.fetch,
                remoteip: options.remoteip?.(ctx),
                secret: options.secret,
                token,
            });
        } catch (error) {
            // No logger available at this layer; emit via console so the host
            // captures the failure regardless of platform (workerd, Node).
            // eslint-disable-next-line no-console -- intentional: no injected logger
            console.error(`@cirrus/auth: verifyTurnstileMiddleware siteverify threw; ${options.failOpen ? "failing open" : "failing closed"}`, error);

            if (options.failOpen) {
                return next();
            }

            throw Object.assign(new Error(options.message ?? "turnstile verification unavailable"), {
                cause: error,
                code: "FORBIDDEN",
                name: "CirrusError",
                status: 403,
            });
        }

        if (!result.success) {
            throw Object.assign(new Error(options.message ?? "turnstile verification failed"), {
                code: "FORBIDDEN",
                errorCodes: result.errorCodes,
                name: "CirrusError",
                status: 403,
            });
        }

        return next();
    };

export type { VerifyTurnstileMiddlewareOptions };
