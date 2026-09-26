/**
 * Assemble the standard better-auth **client** plugin set from feature toggles,
 * so consumers (and the scaffolded `lunora/auth-ui/client.ts`) stop hand-listing
 * `[organizationClient(), twoFactorClient(), …]` and keeping it in sync by memory.
 *
 * Two entry points, same toggles:
 *
 * - {@link createLunoraAuthClient} builds the whole client — the one-liner.
 * - {@link lunoraAuthPlugins} returns just the array, for when you want to own the `createAuthClient` call.
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

import { notifySessionChanged } from "../../../shared/session-change";

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

/**
 * Toggle → client-plugin factory. Key order is the legacy toggle-check order
 * (not alphabetical) — the assembled plugin array is observable, and keeping
 * the historical sequence preserves behavior for consumers that read it.
 */
const PLUGIN_FACTORIES: Record<keyof LunoraAuthPluginToggles, () => LunoraAuthClientPlugin> = {
    organization: organizationClient,
    twoFactor: twoFactorClient,
    passkey: passkeyClient,
    magicLink: magicLinkClient,
    emailOtp: emailOTPClient,
    admin: adminClient,
    username: usernameClient,
    phoneNumber: phoneNumberClient,
    multiSession: multiSessionClient,
    anonymous: anonymousClient,
    deviceAuthorization: deviceAuthorizationClient,
    lastLoginMethod: lastLoginMethodClient,
    oauthProvider: oauthProviderClient,
};

const lunoraAuthPlugins = (toggles: LunoraAuthPluginToggles = {}): LunoraAuthClientPlugin[] => {
    const plugins: LunoraAuthClientPlugin[] = [];

    for (const key of Object.keys(PLUGIN_FACTORIES) as (keyof LunoraAuthPluginToggles)[]) {
        if (toggles[key]) {
            plugins.push(PLUGIN_FACTORIES[key]());
        }
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
 * What {@link lunoraSessionSync} returns: a better-auth client plugin, typed
 * narrowly rather than as `BetterAuthClientPlugin` — widening a plugin to that
 * type collapses better-auth's session inference on the client it joins.
 */
interface LunoraSessionSyncPlugin {
    fetchPlugins: {
        hooks: { onSuccess: (context: { request: { method?: string } }) => void };
        id: string;
        name: string;
    }[];
    id: "lunora-session-sync";
}

/**
 * Tell every `LunoraClient` in the page, and in the browser's other tabs (they
 * share the cookie), that the auth session may have changed, so each asks
 * `/get-session` who is signed in now.
 *
 * Needed for a **cookie** session: a sign-in or sign-out sets or clears an
 * `HttpOnly` cookie in a request the Lunora client never sees, and nothing it
 * can observe changes. Until it re-resolves, its live queries keep showing the
 * previous user's rows over a socket still authenticated as them.
 * {@link lunoraSessionSync} (installed by {@link createLunoraAuthClient}) and
 * `@lunora/auth-ui` call it for you; call it yourself after a session change
 * made any other way.
 *
 * Resolves once every client in this tab has re-resolved (or failed to), so
 * code that reads `client.currentIdentity()` next can `await` it; the other
 * tabs re-resolve on their own. Never rejects.
 */
const notifyLunoraSessionChange = async (): Promise<void> => notifySessionChanged();

/**
 * A better-auth client plugin that, after every successful auth request that
 * can change the session (anything but a `GET` — sign-in, sign-up, sign-out,
 * 2FA, account switch, session revocation), calls
 * {@link notifyLunoraSessionChange}.
 *
 * {@link createLunoraAuthClient} always installs it. Add it yourself when you
 * call `createAuthClient` directly:
 *
 * ```ts
 * export const authClient = createAuthClient({ plugins: [lunoraSessionSync()] });
 * ```
 */
const lunoraSessionSync = (): LunoraSessionSyncPlugin => {
    return {
        fetchPlugins: [
            {
                hooks: {
                    onSuccess: (context: { request: { method?: string } }): void => {
                        if ((context.request.method ?? "GET").toUpperCase() !== "GET") {
                            // Fire and forget: better-auth's own callers need not wait.
                            notifySessionChanged().catch(() => undefined);
                        }
                    },
                },
                id: "lunora-session-sync",
                name: "lunora-session-sync",
            },
        ],
        id: "lunora-session-sync",
    };
};

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- `LunoraAuthClientPlugin` is `ReturnType<typeof organizationClient>`, and better-auth types that return as `any`, so every plugin array spreads as `any`. Verified with a `const check: never = p` probe. Not fixable here without hand-writing a plugin type that would then drift from better-auth's.
        plugins: [lunoraSessionSync(), ...lunoraAuthPlugins(plugins), ...oneTap, ...extraPlugins],
    });
};

export type { CreateLunoraAuthClientOptions, LunoraAuthClientPlugin, LunoraAuthPluginToggles, LunoraSessionSyncPlugin };
export { createLunoraAuthClient, lunoraAuthPlugins, lunoraSessionSync, notifyLunoraSessionChange };
