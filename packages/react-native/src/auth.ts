// `expoBearerToken` lives in its own Expo-free module so it stays unit-testable
// without loading `@better-auth/expo/client` (Expo native modules) below.
export { default as expoBearerToken } from "./bearer";

/**
 * The slice of a key/value store the better-auth Expo plugin needs. Pass Expo
 * `SecureStore` straight in.
 *
 * Re-exported from `@better-auth/expo/client` rather than restated here. This
 * used to be a hand-written `SecureStorageLike` mirroring what upstream needed
 * — two synchronous methods — and better-auth 1.7 moved the Expo storage
 * integration to asynchronous `SecureStore` methods, so the real shape is now
 * `getItem` + `getItemAsync` + `setItem` + `setItemAsync`. A hand-written
 * mirror does not fail when upstream widens like that; it just silently
 * describes a store the plugin will not accept. Re-exporting makes the
 * compiler track it, which is the same lesson the `getCookie` shim taught in
 * this file's history.
 * @experimental
 */
export type { ExpoClientStorage } from "@better-auth/expo/client";

// Re-export the better-auth Expo building blocks so a native app wires auth from
// a single import (`@lunora/react-native/auth`) rather than reaching for
// `@better-auth/expo/client` directly:
//   - `expoClient` — the client plugin (session persisted in SecureStore, OAuth
//     via the app scheme) you pass to `createAuthClient`.
//   - `setupExpoFocusManager` / `setupExpoOnlineManager` — point TanStack Query's
//     focus / online managers at Expo's `AppState` / `Network` signals so Query
//     fires its "refocused / back online" refetch events under React Native.
//
// `expoClient` was re-typed here from better-auth 1.6.24 through 1.7.0-rc.2: its
// `getActions` declared the `$fetch` parameter as a different `BetterFetch`
// instantiation than `BetterAuthClientPlugin` requires, and under
// `strictFunctionTypes` parameter contravariance rejected the assignment, so
// `createAuthClient({ plugins: [expoClient(…)] })` failed to typecheck. 1.7.1
// fixed the declaration upstream, so the shim (and the `ExpoClientPlugin` /
// `ExpoClientActions` types that existed only to express it) is gone and the
// plugin is re-exported directly. GA also made `getCookie` async, which the
// shim's hand-written `() => string` had been masking — see `./bearer`, whose
// argument is typed structurally and now awaits it.
export { expoClient, setupExpoFocusManager, setupExpoOnlineManager } from "@better-auth/expo/client";
