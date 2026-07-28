/**
 * The better-auth client for your app — the one seam you own and edit.
 *
 * `AUTH_PLUGINS` declares which better-auth **client** plugins this client is
 * built with. Flip a toggle (and run the matching `lunora add` server item) to
 * enable one.
 *
 * It is not, on its own, what decides which cards render. If your Worker mounts
 * `uiConfig()` (the base `auth` item does by default), the UI also asks the
 * server which plugins and social providers are actually enabled, and the two
 * answers are combined: a card renders when the server has the endpoint **and**
 * this client registered the plugin that drives it. So adding a social provider
 * server-side needs no change here at all, and a plugin listed here that the
 * server doesn't run is correctly hidden rather than rendered and broken.
 *
 * `registerAuthClientPlugins` is how the UI learns this half. It has to be told:
 * `createAuthClient` returns a dynamic-path proxy, so the cards cannot inspect
 * the client to find out (every method appears to exist). Without `uiConfig()`
 * server-side, this list is the only source and behaves as it always did.
 *
 * `createAuthClient` is passed in rather than chosen for you because the variant
 * has to match your UI framework (better-auth/vue here).
 */
import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/vue";

import { registerAuthClientPlugins } from "./core";

const AUTH_PLUGINS = {
    emailOtp: true,
    magicLink: true,
    organization: true,
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
    baseURL: authBaseUrl(),
    plugins: AUTH_PLUGINS,
});

registerAuthClientPlugins(authClient, AUTH_PLUGINS);
