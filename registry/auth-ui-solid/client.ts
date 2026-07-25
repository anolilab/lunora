/**
 * The better-auth client for your app — the one seam you own and edit.
 *
 * `createLunoraAuthClient` assembles the standard client plugin set from
 * toggles so you don't hand-list them, and defaults `baseURL` to the current
 * origin. Flip a toggle (and run the matching `lunora add` server item) to
 * enable a flow — the cards for a disabled flow simply don't render.
 *
 * `createAuthClient` is passed in rather than chosen for you because the
 * variant has to match your UI framework (better-auth/solid here).
 */
import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/solid";

export const authClient = createLunoraAuthClient(createAuthClient, {
    // Vite exposes env on import.meta.env; omit to use the current origin.
    baseURL: (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_AUTH_URL) ?? undefined,
    plugins: {
        emailOtp: true,
        magicLink: true,
        organization: true,
        passkey: true,
        twoFactor: true,
    },
});
