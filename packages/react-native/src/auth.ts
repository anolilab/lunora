import { expoClient as expoClientUpstream } from "@better-auth/expo/client";
import type { BetterAuthClientPlugin } from "better-auth/client";

/**
 * The slice of a key/value store the better-auth Expo plugin needs — the shape
 * of `expo-secure-store` (a synchronous `getItem`, plus `setItem`). Pass Expo
 * `SecureStore` straight in.
 * @experimental
 */
export interface SecureStorageLike {
    getItem: (key: string) => null | string;
    setItem: (key: string, value: string) => unknown;
}

// `expoBearerToken` lives in its own Expo-free module so it stays unit-testable
// without loading `@better-auth/expo/client` (Expo native modules) below.
export { default as expoBearerToken } from "./bearer";

// Re-export the better-auth Expo building blocks so a native app wires auth from
// a single import (`@lunora/react-native/auth`) rather than reaching for
// `@better-auth/expo/client` directly:
//   - `expoClient` — the client plugin (session persisted in SecureStore, OAuth
//     via the app scheme) you pass to `createAuthClient`. Re-typed below; see
//     {@link ExpoClientPlugin}.
//   - `setupExpoFocusManager` / `setupExpoOnlineManager` — point TanStack Query's
//     focus / online managers at Expo's `AppState` / `Network` signals so Query
//     fires its "refocused / back online" refetch events under React Native.
export { setupExpoFocusManager, setupExpoOnlineManager } from "@better-auth/expo/client";

/** The actions `expoClient` contributes to the auth client. */
export interface ExpoClientActions {
    /** The session cookie persisted in `SecureStore`, as a `name=value; …` string. */
    getCookie: () => string;
}

/**
 * `expoClient`'s plugin type, restated so it satisfies `BetterAuthClientPlugin`.
 *
 * From better-auth 1.6.24 through 1.7.0-rc.2, `@better-auth/expo`'s own declaration
 * does not: its `getActions` types the `$fetch` parameter as a *different*
 * `BetterFetch` instantiation than the interface requires, and under
 * `strictFunctionTypes` parameter contravariance rejects the assignment — so
 * `createAuthClient({ plugins: [expoClient(…)] })` fails to typecheck with a TS2322
 * whose error text is several hundred characters of generic-inference expansion.
 * The knock-on is a TS2345 wherever the inferred `getCookie` action is then read.
 *
 * The base has to stay upstream's own return type, with only `getActions` replaced:
 * better-auth infers the whole client API (`signIn`, `signUp`, the session shape)
 * from the literal plugin members, so rebuilding the type on top of
 * `BetterAuthClientPlugin` instead — or merely intersecting with it — collapses that
 * inference to `never` and the errors reappear as "Property 'signIn' does not exist".
 * The replacement takes its parameters from better-auth's interface (making the
 * assignment trivially valid) and returns {@link ExpoClientActions}, which is what
 * keeps `authClient.getCookie()` typed for `expoBearerToken`. Runtime behaviour
 * is untouched — this is a declaration-level correction of an upstream bug.
 *
 * Delete this shim (and re-export `expoClient` directly) once upstream's
 * `getActions` signature matches the interface again.
 * @experimental
 */
export type ExpoClientPlugin = Omit<ReturnType<typeof expoClientUpstream>, "getActions"> & {
    getActions: (...arguments_: Parameters<NonNullable<BetterAuthClientPlugin["getActions"]>>) => ExpoClientActions;
};

/**
 * The better-auth Expo client plugin — session persisted in `SecureStore`, OAuth via
 * the app scheme. Pass it to `createAuthClient({ plugins: [expoClient({ scheme, storage })] })`.
 * @experimental
 */
export const expoClient = expoClientUpstream as unknown as (options: Parameters<typeof expoClientUpstream>[0]) => ExpoClientPlugin;
