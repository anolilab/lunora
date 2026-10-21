import { createLunoraClient } from "@lunora/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { LUNORA_URL } from "./auth-client";

/**
 * The session bearer, set on sign-in and sign-out from `App.tsx`. The client reads
 * it on every HTTP request and every socket (re)connect, so the next upgrade always
 * presents the current session.
 */
let sessionBearer: string | null = null;

/** Set the bearer sent on each HTTP request and each WebSocket upgrade. */
export const setSessionBearer = (token: string | null): void => {
    sessionBearer = token;
};

/**
 * The Lunora client for the mobile app.
 *
 * - `storage: AsyncStorage` persists the offline mutation queue, so a message
 *   sent while offline survives an app restart and flushes on reconnect.
 * - Auth is a **bearer** token, wired outside this module: `App.tsx` bridges
 *   the better-auth Expo session into `setAuthToken` (HTTP RPC) and
 *   `setSessionBearer` (the upgrade's `Authorization` header) via
 *   `expoBearerToken`, re-synced on sign-in/out. The upgrade header identifies
 *   the socket, so `LUNORA_WS_BEARER` stays unset for an Expo app. A
 *   bearer avoids the `Cookie` header the runtime's CSRF guard rejects on
 *   `Origin`-less native requests — `createLunoraClient` also sends
 *   `credentials: "omit"` so the platform cookie jar cannot re-attach one
 *   behind the bearer's back.
 */
export const lunoraClient = createLunoraClient({
    getAuthHeaders: () => (sessionBearer === null ? undefined : { authorization: `Bearer ${sessionBearer}` }),
    storage: AsyncStorage,
    url: LUNORA_URL,
});
