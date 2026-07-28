/**
 * Assemble the standard better-auth **client** plugin set from feature toggles,
 * so consumers (and the scaffolded `lunora/auth-ui/client.ts`) stop hand-listing
 * `[organizationClient(), twoFactorClient(), …]` and keeping it in sync by memory.
 *
 * Two entry points, same toggles:
 *
 * - {@link createLunoraAuthClient} builds the whole client — the one-liner.
 * - {@link lunoraAuthPlugins} returns just the array, for when you want to own
 *   the `createAuthClient` call.
 *
 * Neither picks the framework variant for you (`better-auth/react` | `/vue` |
 * `/svelte` | `/solid`) — it has to match your UI framework, so you pass it in:
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
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import {
    adminClient,
    anonymousClient,
    deviceAuthorizationClient,
    emailOTPClient,
    lastLoginMethodClient,
    magicLinkClient,
    multiSessionClient,
    oneTapClient,
    organizationClient,
    phoneNumberClient,
    twoFactorClient,
    usernameClient,
} from "better-auth/client/plugins";

/**
 * Which client plugins to include. Each defaults to `false`.
 *
 * These are the same names `@lunora/auth-ui` gates its cards on, so one object
 * can drive both `createLunoraAuthClient` and `registerAuthClientPlugins` — a
 * flow the UI can show but this cannot install would be a card that renders and
 * then fails at call time.
 *
 * `oneTap` is absent on purpose: Google One Tap needs a client id, not a
 * boolean, so it comes in through {@link CreateLunoraAuthClientOptions.oneTapClientId}.
 */
interface LunoraAuthPluginToggles {
    admin?: boolean;
    anonymous?: boolean;
    deviceAuthorization?: boolean;
    emailOtp?: boolean;
    lastLoginMethod?: boolean;
    magicLink?: boolean;
    multiSession?: boolean;
    oauthProvider?: boolean;
    organization?: boolean;
    passkey?: boolean;
    phoneNumber?: boolean;
    twoFactor?: boolean;
    username?: boolean;
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

    if (toggles.username) {
        plugins.push(usernameClient());
    }

    if (toggles.phoneNumber) {
        plugins.push(phoneNumberClient());
    }

    if (toggles.multiSession) {
        plugins.push(multiSessionClient());
    }

    if (toggles.anonymous) {
        plugins.push(anonymousClient());
    }

    if (toggles.deviceAuthorization) {
        plugins.push(deviceAuthorizationClient());
    }

    if (toggles.lastLoginMethod) {
        plugins.push(lastLoginMethodClient());
    }

    if (toggles.oauthProvider) {
        plugins.push(oauthProviderClient());
    }

    return plugins;
};

/** Options for {@link createLunoraAuthClient}; anything else is forwarded to `createAuthClient`. */
interface CreateLunoraAuthClientOptions {
    [option: string]: unknown;
    /** Defaults to the current origin, which is right for a same-origin app. */
    baseURL?: string;
    /** Your own client plugins, appended after the standard set. */
    extraPlugins?: LunoraAuthClientPlugin[];

    /**
     * Google OAuth client id. Setting it installs the One Tap client plugin —
     * a boolean toggle can't, because the prompt is Google's and needs the id.
     */
    oneTapClientId?: string;
    /** Which standard client plugins to include. */
    plugins?: LunoraAuthPluginToggles;
}

/** Same-origin default; `undefined` off the browser (SSR passes `baseURL` explicitly). */
const currentOrigin = (): string | undefined => (globalThis as { location?: { origin?: string } }).location?.origin;

/**
 * Build a better-auth client with Lunora's standard plugin set from toggles.
 *
 * You pass your framework's `createAuthClient` in — `better-auth/react`,
 * `/vue`, `/svelte`, or `/solid` — because the variant has to match the UI
 * framework, and a helper that picked for you would either guess wrong or drag
 * every variant into your bundle.
 *
 * ```ts
 * import { createAuthClient } from "better-auth/react";
 * import { createLunoraAuthClient } from "@lunora/auth/plugins/client";
 *
 * export const authClient = createLunoraAuthClient(createAuthClient, {
 *     plugins: { organization: true, passkey: true, twoFactor: true },
 * });
 * ```
 *
 * Reach for {@link lunoraAuthPlugins} instead when you want to own the
 * `createAuthClient` call and only borrow the plugin array.
 */
const createLunoraAuthClient = <TClient>(
    createAuthClient: (options: Record<string, unknown>) => TClient,
    options: CreateLunoraAuthClientOptions = {},
): TClient => {
    const { baseURL, extraPlugins = [], oneTapClientId, plugins, ...rest } = options;
    const oneTap = oneTapClientId === undefined || oneTapClientId === "" ? [] : [oneTapClient({ clientId: oneTapClientId })];

    return createAuthClient({
        ...rest,
        baseURL: baseURL ?? currentOrigin(),
        plugins: [...lunoraAuthPlugins(plugins), ...oneTap, ...extraPlugins],
    });
};

export type { CreateLunoraAuthClientOptions, LunoraAuthClientPlugin, LunoraAuthPluginToggles };
export { createLunoraAuthClient, lunoraAuthPlugins };
