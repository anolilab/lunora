/**
 * Angular provider for the auth UI. `provideAuthUI(config)` returns the
 * environment providers that expose the resolved {@link ControllerContext}
 * (plus an optional client-side navigation hook for internal links) through the
 * {@link AUTH_UI_CONTEXT} injection token. Mirrors React's `<AuthUIProvider>`:
 * one base component set serves every meta-framework — pass your router into
 * `nav`/`link` and the cards navigate through it.
 */
import type { EnvironmentProviders } from "@angular/core";
import { inject, InjectionToken, makeEnvironmentProviders } from "@angular/core";
import { LunoraError } from "@lunora/errors";

import type { AuthUIConfig, ControllerContext, NavAdapter } from "../core/config";
import { resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";

/**
 * The Angular-facing config. Mirrors {@link AuthUIConfig} but makes `nav`
 * optional (defaults to {@link defaultNav}) and swaps React's `Link` component
 * for a plain `link` callback — Angular composes navigation through a function,
 * not a passed component.
 */
interface AuthUIAngularConfig extends Omit<AuthUIConfig, "nav"> {
    /**
     * Client-side navigation for internal auth links (router `navigate`, etc.).
     * When set, {@link AuthLinkComponent} intercepts the click and calls this
     * instead of a full page load; when omitted the link is a plain `<a href>`.
     */
    link?: (href: string) => void;
    /** Router bridge for programmatic redirects; defaults to {@link defaultNav}. */
    nav?: NavAdapter;
}

/** What the injection token carries: the resolved core context + the optional link hook. */
interface AuthUIAngularContext {
    core: ControllerContext;
    link?: (href: string) => void;
}

/**
 * DI token carrying the resolved auth-UI context. Every card reads it via
 * {@link injectAuthUI}; a single {@link provideAuthUI} in the application config
 * wires the whole tree.
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
                    link: config.link,
                };
            },
        },
    ]);

/**
 * Read the resolved core controller context from the nearest provider. Call
 * inside an injection context (a component/service field initializer or
 * constructor).
 */
const injectAuthUI = (): ControllerContext => {
    const context = inject(AUTH_UI_CONTEXT, { optional: true });

    if (!context) {
        throw new LunoraError("INTERNAL", "injectAuthUI() requires provideAuthUI(...) in the application providers");
    }

    return context.core;
};

/** Read the optional client-side navigation hook from the nearest provider. */
const injectAuthUILink = (): ((href: string) => void) | undefined => inject(AUTH_UI_CONTEXT, { optional: true })?.link;

export type { AuthUIAngularConfig, AuthUIAngularContext };
export { AUTH_UI_CONTEXT, injectAuthUI, injectAuthUILink, provideAuthUI };
