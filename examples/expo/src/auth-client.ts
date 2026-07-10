import { expoClient } from "@lunora/react-native/auth";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

/** Where the Lunora worker (and its `/api/auth/*` routes) lives. */
export const LUNORA_URL = process.env.EXPO_PUBLIC_LUNORA_URL ?? "http://localhost:8787";

/**
 * better-auth React client wired for Expo. The Expo plugin persists the session
 * cookie in `SecureStore` (surviving app restarts, since React Native has no
 * cookie jar) and exposes `getCookie()`, which `src/lunora.ts` bridges into the
 * Lunora client so the live socket and RPC calls run as the signed-in user.
 *
 * `scheme` must match `app.json` → `expo.scheme` and the server's trusted origin
 * (`lunora/auth.ts`).
 */
export const authClient = createAuthClient({
    baseURL: LUNORA_URL,
    plugins: [expoClient({ scheme: "expoexample", storage: SecureStore })],
});
