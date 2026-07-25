import type { App, Component, InjectionKey } from "vue";
import { inject, provide } from "vue";

import type { AuthClient, AuthUIConfig, ControllerContext, Localization, NavAdapter, PluginFlags, RedirectConfig } from "../core";
import { defaultNav, resolveContext } from "../core";

/**
 * The Vue context carries the resolved core {@link ControllerContext} plus an
 * optional framework `Link` component for internal navigation (Nuxt `NuxtLink`,
 * vue-router `RouterLink`, …). Mirrors the React port's `AuthUIReactContext`.
 */
interface AuthUIVueContext {
    core: ControllerContext;
    Link?: Component;
}

/**
 * Injection key carrying the resolved auth-UI context down the component tree.
 * Exported so advanced consumers can inject it by hand; most apps use
 * {@link createAuthUI} (plugin) or {@link AuthUIProvider} / {@link provideAuthUI}.
 */
const AUTH_UI_INJECTION_KEY: InjectionKey<AuthUIVueContext> = Symbol("lunora.auth-ui");

/** The user-facing config accepted by every Vue provider form. Mirrors React's `AuthUIProviderProps` (minus `children`). */
interface AuthUIProviderProps {
    authClient: AuthClient;
    /** Defaults to `/api/auth`. */
    basePath?: string;
    /**
     * Framework `Link` component for internal links (`NuxtLink`, `RouterLink`,
     * …). Falls back to a plain `<a>` when omitted.
     */
    Link?: Component;
    localization?: Partial<Localization>;
    /** Router bridge; defaults to a `location`-based fallback (`defaultNav`). */
    nav?: NavAdapter;
    onError?: (error: unknown) => void;
    onSessionChange?: () => void;
    plugins?: PluginFlags;
    redirects?: RedirectConfig;
    /** OAuth providers to render social buttons for (server-side config required). */
    social?: ReadonlyArray<string>;
    /** Retint the cards from config; see `core/theme.ts`. */
    theme?: AuthUIConfig["theme"];
}

/** Normalize the user-facing config into the injectable Vue context. */
const buildContext = (config: AuthUIProviderProps): AuthUIVueContext => {
    return {
        core: resolveContext({
            authClient: config.authClient,
            basePath: config.basePath,
            localization: config.localization,
            nav: config.nav ?? defaultNav,
            onError: config.onError,
            onSessionChange: config.onSessionChange,
            plugins: config.plugins,
            redirects: config.redirects,
            social: config.social,
            theme: config.theme,
        }),
        Link: config.Link,
    };
};

/**
 * Vue plugin form: `app.use(createAuthUI(config))`. Establishes the app-wide
 * auth-UI context every card resolves through {@link useAuthUI}. Mirrors the
 * React `AuthUIProvider` at the app root.
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
 * `<AuthUIProvider>` SFC. Must run synchronously inside `setup()`.
 */
const provideAuthUI = (config: AuthUIProviderProps): void => {
    provide(AUTH_UI_INJECTION_KEY, buildContext(config));
};

/** Read the resolved core controller context from the nearest provider. */
const useAuthUI = (): ControllerContext => {
    const value = inject(AUTH_UI_INJECTION_KEY, undefined);

    if (!value) {
        throw new Error(
            "useAuthUI(): no auth-UI context provided — use app.use(createAuthUI(config)), <AuthUIProvider>, or provideAuthUI(config) in a parent setup().",
        );
    }

    return value.core;
};

/** Read the optional framework `Link` component from the nearest provider. */
const useAuthUILink = (): Component | undefined => inject(AUTH_UI_INJECTION_KEY, undefined)?.Link;

export type { AuthUIProviderProps, AuthUIVueContext };
export { AUTH_UI_INJECTION_KEY, createAuthUI, provideAuthUI, useAuthUI, useAuthUILink };
