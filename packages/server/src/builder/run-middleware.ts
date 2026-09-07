import { LunoraError } from "@lunora/errors";

import type { Middleware, MiddlewareNext } from "./types";

/**
 * Shared onion executor for a middleware chain. Each middleware receives `next`,
 * which advances to the following link; a `{ ctx }` argument shallow-merges into
 * the context handed to the rest of the chain. Calling `next()` twice for the
 * same link is a programming error and throws (`lastIndex` tripwire) — the one
 * guard both the builder's `.use()` chain and the plugin-middleware composer
 * must share so they behave identically.
 *
 * Resolving WITHOUT calling `next()` is the same class of error and throws too.
 * A middleware is not a short-circuit: the chain's terminal is what produces the
 * handler's context, so a link that returns `ctx` instead of `next()` skipped
 * every later `.use()` — `rls()`, `mask()`, `storageRules()` — and the handler
 * then ran against the UNWRAPPED `ctx.db` while `fn.rls` stayed hoisted, so
 * studio and the shape registry still reported the procedure as guarded. That is
 * a silent authorization bypass, and returning `undefined` instead only turned it
 * into a bare `TypeError` deeper in the handler. To deny a request, THROW (a
 * `LunoraError("FORBIDDEN")`); to change the context, `return next({ ctx })`.
 *
 * Calling `next()` without awaiting it (`void next(); return ctx;`) is the same
 * bypass one step subtler — the call happened, but the chain would resolve while
 * the rest of it is still running. A link that never read its `next()` result is
 * therefore held open until the downstream chain settles, and a rejection it
 * dropped is propagated rather than left to detach (see `next` below).
 *
 * `terminal` runs when the chain is exhausted, with the fully accumulated
 * context: the builder returns it verbatim; the plugin composer hands it to the
 * surrounding builder's own `next` so the composed unit is transparent.
 */
const runMiddlewareChain = async (
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
    baseContext: unknown,
    terminal: (context: unknown) => unknown,
): Promise<unknown> => {
    let lastIndex = -1;

    const dispatch = async (index: number, context: unknown): Promise<unknown> => {
        if (index <= lastIndex) {
            throw new LunoraError("INTERNAL", "middleware next() called multiple times");
        }

        lastIndex = index;

        const middleware = middlewares[index];

        if (!middleware) {
            return terminal(context);
        }

        // A holder rather than plain `let`s: both fields are written inside
        // `next`, and control-flow analysis would otherwise pin a local to its
        // initializer and read the checks below as statically true.
        const downstream: { observed: boolean; promise: Promise<unknown> | undefined } = { observed: false, promise: undefined };

        const next = ((options?: { ctx: Record<string, unknown> }) => {
            const running = dispatch(index + 1, options?.ctx ? { ...(context as Record<string, unknown>), ...options.ctx } : context);

            downstream.promise = running;

            // Hand back a thenable rather than `running` itself. Whether the
            // middleware READ the downstream result is the one bit that separates
            // the two shapes below, and a bare native promise offers no hook to
            // observe it — `await p` unwraps a native promise through an internal
            // slot, never through its `then`. A plain thenable has no such slot,
            // so `await` has to go through the `then` below, which is the signal.
            //
            //   `return await next()`, or `try { return await next() } catch
            //   { return fallback }` — observed. The middleware owns the outcome,
            //   including a rejection it deliberately swallowed; awaiting
            //   `downstream.promise` again below would re-throw what it just
            //   handled and break error-handling middleware.
            //
            //   `void next(); return ctx;` — NOT observed. Only the flag was set,
            //   so the old guard passed while the chain resolved early: the handler
            //   ran against a context the later `.use()` steps had not finished
            //   building, and a downstream rejection detached into an unhandled
            //   rejection. That is the case the await below closes.
            //
            // A `Proxy` over `running` is the other way to see the read, and the
            // one this started as; it measured ~15% slower per guarded call than
            // the literal, on a path `__bench__/rls-overhead.bench.ts` watches.
            const observable: Promise<unknown> = {
                [Symbol.toStringTag]: "Promise",
                catch: (onRejected) => {
                    downstream.observed = true;

                    return running.catch(onRejected);
                },
                finally: (onFinally) => {
                    downstream.observed = true;

                    return running.finally(onFinally);
                },
                // eslint-disable-next-line unicorn/no-thenable -- deliberate: `then` IS the interface here, and being awaited through it rather than unwrapped as a native promise is the whole mechanism
                then: (onFulfilled, onRejected) => {
                    downstream.observed = true;

                    return running.then(onFulfilled, onRejected);
                },
            };

            return observable;
        }) as MiddlewareNext<unknown>;

        const result = await middleware({ ctx: context, next });

        if (!downstream.promise) {
            throw new LunoraError(
                "INTERNAL",
                `middleware at position ${String(index)} resolved without calling next(): every later .use() step (rls/mask/storageRules) and the handler's context were skipped. Return next() — or next({ ctx }) to extend the context — and throw to deny.`,
            );
        }

        if (!downstream.observed) {
            await downstream.promise;
        }

        return result;
    };

    return dispatch(0, baseContext);
};

export default runMiddlewareChain;
