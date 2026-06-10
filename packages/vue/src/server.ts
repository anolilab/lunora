import { CirrusClient } from "@cirrus/client";

/**
 * Server-side data-loading helpers for the Vue adapter.
 *
 * This module opens no WebSocket and touches no browser globals, so it is safe
 * to import from a Nuxt/Nitro server route, a SvelteKit `load`, or any SSR
 * context. It is the framework-neutral seam every reactive loader runs through:
 * build a request-scoped client, `preloadQuery`, serialize the `Preloaded`
 * token into the HTML, then hand it to `hydratePreloaded` on the client.
 *
 * (Once `@cirrus/ssr` lands in PLAN4 M1 these will re-export from there; the
 * surface — `createServerClient` + `preloadQuery` — is intentionally identical
 * so the migration is a single import swap with no call-site changes.)
 */

/** Options accepted by {@link createServerClient}. */
export interface ServerClientOptions {
    /**
     * `fetch` implementation used for HTTP RPC. Defaults to the ambient global
     * `fetch`. Pass one explicitly to forward the incoming request's `Cookie`
     * header so the SSR load runs under the browser's session (identity
     * continuity, PLAN4 §5 #2).
     */
    fetch?: typeof fetch;

    /** Bearer token sent as an `Authorization: Bearer` header on every RPC. */
    token?: string;

    /** Base URL of the deployed Cirrus worker, e.g. `https://app.example.workers.dev`. */
    url: string;
}

/**
 * Build a request-scoped {@link CirrusClient} for use inside an SSR loader. SSR
 * data loading only ever calls `.query()` (HTTP RPC over `fetch`); the socket is
 * opened lazily on `.subscribe()`/`.stream()`, which never run server-side, so
 * no live connection is established.
 *
 * Create one per request rather than sharing a module-level instance — the
 * bearer token and any forwarded cookies are per-user, and a shared client would
 * leak one request's identity into another.
 */
export const createServerClient = (options: ServerClientOptions): CirrusClient => {
    const client = new CirrusClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};

export type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "@cirrus/client";
// `preloadQuery` runs the query once over HTTP RPC and captures a serializable
// `Preloaded` token; `preloadedQueryResult` reads its value without subscribing.
export { preloadedQueryResult, preloadQuery } from "@cirrus/client";
