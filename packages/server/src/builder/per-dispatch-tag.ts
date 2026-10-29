/**
 * Mark a middleware as having a PER-DISPATCH effect: something that must happen
 * once per request and that the response alone does not carry. Consuming rate
 * limiter budget is the motivating case; burning a single-use captcha token is
 * the same shape.
 *
 * The reactive query cache is what reads this. A cache HIT answers without
 * running the dispatch callback, and a procedure's `.use()` chain runs INSIDE
 * that callback (it is part of the registered function's own handler) — so a
 * memoized query consumed limiter budget on its first dispatch and on none of
 * the ones after, while every one of them still reached the Durable Object. The
 * builder hoists this tag onto the registered function as `perDispatch: true`
 * and the emitted `isCacheableQuery` refuses such a function, exactly as it
 * already refuses an `internal` one whose refusal a hit would skip.
 *
 * Tagging the middleware FUNCTION rather than deriving the answer statically is
 * what makes it truthful: the chain is assembled at runtime (a shared base
 * builder, a `protectPublic` bundle, a plugin composer), and an AST-side guess
 * that missed one would fail open on a security control.
 *
 * Non-enumerable and `Symbol.for`-keyed for the same two reasons as the `rls()`
 * tag next to it: it never leaks into a spread of the middleware, and two
 * independently-bundled copies of `@lunora/server` still agree on the key.
 */

const PER_DISPATCH_TAG = Symbol.for("lunora.middleware.per-dispatch");

/**
 * Mark a middleware as per-dispatch. Returns the same reference, so a factory
 * can `return tagPerDispatchMiddleware(async ({ ctx, next }) => …)`.
 */
const tagPerDispatchMiddleware = <M extends object>(middleware: M): M => {
    Object.defineProperty(middleware, PER_DISPATCH_TAG, { configurable: true, enumerable: false, value: true });

    return middleware;
};

/** Whether a middleware carries the per-dispatch mark. `false` for anything else. */
const isPerDispatchMiddleware = (middleware: unknown): boolean => {
    if (middleware === null || (typeof middleware !== "function" && typeof middleware !== "object")) {
        return false;
    }

    return (middleware as Record<PropertyKey, unknown>)[PER_DISPATCH_TAG] === true;
};

export { isPerDispatchMiddleware, tagPerDispatchMiddleware };
