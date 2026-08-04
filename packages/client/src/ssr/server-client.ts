import { LunoraClient } from "../lunora-client";

/** Options accepted by {@link createServerClient}. */
export interface ServerClientOptions {
    /**
     * `fetch` implementation used for HTTP RPC. Defaults to the ambient global
     * `fetch` (present in Node 18+, Workers, and meta-framework SSR runtimes).
     * Pass one explicitly to forward cookies/headers or to use an instrumented
     * fetch.
     */
    fetch?: typeof fetch;

    /**
     * Bearer token sent as `Authorization: Bearer <token>` on every RPC. In an
     * SSR loader you typically read this from the request (e.g. the session
     * resolved by `getServerSession`) and pass it here so the server-side
     * load runs as the signed-in user — and so the client subscription that
     * resumes after hydration carries the same identity.
     */
    token?: string;

    /** Base URL of the deployed Lunora worker, e.g. `https://app.example.workers.dev`. */
    url: string;
}

/**
 * Build a request-scoped {@link LunoraClient} for use inside an SSR loader. SSR
 * data loading only ever calls `.query()` (HTTP RPC over `fetch`); a
 * `LunoraClient` opens a socket lazily on `.subscribe()`/`.stream()` and those
 * are never called server-side, so no live connection is established even if the
 * server runtime happens to expose a global `WebSocket`.
 *
 * Create one per request rather than sharing a module-level instance: the bearer
 * token (and any forwarded cookies in `fetch`) are per-user, and a shared client
 * would leak one request's identity into another.
 *
 * This is the framework-neutral home of the helper that previously lived only in
 * `@lunora/react/server`; the React server module re-exports the same surface so
 * existing imports keep working.
 */
export const createServerClient = (options: ServerClientOptions): LunoraClient => {
    // `fetch` falls back to the ambient global inside LunoraClient when omitted.
    const client = new LunoraClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};
