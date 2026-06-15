import runMiddlewareChain from "./builder/run-middleware";
import type { Middleware } from "./builder/types";

/**
 * The middlewares `protectPublic` chains, in the order they run. Every field is
 * optional, so a bundle can be just a rate limit, just a captcha, or any mix —
 * pass the already-constructed middlewares (e.g. `rateLimit(limiter, "signup")`
 * from `@lunora/ratelimit`, `verifyTurnstileMiddleware({...})` from
 * `@lunora/auth`). They are accepted as values rather than imported here so
 * `@lunora/server` keeps no dependency on those packages (which depend on it).
 */
interface ProtectPublicOptions<Context> {
    /**
     * A CAPTCHA / bot check, run after the rate limit. Placed second on purpose:
     * an obvious flood is cheaper to reject with the in-memory limiter than with
     * a Turnstile siteverify round-trip.
     */
    captcha?: Middleware<Context, Context>;

    /**
     * A rate limit, run first. Cheapest gate, so it sheds obvious abuse before
     * any network-bound check below it runs.
     */
    rateLimit?: Middleware<Context, Context>;

    /** Extra middlewares appended after `rateLimit` and `captcha`, in order. */
    use?: ReadonlyArray<Middleware<Context, Context>>;
}

/**
 * Compose the recommended public-procedure protections into a single
 * `.use()`-able middleware. It is thin sugar over middleware composition — no
 * new enforcement engine — chaining (in order) a rate limit, a CAPTCHA check,
 * and any extra middlewares so a public mutation that creates users, sends
 * mail, or consumes credits is guarded in one attachment:
 *
 * ```ts
 * export const signUp = mutation
 *   .use(protectPublic({
 *     rateLimit: rateLimit(limiter, "signup"),
 *     captcha: verifyTurnstileMiddleware({ secret: env.TURNSTILE_SECRET_KEY, token: (c) => c.args.captchaToken }),
 *   }))
 *   .handler(async (ctx, args) => { ... });
 * ```
 *
 * The bundle is context-preserving — each inner middleware leaves the context
 * unchanged — so it slots into any `.use()` chain without reshaping the
 * procedure context. Omitted fields are skipped; an empty bundle is a
 * transparent pass-through.
 */
const protectPublic = <Context>(options: ProtectPublicOptions<Context>): Middleware<Context, Context> => {
    const chain = [options.rateLimit, options.captcha, ...(options.use ?? [])].filter(
        (middleware): middleware is Middleware<Context, Context> => middleware !== undefined,
    );

    const composed: Middleware<Context, Context> = async ({ ctx, next }) =>
        runMiddlewareChain(chain as ReadonlyArray<Middleware<unknown, unknown>>, ctx, (context) =>
            next({ ctx: context as Record<string, unknown> }),
        ) as Promise<Context>;

    return composed;
};

export type { ProtectPublicOptions };
export { protectPublic };
