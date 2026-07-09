import type { AuthHeadersFactory } from "./types";

/**
 * The slice of a key/value store the better-auth Expo plugin needs — the shape
 * of `expo-secure-store` (a synchronous `getItem`, plus `setItem`). Pass Expo
 * `SecureStore` straight in.
 */
export interface SecureStorageLike {
    getItem: (key: string) => null | string;
    setItem: (key: string, value: string) => unknown;
}

/**
 * Adapt a better-auth Expo client into the `AuthHeadersFactory` that
 * `createLunoraClient`'s `getAuthHeaders` expects: it reads the stored session
 * cookie via `getCookie()` and returns it as a `Cookie` header (or `undefined`
 * when signed out, so anonymous requests carry no credential). Lunora's
 * `resolveIdentity` reads that cookie through better-auth's `getSession`,
 * authenticating both HTTP RPC and the live WebSocket. See the package README
 * for the full `createAuthClient` + `createLunoraClient` wiring.
 */
export const expoAuthHeaders =
    (authClient: { getCookie: () => string }): AuthHeadersFactory =>
    () => {
        const cookie = authClient.getCookie();

        return cookie ? { Cookie: cookie } : undefined;
    };

// Re-export the better-auth Expo building blocks so a native app wires auth from
// a single import (`@lunora/react-native/auth`) rather than reaching for
// `@better-auth/expo/client` directly:
//   - `expoClient` — the client plugin (session persisted in SecureStore, OAuth
//     via the app scheme) you pass to `createAuthClient`.
//   - `setupExpoFocusManager` / `setupExpoOnlineManager` — point TanStack Query's
//     focus / online managers at Expo's `AppState` / `Network` signals so Query
//     fires its "refocused / back online" refetch events under React Native.
export { expoClient, setupExpoFocusManager, setupExpoOnlineManager } from "@better-auth/expo/client";
