import type { CirrusClient } from "./cirrus-client.js";
import type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "./types.js";

/**
 * Run a query once on the server (during SSR) and capture its result in a
 * serializable {@link Preloaded} token. Embed the token in the rendered HTML and
 * pass it to `usePreloadedQuery` on the client: the first client render shows
 * the server value with no loading flash, then a live subscription takes over.
 *
 * The query is executed through the supplied {@link CirrusClient} over the same
 * HTTP RPC path the browser uses, so the SSR client only needs a `fetch`
 * implementation that can reach the worker — no in-process Durable Object access.
 */
export const preloadQuery = async <F extends FunctionReference>(
    client: CirrusClient,
    fn: F,
    args: ArgsOf<F>,
    opts: { shardKey?: string } = {},
): Promise<Preloaded<ReturnOf<F>>> => {
    const value = await client.query(fn, args, opts);

    return {
        __cirrusPreloaded: true,
        args: (args ?? {}) as Record<string, unknown>,
        functionPath: fn.__cirrusRef,
        shardKey: opts.shardKey,
        value,
    };
};

/**
 * Read the captured value out of a {@link Preloaded} token without subscribing.
 * Useful on the server (or in tests) when you only need the data, not a live feed.
 */
export const preloadedQueryResult = <T>(preloaded: Preloaded<T>): T => preloaded.value;
