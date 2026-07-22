/**
 * `lunoraAuthPlugins` — assemble the standard better-auth **client** plugin array
 * from a set of feature toggles, so consumers (and the scaffolded
 * `lunora/auth-ui/client.ts`) stop hand-listing `[organizationClient(),
 * twoFactorClient(), …]` and keeping it in sync by memory.
 *
 * It intentionally returns just the array (rather than wrapping
 * `createAuthClient`): the caller owns the `createAuthClient` call and picks the
 * framework variant (`better-auth/react` | `/vue` | `/svelte` | `/solid`), which
 * must match their UI framework. Spread the result into `plugins`:
 *
 * ```ts
 * import { createAuthClient } from "better-auth/react";
 * import { lunoraAuthPlugins } from "@lunora/auth/plugins/client";
 *
 * export const authClient = createAuthClient({
 *     baseURL: import.meta.env.VITE_AUTH_URL,
 *     plugins: lunoraAuthPlugins({ organization: true, twoFactor: true, passkey: true }),
 * });
 * ```
 *
 * Keep the toggles in parity with the server `plugins` passed to `createAuth`: a
 * client plugin without its server half (or vice-versa) leaves those actions
 * untyped/unavailable.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, emailOTPClient, magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";

/** Which client plugins to include. Each defaults to `false`. */
interface LunoraAuthPluginToggles {
    admin?: boolean;
    emailOtp?: boolean;
    magicLink?: boolean;
    organization?: boolean;
    passkey?: boolean;
    twoFactor?: boolean;
}

// A better-auth client plugin instance. better-auth's inferred client-plugin
// types are `any`-wide, so a single alias suffices (and a union would collapse to
// `any`, tripping no-redundant-type-constituents). Assignable to whatever
// `createAuthClient({ plugins })` expects at the call site.
type LunoraAuthClientPlugin = ReturnType<typeof organizationClient>;

const lunoraAuthPlugins = (toggles: LunoraAuthPluginToggles = {}): LunoraAuthClientPlugin[] => {
    const plugins: LunoraAuthClientPlugin[] = [];

    if (toggles.organization) {
        plugins.push(organizationClient());
    }

    if (toggles.twoFactor) {
        plugins.push(twoFactorClient());
    }

    if (toggles.passkey) {
        plugins.push(passkeyClient());
    }

    if (toggles.magicLink) {
        plugins.push(magicLinkClient());
    }

    if (toggles.emailOtp) {
        plugins.push(emailOTPClient());
    }

    if (toggles.admin) {
        plugins.push(adminClient());
    }

    return plugins;
};

export type { LunoraAuthClientPlugin, LunoraAuthPluginToggles };
export { lunoraAuthPlugins };
