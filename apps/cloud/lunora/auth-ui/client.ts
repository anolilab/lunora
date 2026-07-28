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
 * has to match your UI framework (better-auth/react here).
 */
import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/react";

import { registerAuthClientPlugins } from "./core";

const AUTH_PLUGINS = {
    // Matched to what `src/server.ts` actually mounts — `admin`, `twoFactor`,
    // `passkey`. The copy-in default turns all five on; leaving it that way would
    // render a magic-link and an email-OTP card whose endpoints this Worker does not
    // serve, and an organizations card backed by better-auth's `organization`
    // plugin, which this app omits ON PURPOSE (see the note in `src/server.ts`) so
    // there are not two parallel org models. Enable a flow here only after adding
    // its server half (`lunora add auth-magic-link` / `auth-otp`).
    emailOtp: false,
    magicLink: false,
    organization: false,
    passkey: true,
    twoFactor: true,
};

/**
 * Where better-auth is served. Left undefined, the client uses the current
 * origin, which is right whenever the Worker is same-origin with the app — the
 * default for every Lunora template.
 *
 * Both spellings are read because neither is universal: `import.meta.env` is a
 * Vite API (Nuxt, SvelteKit, Astro, TanStack Start, Analog), and `process.env`
 * with a build-time-inlined `NEXT_PUBLIC_`/`PUBLIC_` name is what bundlers that
 * are not Vite expose. Each access is guarded because referencing the wrong one
 * is a ReferenceError, not an undefined.
 */
const authBaseUrl = (): string | undefined => {
    const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;

    if (viteEnv?.VITE_AUTH_URL) {
        return viteEnv.VITE_AUTH_URL;
    }

    if (typeof process !== "undefined" && process.env) {
        return process.env.NEXT_PUBLIC_AUTH_URL ?? process.env.PUBLIC_AUTH_URL;
    }

    return undefined;
};

export const authClient = createLunoraAuthClient(createAuthClient, {
    // The control-plane Worker serves better-auth at `/api/auth` on its own origin,
    // so the studio needs no absolute URL — it and the Worker always share an origin
    // (one dev server in dev, one Cloudflare account in prod). `authBaseUrl()` stays
    // as the escape hatch for a split-origin deployment.
    basePath: "/api/auth",
    baseURL: authBaseUrl(),
    plugins: AUTH_PLUGINS,
});

registerAuthClientPlugins(authClient, AUTH_PLUGINS);
