/**
 * Svelte component context for the auth UI.
 *
 * Mirrors the React provider's context: it carries the fully-resolved
 * {@link ControllerContext} plus an optional framework `Link` component for
 * internal navigation. A `Symbol` key keeps it from colliding with any other
 * library's context entry (same convention as `@lunora/svelte`'s client context).
 */
import type { Component, Snippet } from "svelte";
import { getContext, setContext } from "svelte";

import type { ControllerContext } from "../core/config";

/**
 * A framework `Link` component (SvelteKit's `<a>` wrapper, a custom router link,
 * …) accepting the same props the base cards pass: `href`, an optional `class`,
 * and its `children` snippet. Falls back to a plain `<a>` when omitted.
 */
type AuthUILinkComponent = Component<{ children?: Snippet; class?: string; href: string }>;

/** The value published on the Svelte context tree by `<AuthUIProvider>`. */
interface AuthUISvelteContext {
    core: ControllerContext;
    Link?: AuthUILinkComponent;
}

const AUTH_UI_CONTEXT_KEY = Symbol("lunora.auth-ui");

/**
 * Publish the resolved auth-UI context on the Svelte component tree. Called once
 * by `<AuthUIProvider>` during its initialisation (the `setContext` constraint),
 * exactly like React's provider mounts once.
 */
const setAuthUIContext = (value: AuthUISvelteContext): AuthUISvelteContext => {
    setContext(AUTH_UI_CONTEXT_KEY, value);

    return value;
};

/**
 * Read the resolved core controller context from the nearest `<AuthUIProvider>`.
 * Throws — loud and early — when no provider is mounted, mirroring React's
 * `useAuthUI` guard. Must be called during component initialisation.
 */
const useAuthUI = (): ControllerContext => {
    const value = getContext<AuthUISvelteContext | undefined>(AUTH_UI_CONTEXT_KEY);

    if (!value) {
        throw new Error("useAuthUI() must be called inside <AuthUIProvider>");
    }

    return value.core;
};

/** Read the optional framework `Link` from the nearest provider. */
const useAuthUILink = (): AuthUILinkComponent | undefined => getContext<AuthUISvelteContext | undefined>(AUTH_UI_CONTEXT_KEY)?.Link;

export type { AuthUILinkComponent, AuthUISvelteContext };
export { setAuthUIContext, useAuthUI, useAuthUILink };
