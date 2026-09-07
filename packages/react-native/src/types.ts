import type { AsyncStorageLike, LunoraClientOptions } from "@lunora/client";

/**
 * A `() => headers` factory the React Native client threads onto every HTTP RPC
 * request *and* the WebSocket upgrade — a generic escape hatch for attaching a
 * **custom** credential header (an API-gateway key, a proxy token, …) that
 * React Native's missing cookie jar can't carry implicitly. Return `undefined`
 * (or an empty object) when there's nothing to attach.
 *
 * For better-auth Expo sessions, prefer a **bearer** token instead: read it with
 * `@lunora/react-native/auth`'s `expoBearerToken` and feed it to
 * `client.setAuthToken` / `setWsToken` (see the package README). A bearer avoids
 * the `Cookie` header the runtime's CSRF guard rejects on `Origin`-less native
 * requests.
 * @experimental
 */
export type AuthHeadersFactory = () => Record<string, string> | undefined;

/**
 * Options for `createLunoraClient` — the React Native / Expo counterpart to
 * constructing a `LunoraClient` directly. It is `LunoraClientOptions` with two
 * React-Native-shaped conveniences layered on. `storage` wires the
 * AsyncStorage-backed offline-queue persistence for you (the browser default
 * auto-probes IndexedDB, which React Native lacks, so without this the queue
 * stays in memory and is lost on reload). `getAuthHeaders` is a generic escape
 * hatch for a custom credential header on both the HTTP RPC path and the
 * WebSocket upgrade; for better-auth sessions prefer a bearer token
 * (`expoBearerToken` + the client's `setAuthToken` / `setWsToken`).
 *
 * The `persistence`, `fetch`, and `WebSocket` fields of `LunoraClientOptions`
 * are still accepted and take precedence when you need full control; the two
 * conveniences are sugar over exactly those seams.
 * @experimental
 */
export interface CreateLunoraClientOptions extends LunoraClientOptions {
    /**
     * Attaches a credential to every HTTP RPC request and to the WebSocket
     * upgrade request. See `AuthHeadersFactory`. When omitted, requests go out
     * with only whatever `LunoraClient` already sets (its bearer token from
     * `setAuthToken`, if any).
     *
     * Merged UNDER the client's own headers on the HTTP path (an explicit
     * `setAuthToken` bearer wins over a same-named header here); applied to the
     * WebSocket upgrade via a wrapping `WebSocket`, since the socket has no other
     * way to carry credentials in React Native.
     */
    getAuthHeaders?: AuthHeadersFactory;

    /**
     * React Native `AsyncStorage` (or any async key/value store with the same
     * `getItem`/`setItem`/`removeItem` surface — Expo `SecureStore`, an in-memory
     * map in tests). When supplied it backs two independent caches: the offline
     * mutation queue (via `createAsyncStoragePersistence`, so writes made offline
     * survive an app restart) and the durable query cache (via
     * `createAsyncStorageQueryCache`, so reads repaint before the socket
     * reconnects).
     *
     * Each is opted out of by its own option, not by the other: `persistence`
     * overrides the queue and `queryCache` overrides the read cache, so
     * `{ persistence: false, storage }` still writes query results to storage.
     */
    storage?: AsyncStorageLike;
}
