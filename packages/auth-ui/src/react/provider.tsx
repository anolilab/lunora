"use client";

import { LunoraError } from "@lunora/errors";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { createContext, use, useMemo } from "react";

import type { AuthUIConfig, ControllerContext } from "../core";
import { defaultNav, resolveContext } from "../core";

/** The React context also carries an optional framework `Link` for internal navigation. */
interface AuthUIReactContext {
    core: ControllerContext;
    Link?: ComponentType<{ children: ReactNode; className?: string; href: string }>;
}

const AuthUIContext = createContext<AuthUIReactContext | null>(null);

interface AuthUIProviderProps extends Omit<AuthUIConfig, "nav"> {
    children: ReactNode;

    /**
     * Framework `Link` component for internal links (Next `Link`, react-router
     * `Link`, …). Falls back to a plain `&lt;a>` when omitted.
     */
    Link?: ComponentType<{ children: ReactNode; className?: string; href: string }>;
    /** Router bridge; defaults to a `location`-based fallback. */
    nav?: AuthUIConfig["nav"];
}

/**
 * Provides the resolved auth-UI context to the tree. One base React component
 * set serves every meta-framework: pass your router into `nav`/`Link` (Next,
 * react-router, TanStack Start, Astro islands) and the cards navigate through it.
 */
const AuthUIProvider = ({
    authClient,
    basePath,
    children,
    Link,
    localization,
    nav,
    onError,
    onSessionChange,
    plugins,
    redirects,
    social,
    theme,
}: AuthUIProviderProps): ReactElement => {
    // Stringify the plain-object config so the context (and therefore every
    // controller memoized on it) stays referentially stable across renders.
    // `theme` is a function: it can't be JSON-stringified, so it joins the
    // identity-compared deps below instead of the serialized config key.
    const configKey = JSON.stringify({ basePath, localization, plugins, redirects, social });

    const value = useMemo<AuthUIReactContext>(
        () => {
            return {
                core: resolveContext({
                    authClient,
                    basePath,
                    localization,
                    nav: nav ?? defaultNav,
                    onError,
                    onSessionChange,
                    plugins,
                    redirects,
                    social,
                    theme,
                }),
                Link,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- object props are folded into configKey; primitives/callbacks are listed explicitly.
        [authClient, nav, Link, onError, onSessionChange, theme, configKey],
    );

    return <AuthUIContext value={value}>{children}</AuthUIContext>;
};

/** Read the resolved core controller context from the nearest provider. */
const useAuthUI = (): ControllerContext => {
    const value = use(AuthUIContext);

    if (!value) {
        throw new LunoraError("INTERNAL", "useAuthUI must be used inside <AuthUIProvider />");
    }

    return value.core;
};

/** Read the optional framework `Link` from the nearest provider. */
const useAuthUILink = (): AuthUIProviderProps["Link"] | undefined => use(AuthUIContext)?.Link;

export type { AuthUIProviderProps };
// eslint-disable-next-line react-refresh/only-export-components -- hooks are colocated with the provider by convention (mirrors @lunora/react's lunora-provider).
export { AuthUIProvider, useAuthUI, useAuthUILink };
