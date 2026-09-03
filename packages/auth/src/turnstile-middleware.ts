import { LunoraError } from "@lunora/errors";
import type { Middleware } from "@lunora/server";

import type { FetchLike, TurnstileVerifyResult } from "./turnstile";
import { verifyTurnstile } from "./turnstile";

interface VerifyTurnstileMiddlewareOptions<Context> {
    /**
     * Assert the widget `action` the token was solved for (forwarded to
     * {@link verifyTurnstile}). When set and the siteverify response's `action`
     * does not match, the verdict is treated as a failure (403). Optional.
     */
    expectedAction?: string;

    /**
     * Assert the `hostname` the challenge was solved on (forwarded to
     * {@link verifyTurnstile}). When set and the siteverify response's `hostname`
     * does not match, the verdict is treated as a failure (403). Set this when a
     * single secret/sitekey is shared across multiple domains to stop a token
     * harvested on one origin being replayed against this procedure. Optional.
     */
    expectedHostname?: string;

    /**
     * Behavior when the siteverify call itself throws (network error, non-2xx).
     * Defaults to `false` (**fail closed**: reject with 403). Set `true` only
     * when degraded availability is preferable to denying traffic — a failing
     * siteverify then admits every request. Mirrors `@lunora/ratelimit`'s
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
     * Selector that pulls the visitor IP off `ctx` — typically `ctx.ip`, or
     * `ctx.args.ip` when the caller sends it (the procedure context has no raw
     * `Headers`). Optional.
     */
    remoteip?: (context: Context) => string | undefined;
    /** Your Turnstile secret key (the `TURNSTILE_SECRET_KEY` env var). */
    secret: string;

    /**
     * Selector that pulls the `cf-turnstile-response` token off `ctx`. The
     * procedure context carries only the resolved identity, **not** the raw
     * inbound `Headers` (see `withAuthPlugins` in `./middleware`), so the token
     * travels in the function `args` — which the builder surfaces to middleware
     * as `ctx.args` (validated, frozen):
     *
     * ```ts
     * export const submit = mutation
     *     .input({ message: v.string(), turnstileToken: v.string() })
     *     .use(verifyTurnstileMiddleware({ secret: env.TURNSTILE_SECRET_KEY, token: (ctx) => ctx.args.turnstileToken }))
     *     .mutation(async ({ args, ctx }) => { … });
     * ```
     */
    token: (context: Context) => string | undefined;

    /**
     * Extra predicate run on a `success: true` verdict (after the built-in
     * `expectedHostname`/`expectedAction` checks). Return `false` to reject the
     * request with 403 — use it for any custom replay/abuse guard that needs the
     * full verdict (e.g. matching `cdata`, or one hostname out of an allow-list).
     */
    validate?: (result: TurnstileVerifyResult) => boolean;
}

/**
 * Procedure middleware that enforces a Turnstile (CAPTCHA) check before the
 * handler runs. Attach it with `.use()`. It reads the token (and optional IP)
 * from `ctx` via the provided selectors — because the procedure context does
 * not carry raw request headers, the token is passed through the function
 * `args` and read back as `ctx.args.<field>` (the builder surfaces the
 * VALIDATED args on the middleware context, frozen). To gate the better-auth
 * sign-in/sign-up flow itself, prefer
 * better-auth's native `captcha` plugin (re-exported from `@lunora/auth/plugins`)
 * — this middleware is for non-auth Lunora procedures.
 *
 * On a `success: false` verdict (or a missing token) it throws a structural
 * `LunoraError` (`{ name: "LunoraError", code: "FORBIDDEN", status: 403 }`) —
 * the runtime maps it to the matching RPC/HTTP status without any runtime
 * import of `@lunora/server` (the `Middleware` import is type-only).
 *
 * **Failure policy:** if the siteverify call itself throws, the middleware
 * **fails closed by default** (logs and rejects with 403). Pass
 * `failOpen: true` to admit the request instead — mirrors `@lunora/ratelimit`.
 *
 * **Cross-origin replay:** a token solved on one origin can be replayed against
 * a different endpoint when a single secret/sitekey is shared across multiple
 * domains. Pass `expectedHostname` (and optionally `expectedAction`, or a custom
 * `validate(result)` predicate) to assert the siteverify response's `hostname`
 * /`action` and reject mismatches with 403.
 */
export const verifyTurnstileMiddleware =
    <Context>(options: VerifyTurnstileMiddlewareOptions<Context>): Middleware<Context, Context> =>
    async ({ ctx, next }) => {
        const token = options.token(ctx);

        if (token === undefined || token === "") {
            throw new LunoraError("FORBIDDEN", options.message ?? "turnstile token missing");
        }

        let result;

        try {
            result = await verifyTurnstile({
                expectedAction: options.expectedAction,
                expectedHostname: options.expectedHostname,
                fetch: options.fetch,
                remoteip: options.remoteip?.(ctx),
                secret: options.secret,
                token,
            });
        } catch (error) {
            // No logger available at this layer; emit via console so the host
            // captures the failure regardless of platform (workerd, Node).
            // eslint-disable-next-line no-console -- intentional: no injected logger
            console.error(`@lunora/auth: verifyTurnstileMiddleware siteverify threw; ${options.failOpen ? "failing open" : "failing closed"}`, error);

            if (options.failOpen) {
                return next();
            }

            throw new LunoraError("FORBIDDEN", options.message ?? "turnstile verification unavailable", { cause: error });
        }

        // `validate` is narrowed to an exact `true` — it is app code asserting the
        // hostname/action the token was minted for, and a version returning the
        // matched hostname string (or any other truthy artifact of the comparison)
        // would otherwise pass every token, including one replayed from another site.
        if (!result.success || (options.validate !== undefined && (options.validate(result) as unknown) !== true)) {
            throw new LunoraError("FORBIDDEN", options.message ?? "turnstile verification failed", {
                data: result.errorCodes.length > 0 ? { errorCodes: result.errorCodes } : undefined,
            });
        }

        return next();
    };

export type { VerifyTurnstileMiddlewareOptions };
