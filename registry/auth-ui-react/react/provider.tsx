"use client";

import { LunoraError } from "@lunora/errors";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { createContext, use, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { AuthUIConfig, ControllerContext, DiscoveryState } from "../core";
import { DEFAULT_BASE_PATH, resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";
import { discoverAuthConfig } from "../core/discovery";
import { resolveThemeVariables } from "../core/theme";

/**
 * The snapshot used when discovery is off. Module-level so its identity is
 * stable — `useSyncExternalStore` re-renders forever if `getSnapshot` returns a
 * fresh object each call.
 */
const NO_DISCOVERY: DiscoveryState = { status: "unavailable" };

const noopSubscribe = (): (() => void) => () => {};

const readNoDiscovery = (): DiscoveryState => NO_DISCOVERY;

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
    avatar,
    basePath,
    children,
    discover,
    forgotPassword,
    Link,
    localization,
    nav,
    onError,
    onSessionChange,
    organization,
    password,
    plugins,
    redirects,
    social,
    theme,
    viewPaths,
}: AuthUIProviderProps): ReactElement => {
    /*
     * Callbacks and `nav` are naturally written inline (`nav={{ navigate: (to) =>
     * navigate(to) }}`), so a new identity arrives on every parent render. If those
     * identities reached the memo below, the context — and with it every controller
     * memoized on it — would be rebuilt mid-typing: fields blank, resource cards
     * refetch. So they are held in refs and reached through stable wrappers, and
     * only *values* participate in the key.
     */
    const latest = useRef({ avatar, nav, onError, onSessionChange });

    useEffect(() => {
        latest.current = { avatar, nav, onError, onSessionChange };
    }, [avatar, nav, onError, onSessionChange]);

    /*
     * A lazy `useState` initializer, not `useRef(...).current`: both keep the
     * first object forever, but reading `.current` during render is a ref read
     * the React Compiler refuses to optimize around (`react-hooks-js/refs`).
     * `useState`'s initial value is a plain render-safe value. Nothing ever
     * calls the setter, so this is a constant; every field reads through
     * `latest` at call time.
     */
    const [handlers] = useState(() => {
        return {
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
            /*
             * `avatar.upload` is a callback like the rest, so it gets the same
             * treatment: a stable wrapper that reads through `latest`. Without
             * this, an inline `upload={async (file) => …}` would either rebuild
             * every controller on each render or be captured stale forever.
             */
            upload: async (file: File): Promise<string> => {
                const upload = latest.current.avatar?.upload;

                if (upload === undefined) {
                    throw new LunoraError("INTERNAL", "no avatar upload handler is configured");
                }

                return upload(file);
            },
        };
    });

    /*
     * Ask the server which plugins and providers are on. The request is shared
     * process-wide per endpoint (see `discovery.ts`), so mounting several
     * providers costs one fetch; subscribing here is what turns the answer into
     * a re-render.
     */
    const handle = useMemo(() => (discover === false ? undefined : discoverAuthConfig(basePath ?? DEFAULT_BASE_PATH)), [discover, basePath]);
    const discovery = useSyncExternalStore(handle?.subscribe ?? noopSubscribe, handle?.getState ?? readNoDiscovery, readNoDiscovery);

    // `theme` is a function, so its identity is as unstable as the callbacks —
    // key on what it *returns* instead, which is what the cards actually consume.
    const themeKey = JSON.stringify(resolveThemeVariables(theme));
    const configKey = JSON.stringify({
        avatar: { hasUpload: avatar?.upload !== undefined, maxSize: avatar?.maxSize },
        basePath,
        forgotPassword,
        localization,
        organization,
        password,
        plugins,
        redirects,
        social,
        viewPaths,
    });
    // The discovered payload is a fresh object per fetch but settles exactly
    // once, so keying on its content keeps the memo from churning on re-renders
    // while still rebuilding the context when the answer lands.
    const discoveryKey = JSON.stringify(discovery.config ?? null);

    const core = useMemo<ControllerContext>(
        () =>
            resolveContext(
                {
                    authClient,
                    // Only `upload`'s *presence* is a config decision (it decides
                    // whether the card shows a file picker or a URL field); the
                    // function itself is reached through the stable wrapper.
                    avatar: { maxSize: avatar?.maxSize, upload: avatar?.upload === undefined ? undefined : handlers.upload },
                    basePath,
                    forgotPassword,
                    localization,
                    nav: handlers.nav,
                    onError: handlers.onError,
                    onSessionChange: handlers.onSessionChange,
                    organization,
                    password,
                    plugins,
                    redirects,
                    social,
                    theme,
                    viewPaths,
                },
                discovery.config,
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- object props are folded into configKey/themeKey/discoveryKey; callbacks are ref-backed and stable.
        [authClient, handlers, configKey, themeKey, discoveryKey],
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
