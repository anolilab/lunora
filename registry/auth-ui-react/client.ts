/**
 * The better-auth client for your app — the one seam you own and edit.
 *
 * `lunoraAuthPlugins` assembles the standard client plugin array from toggles so
 * you don't hand-list them; flip a toggle (and run the matching `lunora add`
 * server item) to enable a flow. Swap `better-auth/react` for your framework's
 * variant if you're not on React.
 */
import { createAuthClient } from "better-auth/react";
import { lunoraAuthPlugins } from "@lunora/auth/plugins/client";

// Vite exposes env on import.meta.env; fall back to the current origin (same-origin apps).
const baseURL =
    (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_AUTH_URL) ??
    (typeof globalThis !== "undefined" && globalThis.location ? globalThis.location.origin : undefined);

export const authClient = createAuthClient({
    baseURL,
    plugins: lunoraAuthPlugins({
        emailOtp: true,
        magicLink: true,
        organization: true,
        passkey: true,
        twoFactor: true,
    }),
});
