/**
 * The screens for being an OAuth *provider* — the other side of every other
 * flow in this package.
 *
 * Everywhere else, your app is the client: the user signs in to you. Here your
 * app is the authorization server, and a third-party application is asking to
 * act on the user's behalf. `@better-auth/oauth-provider` implements the
 * protocol; what it cannot supply is the one screen that must not be automatic —
 * the consent prompt — plus the place a user goes to take that consent back.
 *
 * # The consent screen is a security surface, not a form
 *
 * Two rules follow from that, and both are enforced here rather than left to a
 * view:
 *
 * Nothing is pre-approved. The controller loads the pending request and waits;
 * it never auto-accepts, not even when the scopes look harmless, because an
 * auto-accepting consent screen is indistinguishable from no consent screen.
 *
 * Deny is never harder than approve. Both are one call, both are always
 * available, and a failure to load the request resolves to *no decision* rather
 * than to a default — a broken consent screen must not become an approving one.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk, mapAuthError } from "./map-error";
import { isSafeRedirect } from "./redirect-to";
import { createStore } from "./store";
import type { Controller, FlowStatus, OAuthConsent, OAuthPendingConsent } from "./types";

interface ConsentState {
    error?: string;
    loading: boolean;
    /** The pending request, once loaded. Absent means there is nothing to decide. */
    request?: OAuthPendingConsent;
    status: FlowStatus;
}

interface ConsentActions {
    /** Grant the requested scopes and hand control back to the application. */
    accept: () => Promise<void>;
    /** Refuse. Same cost as `accept` — see the note above. */
    deny: () => Promise<void>;
    load: () => Promise<void>;
}

type ConsentController = Controller<ConsentState, ConsentActions>;

interface ConsentOptions {
    autoLoad?: boolean;
    /** The pending consent id, from `?consent_id=` on the authorize redirect. */
    consentId?: string;
}

/**
 * Whether `value` is an absolute `http:`/`https:` URL — the only kind of
 * off-origin destination this screen ever hands to the browser.
 *
 * Parsed rather than prefix-matched on purpose: the URL parser strips the
 * leading whitespace, tabs and newlines a browser also strips before resolving
 * the scheme, and lowercases it, so `"\n JavaScript:alert(1)"` is recognised as
 * `javascript:` rather than passing a naive `startsWith("http")` test.
 */
const isHttpUrl = (value: string): boolean => {
    try {
        const { protocol } = new URL(value);

        return protocol === "http:" || protocol === "https:";
    } catch {
        // Not an absolute URL at all — and it already failed `isSafeRedirect`,
        // so it is not a path either.
        return false;
    }
};

/**
 * Drive one pending consent request.
 *
 * `accept`/`deny` both resolve by *navigating*: better-auth answers with the
 * redirect back to the requesting application, and following it is the point of
 * the screen. When it answers without one — an expired request, say — the
 * controller surfaces the error and stays put rather than guessing a
 * destination, because guessing here means sending an authorization code
 * somewhere nobody asked for.
 */
const createConsentController = (context: ControllerContext, options: ConsentOptions = {}): ConsentController => {
    const store = createStore<ConsentState>({ loading: true, status: "idle" });

    const load = async (): Promise<void> => {
        const id = options.consentId?.trim();

        if (id === undefined || id === "") {
            store.update({ error: context.localization.consentMissing, loading: false, status: "error" });

            return;
        }

        store.update({ error: undefined, loading: true });

        try {
            const request = assertOk(await context.authClient.oauth2.getConsent({ query: { id } })).data ?? undefined;

            store.update({ loading: false, request, status: "idle" });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.consentMissing), loading: false, status: "error" });
        }
    };

    const decide = async (accept: boolean): Promise<void> => {
        if (store.get().status === "submitting" || store.get().request === undefined) {
            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            const response = assertOk(await context.authClient.oauth2.consent({ accept }));
            const redirect = response.data?.redirectURI;

            if (redirect === undefined || redirect === "") {
                // No redirect means the request is no longer answerable. Say so;
                // do not invent a destination for an authorization code.
                store.update({ error: context.localization.consentExpired, status: "error" });

                return;
            }

            /*
             * `redirectURI` is the relying party's absolute callback URL
             * carrying the authorization code, and better-auth returns it only
             * after matching it against that client's registered redirect URIs
             * — so it is server-vetted, not user input. It still cannot go
             * through the app router: SvelteKit's `goto` rejects an off-origin
             * URL and vue-router resolves it as an in-app path, either way the
             * code never reaches the client. Hence the split, written out here
             * rather than shared as a helper: an unguarded `location.assign`
             * that a caller could reach with a `redirectTo` query parameter is
             * an open redirect, and this is the one call site whose input is
             * vetted by the authorization server.
             *
             * That vetting is about the HOST, not the SCHEME, and it happens on
             * the other side of the network — so the browser hand-off is still
             * gated on {@link isHttpUrl}. `location.assign("javascript:…")`
             * executes in *this* app's origin, which is the auth app: a single
             * malformed or hostile `redirectURI` would be script execution on
             * the session it was issued for, with no defence in depth behind it.
             * Nothing that is neither a same-origin path nor an http(s) URL is a
             * destination this screen can honour, so it fails visibly instead.
             */
            if (isSafeRedirect(redirect)) {
                store.update({ status: "success" });
                context.nav.replace(redirect);
            } else if (isHttpUrl(redirect)) {
                store.update({ status: "success" });
                globalThis.location.assign(redirect);
            } else {
                store.update({ error: context.localization.genericError, status: "error" });
            }
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.genericError), status: "error" });
        }
    };

    if (options.autoLoad !== false) {
        void load();
    }

    return {
        actions: { accept: () => decide(true), deny: () => decide(false), load },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

interface AuthorizedAppsActions {
    refetch: () => Promise<void>;
    /** Withdraw a previously granted consent. */
    revoke: (consentId: string) => Promise<void>;
}

type AuthorizedAppsController = Controller<ResourceState<OAuthConsent>, AuthorizedAppsActions>;

/**
 * Applications the user has authorized, with revoke.
 *
 * The counterpart to the consent screen: granting access from a prompt you were
 * redirected into is only reasonable if taking it back is somewhere you can find
 * later.
 */
const createAuthorizedAppsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): AuthorizedAppsController => {
    const resource = createResourceController<OAuthConsent>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.oauth2.getConsents()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            refetch: resource.refetch,
            revoke: (consentId: string) => resource.mutate(async () => assertOk(await context.authClient.oauth2.deleteConsent({ id: consentId }))),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

/** OAuth scope strings are space-separated. Hoisted so it compiles once. */
const SCOPE_SEPARATOR = /\s+/u;

/** Human-readable scope labels; anything unknown falls back to the raw scope. */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
    email: "Your email address",
    offline_access: "Access while you're away",
    openid: "Your identity",
    profile: "Your name and picture",
};

/**
 * Split a space-separated scope string into labels a person can act on.
 *
 * An unknown scope is shown verbatim rather than hidden: consenting to a list
 * that omits what it couldn't describe is consenting to something you weren't
 * shown.
 */
const scopeLabels = (scope?: string): ReadonlyArray<string> => {
    const parts = (scope ?? "").split(SCOPE_SEPARATOR).filter((part) => part !== "");

    return parts.map((part) => SCOPE_LABELS[part] ?? part);
};

export type { AuthorizedAppsActions, AuthorizedAppsController, ConsentActions, ConsentController, ConsentOptions, ConsentState };
export { createAuthorizedAppsController, createConsentController, SCOPE_LABELS, scopeLabels };
