import { LunoraError } from "@lunora/errors";
import type { Component, Context, JSX } from "solid-js";
import { createContext, createMemo, createSignal, onCleanup, Show, useContext } from "solid-js";

import type { AuthUIConfig, ControllerContext } from "../core/config";
import { DEFAULT_BASE_PATH, resolveContext } from "../core/config";
import { defaultNav } from "../core/default-nav";
import type { DiscoveredConfig } from "../core/discovery";
import { discoverAuthConfig } from "../core/discovery";

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
 * through it.
 *
 * Treat the config as read once: cards capture the context when they are
 * created, so swapping `authClient` afterwards won't reach an already-mounted
 * card. Configure the provider at mount, as you would a router.
 *
 * The one exception is server discovery, which by definition answers *after*
 * mount. Its answer produces a **new** context object, and the keyed `<Show>`
 * below re-creates the tree on that new identity. That is load-bearing rather
 * than incidental: every card resolves its gate once in its body
 * (`const enabled = isFlowEnabled(context, …)`) and passes the answer to its
 * controller's `autoLoad`, so a context mutated in place would freeze every gate
 * at its pre-discovery value — a card the server says doesn't exist would stay
 * rendered, having already fired a request that 404s. Discovery settles exactly
 * once, early, so this costs one rebuild.
 */
const AuthUIProvider = (props: AuthUIProviderProps): JSX.Element => {
    /*
     * Callbacks are naturally written inline (`nav={{ navigate: (to) =>
     * navigate(to) }}`), so they are reached through stable wrappers rather than
     * captured. Two reasons, both about *not* rebuilding: the memo below never
     * reads those props, so nothing a callback expression closes over can retrigger
     * it; and a swapped callback reaches controllers that were created earlier,
     * because the wrapper reads through at call time. Only *values* — and the
     * discovered config — decide the context identity.
     */
    const handlers = {
        nav: {
            navigate: (to: string): void => {
                (props.nav ?? defaultNav).navigate(to);
            },
            replace: (to: string): void => {
                (props.nav ?? defaultNav).replace(to);
            },
        },
        onError: (error: unknown): void => {
            props.onError?.(error);
        },
        onSessionChange: (): void => {
            props.onSessionChange?.();
        },

        /*
         * `avatar.upload` gets the same treatment, with one wrinkle: only its
         * *presence* is a config decision (it decides whether the card shows a
         * file picker or a URL field), so presence is read into the memo while
         * the function itself is reached through here.
         */
        upload: async (file: File): Promise<string> => {
            const handler = props.avatar?.upload;

            if (handler === undefined) {
                throw new LunoraError("INTERNAL", "no avatar upload handler is configured");
            }

            return handler(file);
        },
    };

    /*
     * Ask the server which plugins and providers are on. The request is shared
     * process-wide per endpoint (see `discovery.ts`), so mounting several
     * providers costs one fetch; subscribing here is what turns the answer into
     * a rebuilt context. Reading the handle synchronously — rather than in an
     * effect — means a cached answer is already in the first render.
     */
    const [discovered, setDiscovered] = createSignal<DiscoveredConfig | undefined>(undefined);

    if (props.discover !== false) {
        const handle = discoverAuthConfig(props.basePath ?? DEFAULT_BASE_PATH);

        setDiscovered(() => handle.getState().config);
        onCleanup(
            handle.subscribe(() => {
                setDiscovered(() => handle.getState().config);
            }),
        );
    }

    const core = createMemo<ControllerContext>(() =>
        resolveContext(
            {
                authClient: props.authClient,
                avatar: { maxSize: props.avatar?.maxSize, upload: props.avatar?.upload === undefined ? undefined : handlers.upload },
                basePath: props.basePath,
                forgotPassword: props.forgotPassword,
                localization: props.localization,
                nav: handlers.nav,
                onError: handlers.onError,
                onSessionChange: handlers.onSessionChange,
                organization: props.organization,
                password: props.password,
                plugins: props.plugins,
                redirects: props.redirects,
                social: props.social,
                theme: props.theme,
                viewPaths: props.viewPaths,
            },
            discovered(),
        ),
    );

    return (
        // `keyed`, so the tree is disposed and re-created on the new context
        // *identity* discovery produces. A Solid context value is read once by
        // each consumer, so an in-place field swap would reach nothing; and the
        // disposal is what re-runs each card's gate and lets `createController`
        // destroy the controller built against the stale context.
        //
        // `Link` is deliberately a getter rather than part of the keyed value:
        // swapping it must re-render the links, not re-create every controller.
        <Show keyed when={core()}>
            {(resolved) => (
                <AuthUIContext.Provider
                    value={{
                        core: resolved,
                        get Link() {
                            return props.Link;
                        },
                    }}
                >
                    {props.children}
                </AuthUIContext.Provider>
            )}
        </Show>
    );
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
