import type { App, Component, InjectionKey, ShallowRef } from "vue";
import { inject, provide, shallowRef } from "vue";

import type { AuthUIConfig, AvatarConfig, ControllerContext, NavAdapter, PluginFlags, RedirectConfig, ViewPaths } from "../core/config";
import { DEFAULT_BASE_PATH, resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";
import type { DiscoveredConfig } from "../core/discovery";
import { discoverAuthConfig } from "../core/discovery";
import type { Localization } from "../core/localization";
import type { PasswordPolicy } from "../core/password-policy";
import type { AnyAuthClient } from "../core/types";

/**
 * The Vue context carries the resolved core {@link ControllerContext} plus an
 * optional framework `Link` component for internal navigation (Nuxt `NuxtLink`,
 * vue-router `RouterLink`, …). Mirrors the React port's `AuthUIReactContext`.
 */
interface AuthUIVueContext {
    /**
     * The resolved core context. A ref because server discovery replaces it —
     * identity and all — exactly once, and consumers have to be able to notice.
     */
    core: ShallowRef<ControllerContext>;
    Link?: Component;
}

/**
 * Injection key carrying the resolved auth-UI context down the component tree.
 * Exported so advanced consumers can inject it by hand; most apps use
 * {@link createAuthUI} (plugin) or `AuthUIProvider` / {@link provideAuthUI}.
 */
const AUTH_UI_INJECTION_KEY: InjectionKey<AuthUIVueContext> = Symbol("lunora.auth-ui");

/** The user-facing config accepted by every Vue provider form. Mirrors React's `AuthUIProviderProps` (minus `children`). */
interface AuthUIProviderProps {
    authClient: AnyAuthClient;
    /** How avatars are stored; without an `upload` the profile card offers a URL field. */
    avatar?: AvatarConfig;
    /** Defaults to `/api/auth`. */
    basePath?: string;

    /**
     * Ask the server which plugins and social providers are enabled, via the
     * `uiConfig()` better-auth plugin. On by default; it degrades silently to
     * the client-side registration when the endpoint isn't mounted.
     */
    discover?: boolean;

    /** Password rules, mirrored from your server's `emailAndPassword` config. */
    /** Which password-reset transport the app uses. */
    forgotPassword?: AuthUIConfig["forgotPassword"];

    /**
     * Framework `Link` component for internal links (`NuxtLink`, `RouterLink`,
     * …). Falls back to a plain `&lt;a>` when omitted.
     */
    Link?: Component;
    localization?: Partial<Localization>;
    /** Router bridge; defaults to a `location`-based fallback (`defaultNav`). */
    nav?: NavAdapter;
    onError?: (error: unknown) => void;
    onSessionChange?: () => void;
    /** Organization UI options. */
    organization?: AuthUIConfig["organization"];
    password?: PasswordPolicy;
    plugins?: PluginFlags;
    redirects?: RedirectConfig;
    /** OAuth providers to render social buttons for (server-side config required). */
    social?: ReadonlyArray<string>;
    /** Retint the cards from config; see `core/theme.ts`. */
    theme?: AuthUIConfig["theme"];
    /** URL segments `&lt;AuthView>` maps to cards; see `core/config.ts`. */
    viewPaths?: ViewPaths;
}

/** Normalize the user-facing config into the injectable Vue context. */
const buildContext = (config: AuthUIProviderProps): AuthUIVueContext => {
    /*
     * Callbacks are naturally written inline (`:nav="{ navigate: (to) => router.push(to) }"`),
     * so a fresh identity arrives whenever the parent re-renders. Reading them at
     * *call* time through these stable wrappers buys what React buys with a ref:
     * the context — and every controller built on it — is never rebuilt
     * mid-typing, and no handler is ever captured stale, because `config` is the
     * component's reactive `props` object.
     */
    const handlers = {
        nav: {
            navigate: (to: string): void => {
                (config.nav ?? defaultNav).navigate(to);
            },
            replace: (to: string): void => {
                (config.nav ?? defaultNav).replace(to);
            },
        },
        onError: (error: unknown): void => {
            config.onError?.(error);
        },
        onSessionChange: (): void => {
            config.onSessionChange?.();
        },
        /*
         * `avatar.upload` is a callback like the rest and gets the same
         * treatment. Without the wrapper an inline `:avatar="{ upload: async (file) => … }"`
         * would be captured on the first render and never updated.
         */
        upload: async (file: File): Promise<string> => {
            const upload = config.avatar?.upload;

            if (upload === undefined) {
                throw new Error("avatar upload was called but no upload handler is configured");
            }

            return upload(file);
        },
    };

    const resolve = (discovered?: DiscoveredConfig): ControllerContext =>
        resolveContext(
            {
                authClient: config.authClient,
                // Only `upload`'s *presence* is a config decision (it decides
                // whether the card shows a file picker or a URL field); the
                // function itself is reached through the stable wrapper.
                avatar: { maxSize: config.avatar?.maxSize, upload: config.avatar?.upload === undefined ? undefined : handlers.upload },
                basePath: config.basePath,
                forgotPassword: config.forgotPassword,
                localization: config.localization,
                nav: handlers.nav,
                onError: handlers.onError,
                onSessionChange: handlers.onSessionChange,
                organization: config.organization,
                password: config.password,
                plugins: config.plugins,
                redirects: config.redirects,
                social: config.social,
                theme: config.theme,
                viewPaths: config.viewPaths,
            },
            discovered,
        );

    /*
     * A `shallowRef` holding a whole context, not a reactive context whose fields
     * are patched: the *identity* is the signal. Swapping the object is what lets
     * a consumer notice — `useController` rebuilds its controller on it, and a
     * card's gate is a `computed` over this ref rather than a boolean read in
     * `setup()`, which Vue never re-runs. Together those are what React gets for
     * free by re-rendering every consumer of a rebuilt context, and they work the
     * same under either provider form.
     *
     * Shallow because nothing below the top level is ever mutated, and because
     * `authClient` has to reach better-auth unproxied.
     */
    const core = shallowRef(resolve());

    if (config.discover !== false) {
        /*
         * The request is shared process-wide per endpoint (see `discovery.ts`),
         * so mounting several providers costs one fetch; subscribing here is what
         * turns the answer into a rebuilt context. Failure is silent by design —
         * the gate falls back to what `client.ts` registered.
         */
        const handle = discoverAuthConfig(config.basePath ?? DEFAULT_BASE_PATH);
        let stop: (() => void) | undefined;

        const sync = (): void => {
            const { config: discovered, status } = handle.getState();

            // Only a *payload* is new information. An unreachable endpoint must
            // not churn the identity, or every deployment without `uiConfig()`
            // would pay a subtree rebuild to learn nothing.
            if (discovered !== undefined) {
                core.value = resolve(discovered);
            }

            // Discovery settles exactly once, so the subscription is dropped as
            // soon as it does rather than being held for the provider's life —
            // `createAuthUI` has no effect scope to release it from.
            if (status !== "loading") {
                stop?.();
            }
        };

        stop = handle.subscribe(sync);
        // Cheap catch-up for the second provider on a page, whose request already settled.
        sync();
    }

    return { core, Link: config.Link };
};

/**
 * Vue plugin form: `app.use(createAuthUI(config))`. Establishes the app-wide
 * auth-UI context every card resolves through {@link useAuthUI}. Mirrors the
 * React `AuthUIProvider` at the app root.
 *
 * Interchangeable with `AuthUIProvider`: both publish the same context
 * ref, and the things discovery can change — a card's `v-if` gate, a controller's
 * `autoLoad`, the social provider list — are read *through* that ref, so they
 * re-evaluate when the server answers. Neither form needs a component boundary
 * to make that happen. Choose between them on scope: this one is app-wide,
 * `&lt;AuthUIProvider>` scopes the context to a subtree.
 */
const createAuthUI = (config: AuthUIProviderProps): { install: (app: App) => void } => {
    const context = buildContext(config);

    return {
        install(app: App): void {
            app.provide(AUTH_UI_INJECTION_KEY, context);
        },
    };
};

/**
 * Composition-API form: call inside a parent component's `setup()` to provide
 * the context to its subtree. The counterpart to `app.use(createAuthUI(config))`
 * when you'd rather scope the context to a subtree than the whole app. Backs the
 * `&lt;AuthUIProvider>` SFC. Must run synchronously inside `setup()`.
 */
const provideAuthUI = (config: AuthUIProviderProps): ShallowRef<ControllerContext> => {
    const context = buildContext(config);

    provide(AUTH_UI_INJECTION_KEY, context);

    return context.core;
};

/**
 * The context ref from the nearest provider — use this whenever what you read
 * has to *follow* the one identity change discovery makes: the plugin flags,
 * `credentials`, `social`, `organization`. Bound in `&lt;script setup>` the template
 * unwraps it on every read, so `v-if="context.plugins.passkey"` is reactive
 * without further ceremony; in script, wrap the read in a `computed`.
 *
 * {@link useAuthUI} is the simpler read for everything discovery cannot change —
 * localization, theme, redirects, `viewPaths`.
 */
const useAuthUIContextRef = (): ShallowRef<ControllerContext> => {
    const value = inject(AUTH_UI_INJECTION_KEY, undefined);

    if (!value) {
        throw new Error(
            "useAuthUI(): no auth-UI context provided — use app.use(createAuthUI(config)), <AuthUIProvider>, or provideAuthUI(config) in a parent setup().",
        );
    }

    return value.core;
};

/**
 * Read the resolved core controller context from the nearest provider, as a
 * plain object.
 *
 * A snapshot taken when the caller's `setup()` ran, which is the right read for
 * everything server discovery cannot change (localization, theme, redirects,
 * `viewPaths`) and the wrong one for everything it can — see
 * {@link useAuthUIContextRef}.
 */
const useAuthUI = (): ControllerContext => useAuthUIContextRef().value;

/** Read the optional framework `Link` component from the nearest provider. */
const useAuthUILink = (): Component | undefined => inject(AUTH_UI_INJECTION_KEY, undefined)?.Link;

export type { AuthUIProviderProps, AuthUIVueContext };
export { AUTH_UI_INJECTION_KEY, createAuthUI, provideAuthUI, useAuthUI, useAuthUIContextRef, useAuthUILink };
