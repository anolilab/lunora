import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLunoraClient } from "@lunora/react-native";

import { LUNORA_URL } from "./auth-client";

/**
 * The Lunora client for the app.
 *
 * - `storage: AsyncStorage` persists the offline mutation queue, so a message
 *   sent while offline survives an app restart and flushes on reconnect.
 * - Auth is a **bearer** token, wired outside this module: `App.tsx` bridges the
 *   better-auth Expo session into `setAuthToken` (HTTP RPC) + `setWsToken` (the
 *   live socket) via `expoBearerToken`, re-synced on sign-in/out. A bearer avoids
 *   the `Cookie` header the runtime's CSRF guard rejects on `Origin`-less native
 *   requests, and works the same on web (no browser cookie-jar dependency).
 */
export const lunoraClient = createLunoraClient({
    storage: AsyncStorage,
    url: LUNORA_URL,
});
