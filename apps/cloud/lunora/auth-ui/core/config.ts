/**
 * The framework-agnostic configuration + resolved controller context.
 *
 * A framework provider (`&lt;AuthUIProvider>`) collects the user-facing
 * {@link AuthUIConfig}, then {@link resolveContext} normalizes it into a
 * {@link ControllerContext} — the fully-defaulted object every controller
 * receives. Keeping resolution here means the five framework providers share one
 * defaulting path instead of each re-implementing it.
 */
import { derivePluginFlags } from "./flow-gate";
import type { Localization } from "./localization";
import { resolveLocalization } from "./localization";
import type { ThemeTokens } from "./theme";
import { resolveThemeVariables } from "./theme";
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

/**
 * Which optional flows/cards render. Left unset, each flag comes from what
 * `lunora/auth-ui/client.ts` registered for this client (see `flow-gate.ts`), so
 * enabling a plugin there is enough — you don't restate it here. Set a flag
 * explicitly to override that in either direction.
 */
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
    /** Where to send a user whose account requires a second factor. */
    twoFactor?: string;
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

    /**
     * Retint the cards from config instead of CSS: receives the default tokens,
     * returns the ones to change. Only what you change is emitted, so an app's
     * own design tokens keep flowing through everything you leave alone.
     */
    theme?: (defaults: ThemeTokens) => ThemeTokens;
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
    /** Changed theme tokens as inline custom properties; empty when unthemed. */
    themeVariables: Readonly<Record<string, string>>;
}

/** Explicit flags win; anything left unset comes from the client's registration. */
const resolvePlugins = (authClient: AuthClient, plugins?: PluginFlags): Required<PluginFlags> => {
    const registered = derivePluginFlags(authClient);

    return {
        admin: plugins?.admin ?? registered.admin,
        apiKey: plugins?.apiKey ?? registered.apiKey,
        emailOtp: plugins?.emailOtp ?? registered.emailOtp,
        magicLink: plugins?.magicLink ?? registered.magicLink,
        organization: plugins?.organization ?? registered.organization,
        passkey: plugins?.passkey ?? registered.passkey,
        twoFactor: plugins?.twoFactor ?? registered.twoFactor,
    };
};

const resolveRedirects = (redirects?: RedirectConfig): Required<RedirectConfig> => {
    return {
        afterSignIn: redirects?.afterSignIn ?? "/",
        afterSignOut: redirects?.afterSignOut ?? "/",
        signIn: redirects?.signIn ?? "/sign-in",
        twoFactor: redirects?.twoFactor ?? "/two-factor",
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
        plugins: resolvePlugins(config.authClient, config.plugins),
        redirects: resolveRedirects(config.redirects),
        social: config.social ?? [],
        themeVariables: resolveThemeVariables(config.theme),
    };
};

export type { AuthUIConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig };
export { DEFAULT_BASE_PATH, resolveContext };
