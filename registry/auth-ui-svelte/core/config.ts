/**
 * The framework-agnostic configuration + resolved controller context.
 *
 * A framework provider (`&lt;AuthUIProvider>`) collects the user-facing
 * {@link AuthUIConfig}, then {@link resolveContext} normalizes it into a
 * {@link ControllerContext} — the fully-defaulted object every controller
 * receives. Keeping resolution here means the five framework providers share one
 * defaulting path instead of each re-implementing it.
 */
import type { Localization } from "./localization";
import { resolveLocalization } from "./localization";
import type { AuthClient } from "./types";

/** better-auth's default mount path; matches `DEFAULT_AUTH_BASE_PATH` in the `@lunora/client` package. */
const DEFAULT_BASE_PATH = "/api/auth";

/**
 * Router bridge so one base-framework component set serves every meta-framework:
 * Next passes `router.push`/`replace`, react-router its `navigate`, SvelteKit
 * `goto`, etc. Falls back to `location` (see default-nav.ts) when unset.
 */
interface NavAdapter {
    navigate: (to: string) => void;
    replace: (to: string) => void;
}

/** Which optional flows/cards render — mirrors the enabled server + client plugins. */
interface PluginFlags {
    admin?: boolean;
    apiKey?: boolean;
    emailOtp?: boolean;
    magicLink?: boolean;
    organization?: boolean;
    passkey?: boolean;
    twoFactor?: boolean;
}

interface RedirectConfig {
    /** Where to send the user after a successful sign-in / sign-up. */
    afterSignIn?: string;
    /** Where to send the user after signing out. */
    afterSignOut?: string;
    /** The route hosting the sign-in screen (used by redirect-to-sign-in guards). */
    signIn?: string;
}

/** The user-facing config passed to a framework `&lt;AuthUIProvider>`. */
interface AuthUIConfig {
    authClient: AuthClient;
    /** Defaults to `/api/auth`. */
    basePath?: string;
    localization?: Partial<Localization>;
    nav: NavAdapter;
    /** Surfaced to `onError`; the flow still sets `formError` for display. */
    onError?: (error: unknown) => void;

    /**
     * Called after any successful auth mutation (sign-in/out, 2FA verify). Wire
     * it to refresh your app's session state — e.g. re-resolve the Lunora
     * identity store — since a same-origin cookie sign-in has no token change to
     * trigger `useAuth` on its own.
     */
    onSessionChange?: () => void;
    plugins?: PluginFlags;
    redirects?: RedirectConfig;
    /** OAuth providers to render social buttons for (server-side config required). */
    social?: ReadonlyArray<string>;
}

/** The fully-resolved context every controller receives. */
interface ControllerContext {
    authClient: AuthClient;
    basePath: string;
    localization: Localization;
    nav: NavAdapter;
    onError?: (error: unknown) => void;
    onSessionChange?: () => void;
    plugins: Required<PluginFlags>;
    redirects: Required<RedirectConfig>;
    social: ReadonlyArray<string>;
}

const resolvePlugins = (plugins?: PluginFlags): Required<PluginFlags> => {
    return {
        admin: plugins?.admin ?? false,
        apiKey: plugins?.apiKey ?? false,
        emailOtp: plugins?.emailOtp ?? false,
        magicLink: plugins?.magicLink ?? false,
        organization: plugins?.organization ?? false,
        passkey: plugins?.passkey ?? false,
        twoFactor: plugins?.twoFactor ?? false,
    };
};

const resolveRedirects = (redirects?: RedirectConfig): Required<RedirectConfig> => {
    return {
        afterSignIn: redirects?.afterSignIn ?? "/",
        afterSignOut: redirects?.afterSignOut ?? "/",
        signIn: redirects?.signIn ?? "/sign-in",
    };
};

/** Normalize a user-facing config into a fully-defaulted controller context. */
const resolveContext = (config: AuthUIConfig): ControllerContext => {
    return {
        authClient: config.authClient,
        basePath: config.basePath ?? DEFAULT_BASE_PATH,
        localization: resolveLocalization(config.localization),
        nav: config.nav,
        onError: config.onError,
        onSessionChange: config.onSessionChange,
        plugins: resolvePlugins(config.plugins),
        redirects: resolveRedirects(config.redirects),
        social: config.social ?? [],
    };
};

export type { AuthUIConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig };
export { DEFAULT_BASE_PATH, resolveContext };
