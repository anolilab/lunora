/**
 * Angular provider for the auth UI. `provideAuthUI(config)` returns the
 * environment providers that expose the resolved {@link ControllerContext}
 * (plus an optional client-side navigation hook for internal links) through the
 * {@link AUTH_UI_CONTEXT} injection token. Mirrors React's `<AuthUIProvider>`:
 * one base component set serves every meta-framework — pass your router into
 * `nav`/`link` and the cards navigate through it.
 */
import type { EnvironmentProviders, Signal } from "@angular/core";
import { computed, DestroyRef, inject, InjectionToken, makeEnvironmentProviders, signal, untracked } from "@angular/core";
import { LunoraError } from "@lunora/errors";

import type { AuthUIConfig, ControllerContext, NavAdapter } from "../core/config";
import { DEFAULT_BASE_PATH, resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";
import type { DiscoveredConfig } from "../core/discovery";
import { discoverAuthConfig } from "../core/discovery";

/**
 * The Angular-facing config. Mirrors {@link AuthUIConfig} but makes `nav`
 * optional (defaults to {@link defaultNav}) and swaps React's `Link` component
 * for a plain `link` callback — Angular composes navigation through a function,
 * not a passed component.
 */
interface AuthUIAngularConfig extends Omit<AuthUIConfig, "nav"> {
    /**
     * Client-side navigation for internal auth links (router `navigate`, etc.).
     * When set, `AuthLinkComponent` intercepts the click and calls this
     * instead of a full page load; when omitted the link is a plain `<a href>`.
     */
    link?: (href: string) => void;
    /** Router bridge for programmatic redirects; defaults to {@link defaultNav}. */
    nav?: NavAdapter;
}

/**
 * What the injection token carries: the resolved core context + the optional
 * link hook.
 *
 * `core` is a signal rather than a value because server discovery arrives after
 * the provider is created. When it lands, {@link resolveContext} produces a
 * **new** context object and the signal swaps to it — identity and all. Every
 * gate (`isFlowEnabled`) and every `autoLoad` decision is derived from that
 * identity, so swapping it is what makes the answer take effect; mutating the
 * old object in place would leave each card frozen on the gate it computed at
 * mount, still rendering a card the server says doesn't exist.
 */
interface AuthUIAngularContext {
    core: Signal<ControllerContext>;
    link?: (href: string) => void;
}

/**
 * DI token carrying the resolved auth-UI context. Every card reads it via
 * {@link injectAuthUIContext}; a single {@link provideAuthUI} in the application
 * config wires the whole tree.
 */
const AUTH_UI_CONTEXT: InjectionToken<AuthUIAngularContext> = new InjectionToken<AuthUIAngularContext>("lunora.auth-ui.context");

/**
 * Wire the auth UI into the application injector. Add the result to the
 * `providers` array of an Angular application config:
 *
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *     providers: [provideAuthUI({ authClient })],
 * };
 * ```
 */
const provideAuthUI = (config: AuthUIAngularConfig): EnvironmentProviders =>
    makeEnvironmentProviders([
        {
            provide: AUTH_UI_CONTEXT,
            useFactory: (): AuthUIAngularContext => {
                /*
                 * Callbacks reach the controllers through stable wrappers that
                 * read `config` at call time. React needs this because inline
                 * props arrive with a new identity every render; here it buys
                 * the same guarantee for a config object an app mutates after
                 * bootstrap. Either way the wrappers keep callbacks out of the
                 * context's identity, so the only thing that swaps it is the
                 * discovery answer below.
                 */
                const base: AuthUIConfig = {
                    authClient: config.authClient,
                    avatar: config.avatar,
                    basePath: config.basePath,
                    forgotPassword: config.forgotPassword,
                    localization: config.localization,
                    nav: {
                        navigate: (to: string) => {
                            (config.nav ?? defaultNav).navigate(to);
                        },
                        replace: (to: string) => {
                            (config.nav ?? defaultNav).replace(to);
                        },
                    },
                    onError: (error: unknown) => {
                        config.onError?.(error);
                    },
                    onSessionChange: () => {
                        config.onSessionChange?.();
                    },
                    organization: config.organization,
                    password: config.password,
                    plugins: config.plugins,
                    redirects: config.redirects,
                    social: config.social,
                    theme: config.theme,
                    viewPaths: config.viewPaths,
                };

                const discovered = signal<DiscoveredConfig | undefined>(undefined);
                // A fresh object per answer, on purpose: the controller bridge
                // keys on this identity and rebuilds when it swaps.
                const resolved = computed(() => resolveContext(base, discovered()));

                if (config.discover !== false) {
                    /*
                     * Ask the server which plugins and providers are on. The request
                     * is shared process-wide per endpoint (see `discovery.ts`), so
                     * several providers cost one fetch, and a deployment without the
                     * `uiConfig()` plugin resolves to `unavailable` rather than
                     * failing — discovery is an upgrade, never a dependency.
                     */
                    const handle = discoverAuthConfig(config.basePath ?? DEFAULT_BASE_PATH);

                    // A handle shared with an earlier provider may already carry the
                    // answer, in which case no notification is coming.
                    discovered.set(handle.getState().config);

                    const unsubscribe = handle.subscribe(() => {
                        discovered.set(handle.getState().config);
                    });

                    inject(DestroyRef).onDestroy(unsubscribe);
                }

                return { core: resolved, link: config.link };
            },
        },
    ]);

/**
 * Read the live core controller context from the nearest provider. Call inside
 * an injection context (a component/service field initializer or constructor).
 *
 * This is the handle cards should hold: reading it inside a template or a
 * `computed` re-evaluates when server discovery lands, and passing it to
 * `controllerSignal` is what lets the bridge rebuild the controller for
 * the new context.
 */
const injectAuthUIContext = (): Signal<ControllerContext> => {
    const context = inject(AUTH_UI_CONTEXT, { optional: true });

    if (!context) {
        throw new LunoraError("INTERNAL", "injectAuthUIContext() requires provideAuthUI(...) in the application providers");
    }

    return context.core;
};

/**
 * The resolved context as a plain snapshot, for the places that genuinely don't
 * change with discovery (the theme variables, the localization table) and for
 * one-off imperative reads. Use {@link injectAuthUIContext} for anything gated.
 *
 * The read is `untracked` so a snapshot can never quietly become a dependency of
 * whatever view happens to be constructing the caller.
 */
const injectAuthUI = (): ControllerContext => {
    const context = inject(AUTH_UI_CONTEXT, { optional: true });

    if (!context) {
        throw new LunoraError("INTERNAL", "injectAuthUI() requires provideAuthUI(...) in the application providers");
    }

    return untracked(context.core);
};

/** Read the optional client-side navigation hook from the nearest provider. */
const injectAuthUILink = (): ((href: string) => void) | undefined => inject(AUTH_UI_CONTEXT, { optional: true })?.link;

export type { AuthUIAngularConfig, AuthUIAngularContext };
export { AUTH_UI_CONTEXT, injectAuthUI, injectAuthUIContext, injectAuthUILink, provideAuthUI };
