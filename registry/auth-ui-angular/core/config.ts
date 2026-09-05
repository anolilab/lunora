/**
 * The framework-agnostic configuration + resolved controller context.
 *
 * A framework provider (`<AuthUIProvider>`) collects the user-facing
 * {@link AuthUIConfig}, then {@link resolveContext} normalizes it into a
 * {@link ControllerContext} — the fully-defaulted object every controller
 * receives. Keeping resolution here means the five framework providers share one
 * defaulting path instead of each re-implementing it.
 */
import type { DiscoveredConfig } from "./discovery";
import { PLUGIN_ID_TO_FLOW } from "./discovery";
import { derivePluginFlags, FLOW_NAMES } from "./flow-gate";
import type { Localization } from "./localization";
import { resolveLocalization } from "./localization";
import type { PasswordPolicy } from "./password-policy";
import type { ThemeTokens } from "./theme";
import { resolveThemeVariables } from "./theme";
import type { AnyAuthClient, AuthClient } from "./types";

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
 * Which optional flows/cards render.
 *
 * Left unset, each flag is derived — from the server's `uiConfig()` endpoint
 * when it answers, and from what `lunora/auth-ui/client.ts` registered for this
 * client, ANDed together (see {@link resolvePlugins}). Set a flag explicitly to
 * override both, in either direction.
 */
interface PluginFlags {
    admin?: boolean;
    anonymous?: boolean;

    /**
     * better-auth ships no `apiKey` plugin as of 1.7, so nothing sets this
     * automatically. It exists so an app running a fork or a later release can
     * turn the cards on explicitly.
     */
    apiKey?: boolean;
    deviceAuthorization?: boolean;
    emailOtp?: boolean;
    lastLoginMethod?: boolean;
    magicLink?: boolean;
    multiSession?: boolean;
    oauthProvider?: boolean;
    oneTap?: boolean;
    organization?: boolean;
    passkey?: boolean;
    phoneNumber?: boolean;
    twoFactor?: boolean;
    username?: boolean;
}

interface RedirectConfig {
    /** Where to send the user after a successful sign-in / sign-up. */
    afterSignIn?: string;
    /** Where to send the user after signing out. */
    afterSignOut?: string;

    /**
     * The route hosting the sign-in screen (used by redirect-to-sign-in guards).
     * Defaults to `viewPaths.base` + `viewPaths.signIn`.
     */
    signIn?: string;

    /**
     * Where to send a user whose account requires a second factor. Defaults to
     * `viewPaths.base` + `viewPaths.twoFactor`.
     */
    twoFactor?: string;
}

/**
 * URL segments `<AuthView>` maps to cards, so an app can host every auth screen
 * on one route (`/auth/:view`) instead of wiring ten of them.
 */
interface ViewPaths {
    acceptInvitation?: string;

    /**
     * The route the segments below live under — `"/auth"` for `<AuthView>`
     * mounted at `/auth/:view`. Defaults to `""`, i.e. root-level routes
     * (`/sign-in`, `/sign-up`, …).
     *
     * Every link between the screens is derived from this plus a segment, and so
     * are `redirects.signIn` and `redirects.twoFactor` and the reset link
     * `ForgotPasswordCard` mails. That single source is the point: with the
     * routes spelled out independently, an app that mounted `<AuthView>` at
     * `/auth/:view` — the arrangement the component documents — got a sign-in
     * card linking to `/sign-up` and a two-factor hop to `/two-factor`, neither
     * of which existed. A correct password landed on a 404.
     */
    base?: string;
    deviceAuthorization?: string;
    emailOtp?: string;
    forgotPassword?: string;
    magicLink?: string;
    resetPassword?: string;
    signIn?: string;
    signUp?: string;
    twoFactor?: string;
    verifyEmail?: string;
}

/**
 * How avatars are stored. Without an `upload`, the profile card offers a URL
 * field — better-auth stores `user.image` as a string and has no opinion about
 * where the bytes live. With one, it offers a file picker and stores whatever
 * URL the handler returns: R2 via `@lunora/storage`, an S3 signed PUT, a data
 * URI for a toy app.
 */
interface AvatarConfig {
    /** Reject files larger than this, in bytes. Defaults to 2 MiB. */
    maxSize?: number;
    upload?: (file: File) => Promise<string>;
}

/** The user-facing config passed to a framework `<AuthUIProvider>`. */
interface AuthUIConfig {
    authClient: AnyAuthClient;
    avatar?: AvatarConfig;
    /** Defaults to `/api/auth`. */
    basePath?: string;

    /**
     * Ask the server which plugins and social providers are enabled, via the
     * `uiConfig()` better-auth plugin. On by default; it degrades silently to
     * the client-side registration when the endpoint isn't mounted.
     */
    discover?: boolean;

    /**
     * Password rules, meant to mirror what your server enforces. Left unset it
     * is better-auth's own default (8–128, no composition rules); set it to
     * whatever `emailAndPassword` is configured with so the form and the server
     * agree. See `password-policy.ts`.
     */

    /**
     * How a forgotten password is recovered.
     *
     * `"link"` (the default) posts to `/request-password-reset`, which needs
     * `emailAndPassword.sendResetPassword` server-side. `"otp"` uses the
     * `emailOTP` plugin instead — a *different endpoint with a different
     * payload*. An app configured for one and asking for the other gets "Reset
     * password isn't enabled", which names neither the cause nor the fix.
     *
     * Explicit rather than inferred: both can be configured at once, and only
     * the app knows which flow it means to offer.
     */
    forgotPassword?: { method?: "link" | "otp" };
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

    /** Organization UI options. Server-derived sub-features are separate. */
    organization?: {
        /**
         * Force the custom-roles cards on. Same reasoning as `teams` below.
         */
        roles?: boolean;

        /**
         * Show the slug field when creating or editing an organization.
         * Defaults to true. Turn it off for apps that don't put the slug in a
         * URL — it is an implementation detail there, and the create form
         * derives one from the name anyway.
         */
        showSlug?: boolean;

        /**
         * Force the teams cards on, regardless of what the server discloses.
         *
         * Needed because teams are detected from the server's table map and
         * have no client-side equivalent to fall back on: a deployment that
         * withholds the organization block (`uiConfig({ expose })`) would
         * otherwise lose `<TeamsCard>` from every port with no way to restore it.
         */
        teams?: boolean;
    };
    password?: PasswordPolicy;
    plugins?: PluginFlags;
    redirects?: RedirectConfig;

    /**
     * OAuth providers to render social buttons for. Left unset, the providers
     * the server reports are used; set it to pin the list or to reorder it.
     */
    social?: ReadonlyArray<string>;

    /**
     * Retint the cards from config instead of CSS: receives the default tokens,
     * returns the ones to change. Only what you change is emitted, so an app's
     * own design tokens keep flowing through everything you leave alone.
     */
    theme?: (defaults: ThemeTokens) => ThemeTokens;
    viewPaths?: ViewPaths;
}

/** The fully-resolved context every controller receives. */
interface ControllerContext {
    authClient: AuthClient;
    avatar: AvatarConfig;
    basePath: string;
    /** Whether the password form renders. Server-derived when discovery answers. */
    credentials: boolean;
    /** Which password-reset transport the app uses; see the config field of the same name. */
    forgotPasswordMethod: "link" | "otp";
    localization: Localization;
    nav: NavAdapter;
    /** The app's handler, wrapped by {@link guardCallback} — calling it cannot throw. */
    onError?: (error: unknown) => void;
    onSessionChange?: () => void;
    /** Organization sub-features, server-derived when discovery answers. */
    organization: {
        /** False when the server forbids ordinary users from creating one. */
        allowUserToCreate: boolean;
        invitationLimit?: number;
        /** Max organizations per user, when the server sets one. */
        limit?: number;
        membershipLimit?: number;
        roles: boolean;
        showSlug: boolean;
        teams: boolean;
    };
    password: PasswordPolicy;
    plugins: Required<PluginFlags>;
    redirects: Required<RedirectConfig>;
    /** Whether the sign-up card offers to create an account. */
    signUp: boolean;
    social: ReadonlyArray<string>;
    /** Changed theme tokens as inline custom properties; empty when unthemed. */
    themeVariables: Readonly<Record<string, string>>;
    viewPaths: Required<ViewPaths>;
}

/** Default avatar cap: big enough for a photo off a phone, small enough to not wedge a Worker. */
const DEFAULT_AVATAR_MAX_SIZE = 2 * 1024 * 1024;

/** Turn the server's plugin-id list into flow flags. Ids the UI has no card for are ignored. */
const flagsFromDiscovery = (plugins: ReadonlyArray<string>): Partial<Record<keyof PluginFlags, boolean>> => {
    const flags: Partial<Record<keyof PluginFlags, boolean>> = {};

    for (const flow of FLOW_NAMES) {
        flags[flow] = false;
    }

    for (const id of plugins) {
        const flow = PLUGIN_ID_TO_FLOW[id] as keyof PluginFlags | undefined;

        if (flow !== undefined) {
            flags[flow] = true;
        }
    }

    return flags;
};

/**
 * Combine the sources of truth for each flow.
 *
 * Explicit config wins outright. Otherwise the server's answer and the client's
 * registration are ANDed *when both are known*, because they answer different
 * halves of the question — the server knows the endpoint exists, the client
 * registration knows the client plugin that drives it was installed. A flow with
 * only one half is broken in a way a rendered card would hide: `passkey` without
 * `passkeyClient()` has a live endpoint and no WebAuthn ceremony to reach it.
 */
const resolvePlugins = (authClient: AnyAuthClient, plugins?: PluginFlags, discovered?: DiscoveredConfig): Required<PluginFlags> => {
    const registered = derivePluginFlags(authClient);
    // Only when the server actually disclosed a plugin list. Withholding it must
    // read as "no opinion" and defer to the registration, not as "none enabled".
    const disclosedPlugins = discovered?.plugins;
    const fromServer = disclosedPlugins === undefined ? undefined : flagsFromDiscovery(disclosedPlugins);
    const resolved = {} as Required<PluginFlags>;

    for (const flow of FLOW_NAMES) {
        const explicit = plugins?.[flow];

        if (explicit !== undefined) {
            resolved[flow] = explicit;

            continue;
        }

        const server = fromServer?.[flow];

        resolved[flow] = server === undefined ? registered[flow] : server && registered[flow];
    }

    return resolved;
};

const resolveRedirects = (viewPaths: Required<ViewPaths>, redirects?: RedirectConfig): Required<RedirectConfig> => {
    return {
        afterSignIn: redirects?.afterSignIn ?? "/",
        afterSignOut: redirects?.afterSignOut ?? "/",
        signIn: redirects?.signIn ?? `${viewPaths.base}/${viewPaths.signIn}`,
        twoFactor: redirects?.twoFactor ?? `${viewPaths.base}/${viewPaths.twoFactor}`,
    };
};

/**
 * `""` for the default (root-level routes), else exactly one leading slash and
 * no trailing one, so `${base}/${segment}` is a well-formed path whether the app
 * wrote `"/auth"`, `"auth"`, or `"/auth/"`.
 */
const normalizeViewBase = (base: string | undefined): string => {
    // A loop rather than `/\/+$/`: that pattern backtracks super-linearly on a
    // long run of slashes, and this string comes from config an app may well
    // build from user input.
    let trimmed = (base ?? "").trim();

    while (trimmed.endsWith("/")) {
        trimmed = trimmed.slice(0, -1);
    }

    if (trimmed === "") {
        return "";
    }

    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const resolveViewPaths = (viewPaths?: ViewPaths): Required<ViewPaths> => {
    return {
        acceptInvitation: viewPaths?.acceptInvitation ?? "accept-invitation",
        base: normalizeViewBase(viewPaths?.base),
        deviceAuthorization: viewPaths?.deviceAuthorization ?? "device",
        emailOtp: viewPaths?.emailOtp ?? "email-otp",
        // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a URL segment for the forgot-password screen, not a credential.
        forgotPassword: viewPaths?.forgotPassword ?? "forgot-password", // secret-scanner:allow -- a URL segment, not a credential.
        magicLink: viewPaths?.magicLink ?? "magic-link",
        // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a URL segment for the reset-password screen, not a credential.
        resetPassword: viewPaths?.resetPassword ?? "reset-password",
        signIn: viewPaths?.signIn ?? "sign-in",
        signUp: viewPaths?.signUp ?? "sign-up",
        twoFactor: viewPaths?.twoFactor ?? "two-factor",
        verifyEmail: viewPaths?.verifyEmail ?? "verify-email",
    };
};

/**
 * Wrap an app-supplied callback so a throw inside it cannot abort the caller.
 *
 * Every controller reports a failure with `context.onError?.(error)` on its way
 * to a terminal state, and most do it *before* the `store.update` that leaves
 * that state. An app whose handler throws would therefore strand the flow in
 * `submitting`: the button stays disabled, and the email-OTP request step has no
 * `back()` to escape with, so the card is dead until a reload. Containing it
 * here rather than at each of the ~25 call sites keeps the guard un-forgettable
 * for the next controller.
 *
 * The throw is swallowed on purpose: it is a defect in the app's own handler,
 * and rethrowing it — synchronously or on a later tick — is the wedge this
 * exists to prevent.
 */
const guardCallback = (callback: ((error: unknown) => void) | undefined): ((error: unknown) => void) | undefined => {
    if (callback === undefined) {
        return undefined;
    }

    return (error: unknown): void => {
        try {
            callback(error);
        } catch {
            // Intentionally empty — see the docblock.
        }
    };
};

/**
 * Normalize a user-facing config into a fully-defaulted controller context.
 *
 * `discovered` is the settled result of `discoverAuthConfig`, or undefined while
 * it is in flight or unavailable. Providers re-run this when it lands, so the
 * first paint uses the client's registration and the second the server's.
 */
const resolveContext = (config: AuthUIConfig, discovered?: DiscoveredConfig): ControllerContext => {
    const viewPaths = resolveViewPaths(config.viewPaths);

    return {
        /*
         * The one narrowing cast in the package, and it is load-bearing rather
         * than lazy. `AnyAuthClient` is what an app can actually satisfy (see
         * its docblock); `AuthClient` is what the controllers call. The bridge
         * between them is the flow gate: a controller that reaches for
         * `authClient.organization.*` only ever runs behind
         * `isFlowEnabled(context, "organization", …)`, which is false unless
         * the client registered that plugin — so the namespace exists by the
         * time anything touches it. Widening `AuthClient` instead would push a
         * `?.` onto every call in every controller and lose the type that makes
         * those calls checkable at all.
         */
        authClient: config.authClient as AuthClient,
        avatar: { maxSize: config.avatar?.maxSize ?? DEFAULT_AVATAR_MAX_SIZE, upload: config.avatar?.upload },
        basePath: config.basePath ?? DEFAULT_BASE_PATH,
        credentials: discovered?.emailAndPassword ?? true,
        forgotPasswordMethod: config.forgotPassword?.method ?? "link",
        localization: resolveLocalization(config.localization),
        nav: config.nav,
        onError: guardCallback(config.onError),
        onSessionChange: config.onSessionChange,
        organization: {
            allowUserToCreate: discovered?.organization?.allowUserToCreate ?? true,
            invitationLimit: discovered?.organization?.invitationLimit,
            limit: discovered?.organization?.limit,
            membershipLimit: discovered?.organization?.membershipLimit,
            roles: config.organization?.roles ?? discovered?.organization?.roles ?? false,
            showSlug: config.organization?.showSlug ?? true,
            teams: config.organization?.teams ?? discovered?.organization?.teams ?? false,
        },
        password: config.password ?? {},
        plugins: resolvePlugins(config.authClient, config.plugins, discovered),
        redirects: resolveRedirects(viewPaths, config.redirects),
        signUp: discovered?.signUp ?? true,
        social: config.social ?? discovered?.socialProviders ?? [],
        themeVariables: resolveThemeVariables(config.theme),
        viewPaths,
    };
};

/** Every {@link ViewPaths} key that names a screen, as opposed to the base they hang off. */
type ViewName = Exclude<keyof ViewPaths, "base">;

/**
 * The route one auth screen lives at — the configured base plus its segment.
 *
 * Every link between the screens goes through here rather than spelling a path,
 * so renaming a segment or moving the whole set under `viewPaths.base` moves the
 * links with it. See {@link ViewPaths.base}.
 */
const viewHref = (context: Pick<ControllerContext, "viewPaths">, view: ViewName): string => `${context.viewPaths.base}/${context.viewPaths[view]}`;

export type { AuthUIConfig, AvatarConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig, ViewName, ViewPaths };
export { DEFAULT_AVATAR_MAX_SIZE, DEFAULT_BASE_PATH, resolveContext, viewHref };
