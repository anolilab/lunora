import type { SecureStorageLike } from "@lunora/react-native/auth";
import { expoClient } from "@lunora/react-native/auth";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * The app's URL scheme — must match `app.json` → `expo.scheme` and the server's
 * trusted origin (`lunora/auth.ts`). Change all three together when you rename
 * the app.
 */
const APP_SCHEME = "lunorachat";

/** Where the Lunora worker (and its `/api/auth/*` routes) lives. */
export const LUNORA_URL = process.env.EXPO_PUBLIC_LUNORA_URL ?? "http://localhost:8787";

/**
 * `expo-secure-store` has no web implementation, so on web we persist the
 * session through `localStorage` instead. On native the session lives in the OS
 * keychain/keystore; on web the browser's cookie jar also carries it, so this
 * only needs to persist what `expoClient` reads back via `getCookie()`.
 */
const sessionStore: SecureStorageLike =
    Platform.OS === "web"
        ? {
              getItem: (key) => (typeof localStorage === "undefined" ? null : localStorage.getItem(key)),
              setItem: (key, value) => {
                  if (typeof localStorage !== "undefined") {
                      localStorage.setItem(key, value);
                  }
              },
          }
        : SecureStore;

/**
 * better-auth React client wired for Expo. The Expo plugin persists the session
 * cookie in the store above (surviving app restarts, since React Native has no
 * cookie jar) and exposes `getCookie()`, which `src/lunora.ts` bridges into the
 * Lunora client so the live socket and RPC calls run as the signed-in user.
 */
export const authClient = createAuthClient({
    baseURL: LUNORA_URL,
    plugins: [expoClient({ scheme: APP_SCHEME, storage: sessionStore })],
});
