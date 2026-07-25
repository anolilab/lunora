/**
 * The better-auth client for your app — the one seam you own and edit.
 *
 * `AUTH_PLUGINS` is the single place a flow is declared. Flip a toggle (and run
 * the matching `lunora add` server item) to enable one; the cards for a disabled
 * flow don't render.
 *
 * `registerAuthClientPlugins` tells the auth UI what this client was built with.
 * It has to be told: `createAuthClient` returns a dynamic-path proxy, so the
 * cards cannot inspect the client to find out (every method appears to exist).
 *
 * `createAuthClient` is passed in rather than chosen for you because the variant
 * has to match your UI framework (better-auth/solid here).
 */
import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/solid";

import { registerAuthClientPlugins } from "./core";

const AUTH_PLUGINS = {
    emailOtp: true,
    magicLink: true,
    organization: true,
    passkey: true,
    twoFactor: true,
};

export const authClient = createLunoraAuthClient(createAuthClient, {
    // Vite exposes env on import.meta.env; omit to use the current origin.
    baseURL: (import.meta as { env?: Record<string, string> }).env?.VITE_AUTH_URL,
    plugins: AUTH_PLUGINS,
});

registerAuthClientPlugins(authClient, AUTH_PLUGINS);
