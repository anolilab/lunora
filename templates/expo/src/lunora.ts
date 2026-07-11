import AsyncStorage from "@react-native-async-storage/async-storage";
import { createLunoraClient } from "@lunora/react-native";
import { expoAuthHeaders } from "@lunora/react-native/auth";

import { authClient, LUNORA_URL } from "./auth-client";

/**
 * The Lunora client for the app.
 *
 * - `storage: AsyncStorage` persists the offline mutation queue, so a message
 *   sent while offline survives an app restart and flushes on reconnect.
 * - `getAuthHeaders: expoAuthHeaders(authClient)` attaches the better-auth
 *   session cookie to every HTTP RPC request and the WebSocket upgrade — read
 *   fresh each time, so signing in/out takes effect without re-creating this
 *   client.
 *
 * Note: on web, the browser's `WebSocket` ignores custom headers and blocks a
 * manual `Cookie` header, so the socket authenticates via the browser cookie jar
 * (same-origin) instead — see the README's "Running on web" section.
 */
export const lunoraClient = createLunoraClient({
    getAuthHeaders: expoAuthHeaders(authClient),
    storage: AsyncStorage,
    url: LUNORA_URL,
});
