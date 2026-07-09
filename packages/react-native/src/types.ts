import type { AsyncStorageLike, LunoraClientOptions } from "@lunora/client";

/**
 * A `() => headers` factory the React Native client threads onto every HTTP RPC
 * request *and* the WebSocket upgrade. It exists because React Native has no
 * shared cookie jar the way a browser does: the session credential lives in the
 * app's own storage (Expo `SecureStore`, better-auth's Expo plugin, …) and must
 * be attached explicitly. Return `undefined` (or an empty object) when signed
 * out so anonymous requests carry no stale credential.
 *
 * The typical wiring pairs this with `@lunora/react-native/auth`'s
 * `expoAuthHeaders`, which reads the better-auth Expo cookie (see the package
 * README for the full example).
 */
export type AuthHeadersFactory = () => Record<string, string> | undefined;

/**
 * Options for `createLunoraClient` — the React Native / Expo counterpart to
 * constructing a `LunoraClient` directly. It is `LunoraClientOptions` with two
 * React-Native-shaped conveniences layered on. `storage` wires the
 * AsyncStorage-backed offline-queue persistence for you (the browser default
 * auto-probes IndexedDB, which React Native lacks, so without this the queue
 * stays in memory and is lost on reload). `getAuthHeaders` attaches a credential
 * to both the HTTP RPC path and the WebSocket upgrade, since React Native has no
 * cookie jar to do it implicitly.
 *
 * The `persistence`, `fetch`, and `WebSocket` fields of `LunoraClientOptions`
 * are still accepted and take precedence when you need full control; the two
 * conveniences are sugar over exactly those seams.
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
     * map in tests). When supplied, the offline mutation queue is persisted here
     * via `createAsyncStoragePersistence`, so writes made offline survive an app
     * restart. Ignored when an explicit `persistence` is passed.
     */
    storage?: AsyncStorageLike;
}
