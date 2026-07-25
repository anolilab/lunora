import { LunoraError } from "@lunora/errors";
import type { Component, Context, JSX } from "solid-js";
import { createContext, createMemo, useContext } from "solid-js";

import type { AuthUIConfig, ControllerContext } from "../core";
import { defaultNav, resolveContext } from "../core";

/** A framework `Link` component for internal navigation (Solid Router `A`, plain `<a>`, …). */
type AuthUILink = Component<{ children: JSX.Element; class?: string; href: string }>;

/** The Solid context also carries an optional framework `Link` for internal navigation. */
interface AuthUISolidContext {
    core: ControllerContext;
    Link?: AuthUILink;
}

const AuthUIContext: Context<AuthUISolidContext | undefined> = createContext<AuthUISolidContext | undefined>();

interface AuthUIProviderProps extends Omit<AuthUIConfig, "nav"> {
    children: JSX.Element;

    /**
     * Framework `Link` component for internal links (Solid Router `A`, …). Falls
     * back to a plain `<a>` when omitted.
     */
    Link?: AuthUILink;
    /** Router bridge; defaults to a `location`-based fallback. */
    nav?: AuthUIConfig["nav"];
}

/**
 * Provides the resolved auth-UI context to the tree. One base Solid component set
 * serves every setup: pass your router into `nav`/`Link` and the cards navigate
 * through it. Props are read lazily inside a {@link createMemo} so swapping any of
 * them re-resolves the context for descendants.
 */
const AuthUIProvider = (props: AuthUIProviderProps): JSX.Element => {
    const value = createMemo<AuthUISolidContext>(() => {
        return {
            core: resolveContext({
                authClient: props.authClient,
                basePath: props.basePath,
                localization: props.localization,
                nav: props.nav ?? defaultNav,
                onError: props.onError,
                onSessionChange: props.onSessionChange,
                plugins: props.plugins,
                redirects: props.redirects,
                social: props.social,
                theme: props.theme,
            }),
            Link: props.Link,
        };
    });

    return <AuthUIContext.Provider value={value()}>{props.children}</AuthUIContext.Provider>;
};

/** Read the resolved core controller context from the nearest provider. */
const useAuthUI = (): ControllerContext => {
    const value = useContext(AuthUIContext);

    if (!value) {
        throw new LunoraError("INTERNAL", "useAuthUI must be used inside <AuthUIProvider />");
    }

    return value.core;
};

/** Read the optional framework `Link` from the nearest provider. */
const useAuthUILink = (): AuthUILink | undefined => useContext(AuthUIContext)?.Link;

export type { AuthUILink, AuthUIProviderProps };
export { AuthUIProvider, useAuthUI, useAuthUILink };
