"use client";

import { LunoraError } from "@lunora/errors";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { createContext, use, useEffect, useMemo, useRef, useState } from "react";

import type { AuthUIConfig, ControllerContext } from "../core";
import { resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";
import { resolveThemeVariables } from "../core/theme";

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
    /*
     * Callbacks and `nav` are naturally written inline (`nav={{ navigate: (to) =>
     * navigate(to) }}`), so a new identity arrives on every parent render. If those
     * identities reached the memo below, the context — and with it every controller
     * memoized on it — would be rebuilt mid-typing: fields blank, resource cards
     * refetch. So they are held in refs and reached through stable wrappers, and
     * only *values* participate in the key.
     */
    const latest = useRef({ nav, onError, onSessionChange });

    useEffect(() => {
        latest.current = { nav, onError, onSessionChange };
    }, [nav, onError, onSessionChange]);

    /*
     * A lazy `useState` initializer, not `useRef(...).current`: both keep the
     * first object forever, but reading `.current` during render is a ref read
     * the React Compiler refuses to optimize around (`react-hooks-js/refs`).
     * `useState`'s initial value is a plain render-safe value. Nothing ever
     * calls the setter, so this is a constant; every field reads through
     * `latest` at call time.
     */
    const [handlers] = useState(() => {return {
        nav: {
            navigate: (to: string): void => {
                (latest.current.nav ?? defaultNav).navigate(to);
            },
            replace: (to: string): void => {
                (latest.current.nav ?? defaultNav).replace(to);
            },
        },
        onError: (error: unknown): void => {
            latest.current.onError?.(error);
        },
        onSessionChange: (): void => {
            latest.current.onSessionChange?.();
        },
    }});

    // `theme` is a function, so its identity is as unstable as the callbacks —
    // key on what it *returns* instead, which is what the cards actually consume.
    const themeKey = JSON.stringify(resolveThemeVariables(theme));
    const configKey = JSON.stringify({ basePath, localization, plugins, redirects, social });

    const core = useMemo<ControllerContext>(
        () =>
            resolveContext({
                authClient,
                basePath,
                localization,
                nav: handlers.nav,
                onError: handlers.onError,
                onSessionChange: handlers.onSessionChange,
                plugins,
                redirects,
                social,
                theme,
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- object props are folded into configKey/themeKey; callbacks are ref-backed and stable.
        [authClient, handlers, configKey, themeKey],
    );

    // `Link` is deliberately outside the `core` memo: swapping it must not
    // recreate the controllers, only re-render the links.
    const value = useMemo<AuthUIReactContext>(() => {
        return { core, Link };
    }, [core, Link]);

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
