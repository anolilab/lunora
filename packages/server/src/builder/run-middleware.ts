import type { Middleware, MiddlewareNext } from "./types";

/**
 * Shared onion executor for a middleware chain. Each middleware receives `next`,
 * which advances to the following link; a `{ ctx }` argument shallow-merges into
 * the context handed to the rest of the chain. Calling `next()` twice for the
 * same link is a programming error and throws (`lastIndex` tripwire) — the one
 * guard both the builder's `.use()` chain and the plugin-middleware composer
 * must share so they behave identically.
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
            throw new Error("middleware next() called multiple times");
        }

        lastIndex = index;

        const middleware = middlewares[index];

        if (!middleware) {
            return terminal(context);
        }

        const next = ((options?: { ctx: Record<string, unknown> }) =>
            dispatch(index + 1, options?.ctx ? { ...(context as Record<string, unknown>), ...options.ctx } : context)) as MiddlewareNext<unknown>;

        return await middleware({ ctx: context, next });
    };

    return dispatch(0, baseContext);
};

export default runMiddlewareChain;
