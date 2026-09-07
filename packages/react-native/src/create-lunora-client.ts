import { createAsyncStoragePersistence, createAsyncStorageQueryCache, LunoraClient } from "@lunora/client";

import type { AuthHeadersFactory, CreateLunoraClientOptions } from "./types";

// React Native's `WebSocket` constructor is `(uri, protocols?, options?)`; the
// DOM lib types it as two-arg, so the `{ headers }` options object rides through
// this widened constructor type and the subclass is re-cast to `typeof WebSocket`.
type WebSocketWithOptions = new (url: string | URL, protocols?: string | string[], options?: unknown) => WebSocket;

/**
 * Wrap a `fetch` so every request also carries the headers from the auth-headers
 * factory. The factory's headers are layered FIRST so the caller's own
 * per-request headers (e.g. `LunoraClient`'s `Authorization` bearer and
 * `Content-Type`) win on a key clash — the auth headers only fill gaps.
 */
export const withAuthHeaders =
    (fetchImpl: typeof fetch, getAuthHeaders: AuthHeadersFactory): typeof fetch =>
    (input, init) => {
        const extra = getAuthHeaders();

        if (!extra) {
            return fetchImpl(input, init);
        }

        // Normalise the existing headers into a plain object so we can layer the
        // auth headers *under* them (Headers/array/record are all valid inits).
        const merged = new Headers(extra);

        if (init?.headers) {
            new Headers(init.headers).forEach((value, key) => {
                merged.set(key, value);
            });
        }

        return fetchImpl(input, { ...init, headers: merged });
    };

/**
 * Build a `WebSocket` constructor that injects the auth-headers factory's
 * headers onto the upgrade request. React Native's `WebSocket` accepts a third
 * `{ headers }` options argument (unlike the browser's two-arg constructor), so
 * this is the only channel a socket has for a credential — `LunoraClient` builds
 * every socket with `new WebSocketImpl(url)`, and this subclass re-injects the
 * current headers on each (re)connect, so a token refreshed between reconnects
 * takes effect on the next socket without extra plumbing.
 */
export const withAuthWebSocket = (WebSocketImpl: typeof WebSocket, getAuthHeaders: AuthHeadersFactory): typeof WebSocket =>
    class AuthWebSocket extends (WebSocketImpl as unknown as WebSocketWithOptions) {
        public constructor(url: string | URL, protocols?: string | string[]) {
            const headers = getAuthHeaders();

            super(url, protocols, headers ? { headers } : undefined);
        }
    } as unknown as typeof WebSocket;

/**
 * Construct a `LunoraClient` tuned for React Native / Expo — a thin wrapper over
 * `new LunoraClient(options)` that fills in the three things a browser gets for
 * free but React Native does not.
 *
 * First, a durable offline queue: pass `storage` (React Native `AsyncStorage`,
 * or any async key/value store) and the offline mutation queue is persisted
 * through `createAsyncStoragePersistence` — the browser default auto-probes
 * IndexedDB, which React Native lacks, so without this the queue lives only in
 * memory and is lost on reload.
 *
 * Second, a durable read cache: the same `storage` also backs the query cache
 * through `createAsyncStorageQueryCache`, so cached reads render immediately
 * after a restart while the socket reconnects — mirroring the browser's
 * IndexedDB-backed default.
 *
 * Third, credentialed requests: pass `getAuthHeaders` and the returned headers
 * ride both the HTTP RPC path and the WebSocket upgrade, since React Native has
 * no cookie jar to attach a session implicitly.
 *
 * Everything on `LunoraClientOptions` is still accepted and passed through; an
 * explicit `persistence`, `queryCache`, `fetch`, or `WebSocket` takes precedence
 * over the convenience derived from `storage` / `getAuthHeaders`. `persistence`
 * and `queryCache` override independently — `storage` backs both, so opting out
 * of one leaves the other wired. See the package README
 * for a full setup example.
 * @experimental
 */
export const createLunoraClient = (options: CreateLunoraClientOptions): LunoraClient => {
    const { getAuthHeaders, storage, ...rest } = options;

    // Only touch `fetch`/`WebSocket` when there's an auth-headers factory to
    // inject AND the caller hasn't supplied its own transport (an explicit
    // `fetch`/`WebSocket` takes precedence). Otherwise leave them unset so
    // `LunoraClient` does its own global resolution — crucially, it binds `fetch`
    // to `globalThis`, and on the web target (`react-native-web`) an *unbound*
    // `fetch` throws `TypeError: Illegal invocation`. When we do wrap the global,
    // bind it the same way so the wrapped transport is safe on web too.
    const authedFetch =
        getAuthHeaders && rest.fetch === undefined && typeof fetch === "function" ? withAuthHeaders(fetch.bind(globalThis), getAuthHeaders) : rest.fetch;

    const authedWebSocket =
        getAuthHeaders && rest.WebSocket === undefined && typeof WebSocket === "function" ? withAuthWebSocket(WebSocket, getAuthHeaders) : rest.WebSocket;

    return new LunoraClient({
        ...rest,
        // Auto-wire AsyncStorage persistence and the durable read cache unless
        // the caller passed an explicit adapter (including `false` to opt out —
        // `false ?? x` short-circuits to `false`).
        persistence: rest.persistence ?? (storage ? createAsyncStoragePersistence({ storage }) : undefined),
        queryCache: rest.queryCache ?? (storage ? createAsyncStorageQueryCache({ storage }) : undefined),
        fetch: authedFetch,
        WebSocket: authedWebSocket,
    });
};
