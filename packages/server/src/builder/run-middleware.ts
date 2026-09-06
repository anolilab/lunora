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

        // A holder rather than a plain `let`: the flag is written inside `next`,
        // and control-flow analysis would otherwise pin a local to its
        // initializer and read the check below as statically true.
        const advanced = { byThisLink: false };

        const next = ((options?: { ctx: Record<string, unknown> }) => {
            advanced.byThisLink = true;

            return dispatch(index + 1, options?.ctx ? { ...(context as Record<string, unknown>), ...options.ctx } : context);
        }) as MiddlewareNext<unknown>;

        const result = await middleware({ ctx: context, next });

        if (!advanced.byThisLink) {
            throw new LunoraError(
                "INTERNAL",
                `middleware at position ${String(index)} resolved without calling next(): every later .use() step (rls/mask/storageRules) and the handler's context were skipped. Return next() — or next({ ctx }) to extend the context — and throw to deny.`,
            );
        }

        return result;
    };

    return dispatch(0, baseContext);
};

export default runMiddlewareChain;
