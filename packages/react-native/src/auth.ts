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
//     via the app scheme) you pass to `createAuthClient`.
//   - `setupExpoFocusManager` / `setupExpoOnlineManager` — point TanStack Query's
//     focus / online managers at Expo's `AppState` / `Network` signals so Query
//     fires its "refocused / back online" refetch events under React Native.
export { expoClient, setupExpoFocusManager, setupExpoOnlineManager } from "@better-auth/expo/client";
