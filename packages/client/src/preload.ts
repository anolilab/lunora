import type { CirrusClient } from "./cirrus-client";
import type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "./types";

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
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): Promise<Preloaded<ReturnOf<F>>> => {
    const value = await client.query(function_, args, options);

    return {
        __cirrusPreloaded: true,
        args: args ?? {},
        functionPath: function_.__cirrusRef,
        shardKey: options.shardKey,
        value,
    };
};

/**
 * Read the captured value out of a {@link Preloaded} token without subscribing.
 * Useful on the server (or in tests) when you only need the data, not a live feed.
 */
export const preloadedQueryResult = <T>(preloaded: Preloaded<T>): T => preloaded.value;
