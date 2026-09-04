import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "../components/error-boundary";
import { ThemeProvider, useTheme } from "../components/theme-provider";
import { TooltipProvider } from "../components/ui/tooltip";
import useDebounced from "../hooks/use-debounced";
import { createStudioI18n, useT } from "../i18n/i18n-context";
import { StudioI18nProvider } from "../i18n/i18n-provider";
import { resolveOrigin } from "../lib/internal";
import { withOperationRecording } from "../lib/recording-client";
import STUDIO_ROOT_CLASS from "../lib/theme-constants";
import { loadToken, saveToken } from "../lib/token-storage";
import { cn } from "../lib/utils";
import { createAdminWsTokenProvider } from "../lib/ws-token-provider";
import type { StudioChrome, StudioProps } from "./studio";
import { Studio } from "./studio";
import StudioLogin from "./studio-login";

interface StudioAppProps {
    /**
     * Admin bearer token to send with every admin request. When omitted the app
     * renders a small prompt so an operator can paste it at runtime — handy in
     * dev where you don't want to bake the token into a bundle.
     */
    readonly adminToken?: string;

    /**
     * URL path prefix the studio is mounted under (router `basepath`). Defaults
     * to `/`. The `@lunora/vite` dev route sets `/__lunora`. Forwarded to the
     * composed {@link Studio}.
     */
    readonly basePath?: string;

    /**
     * Base URL of the Lunora worker the studio talks to. Defaults to the
     * current origin, which is correct when the studio is served from the
     * same worker (the `@lunora/vite` dev route) or proxied to it.
     */
    readonly baseUrl?: string;

    /**
     * Inject a pre-built client instead of constructing one from `baseUrl` +
     * the admin token. Used by the dev mock harness (and embeddings that own
     * the client) so the chrome renders against a supplied client; when set,
     * `baseUrl`/`adminToken` are ignored and this client is never closed here.
     */
    readonly client?: LunoraClient;

    /** UI language for the studio's own strings. Defaults to `en`. */
    readonly locale?: string;

    /**
     * Whether the project's Lunora agent skills ("rules") are installed. When
     * explicitly `false`, the studio shows a one-line banner pointing at
     * `lunora rules install`. The loopback dev hosts inject this; a static deploy
     * leaves it unset (no banner).
     */
    readonly rulesInstalled?: boolean;

    /** Forwarded to the composed {@link Studio} (functions, initialShardKey, scheduled overrides). */
    readonly studio?: Omit<StudioProps, "children" | "chrome" | "i18n" | "locale">;
}

interface StudioAppBodyProps {
    readonly basePath?: string;
    readonly chrome: StudioChrome;
    readonly studio?: StudioAppProps["studio"];
}

/**
 * The composed studio plus its error boundary. Kept separate from {@link
 * StudioApp} because its `useT` (for the error-boundary label) must read the
 * `StudioI18nProvider` the app renders above it. The composed `<Studio>`
 * inherits that same provider, so it isn't handed an instance here.
 */
const StudioAppBody = ({ basePath, chrome, studio }: StudioAppBodyProps): ReactElement => {
    const t = useT();

    return (
        <ErrorBoundary fallbackTitle={t("Studio failed")} label={t("Studio")} retryLabel={t("Try again")}>
            {/* eslint-disable-next-line react/jsx-props-no-spreading -- forwarding a closed, typed prop set: the hand-written list this replaces dropped `scheduledCron`, so a host that supplied a cron loader silently got the default fetch. `basePath` follows the spread because the app-level prop is the one that wins. */}
            <Studio {...studio} basePath={basePath} chrome={chrome} />
        </ErrorBoundary>
    );
};

interface StudioShellProps {
    readonly basePath?: string;
    readonly clearToken: () => void;
    readonly client: LunoraClient;
    readonly i18n: ReturnType<typeof createStudioI18n>;
    readonly onTokenChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly rulesInstalled?: boolean;
    readonly studio?: StudioAppProps["studio"];
    readonly token: string;
}

/**
 * The studio's scoped root. Reads the resolved theme from {@link ThemeProvider}
 * and applies the `.dark` class to its OWN container (not `document.documentElement`),
 * so the studio can be embedded inside a host app without recoloring the host.
 * Builds the app-owned {@link StudioChrome} (header theme toggle, footer
 * admin-token popover, rules banner) handed to the composed `<Studio>`.
 */
const StudioShell = ({ basePath, clearToken, client, i18n, onTokenChange, rulesInstalled, studio, token }: StudioShellProps): ReactElement => {
    // The resolved light/dark is applied to this scoped root (not `<html>`).
    // The theme control itself (<ThemeToggle/>) reads the preference from the
    // provider directly, so chrome no longer carries theme state.
    const { resolvedTheme } = useTheme();

    const chrome = { clearToken, onTokenChange, rulesInstalled, token };

    return (
        <div
            className={cn(STUDIO_ROOT_CLASS, resolvedTheme === "dark" && "dark", "flex h-dvh flex-col overflow-hidden bg-sidebar text-sm text-foreground")}
            data-testid="lunora-studio-app"
        >
            <LunoraProvider client={client}>
                <StudioI18nProvider i18n={i18n}>
                    <TooltipProvider>
                        <StudioAppBody basePath={basePath} chrome={chrome} studio={studio} />
                    </TooltipProvider>
                </StudioI18nProvider>
            </LunoraProvider>
        </div>
    );
};

/**
 * A fully self-contained studio page: it constructs a {@link LunoraClient}
 * pointed at the worker, wires it through a `<LunoraProvider>`, manages the
 * admin token + theme, and renders the composed {@link Studio} — handing it the
 * top-bar/sidebar {@link StudioChrome} (theme toggle, admin-token popover, rules
 * banner) so those affordances render inside the sidebar shell.
 *
 * Mount this directly (the standalone app and the `@lunora/vite` dev route both
 * do) when you want the batteries-included page rather than composing panels
 * yourself. For embedding into an existing admin UI, use the individual panels
 * or `<Studio>` under your own provider instead.
 */
const StudioApp = ({ adminToken, basePath, baseUrl, client: injectedClient, rulesInstalled, studio, locale }: StudioAppProps = {}): ReactElement => {
    // Seed from the prop, else a token persisted in a prior session (so a reload
    // doesn't force a re-paste). The prop wins when explicitly provided.
    const [token, setToken] = useState<string>(() => adminToken ?? loadToken());

    // Mirror the token into sessionStorage so it survives reloads.
    useEffect(() => {
        saveToken(token);
    }, [token]);

    // Debounce the value that feeds the client so typing/pasting a multi-character
    // token doesn't rebuild the LunoraClient (and tear down its WebSocket +
    // reconnect timers) once per keystroke. The raw `token` still drives the
    // controlled input; the client rebuilds at most once per typing pause.
    //
    // The reset key snaps the mirror on the empty↔non-empty transition, which is
    // exactly where the gate below flips. The gate reads the RAW token, so without
    // the snap the shell mounts every panel against a credential-less client for the
    // full delay after a login — a row of 401s and failed WS subscribes — and drops
    // the credential a delay late on logout. Editing a token that is already set
    // stays debounced, which is what the delay is for.
    const debouncedToken = useDebounced(token, 300, token === "");

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: this is the LunoraClient — a fresh one per render opens a new WebSocket
    const client = useMemo(() => {
        // A supplied client (dev mock / embedding) wins — render the chrome
        // against it and don't build or own a real one. It is still wrapped for
        // recording: an embedded studio's admin calls belong on the tape too.
        if (injectedClient !== undefined) {
            return withOperationRecording(injectedClient);
        }

        // The admin token authorizes the WS upgrade too, but never rides the URL
        // itself: the client's `wsToken` is a provider that mints a short-lived
        // HMAC-signed sub-token from the worker (master token in the
        // Authorization HEADER) fresh on every (re)connect, so only the ephemeral
        // token appears in `?token=`. Against a worker without the mint endpoint
        // (404s) the provider falls back to the master token. A 4001
        // token-expired drop invalidates the provider's cache so the reconnect
        // re-mints even when the cached token still looks fresh.
        const origin = resolveOrigin(baseUrl);
        const provider = debouncedToken === "" ? undefined : createAdminWsTokenProvider({ adminToken: debouncedToken, baseUrl: origin });
        const created = new LunoraClient({ url: origin, ...(provider === undefined ? {} : { wsToken: provider.getToken }) });

        if (provider !== undefined) {
            created.setAuthToken(debouncedToken);
            created.onTokenExpired(provider.invalidate);
        }

        // The single seam every admin RPC crosses. Wrapping here is what makes the
        // operation console's coverage true by construction rather than by every
        // call site remembering to opt in — see `lib/recording-client.ts`.
        return withOperationRecording(created);
    }, [baseUrl, debouncedToken, injectedClient]);

    // Close the previous client when `token`/`baseUrl` changes (and on unmount)
    // so we don't leak sockets, in-flight streams, or reconnect timers each
    // time the admin pastes a new token. An injected client is owned by the
    // caller, so it's left alone.
    useEffect(
        () => (): void => {
            // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- resource-cleanup effect: closes the owned client's sockets/streams/timers on unmount or when client/baseUrl changes; an injected client is caller-owned so it's left alone
            if (injectedClient === undefined) {
                client.close();
            }
        },
        [client, injectedClient],
    );

    const onTokenChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setToken(event.target.value);
    };

    const clearToken = (): void => {
        setToken("");
    };

    // A studio-scoped Lingui instance (never the global singleton). This app
    // is the sole provider owner — the composed `<Studio>` resolves its strings
    // from it, so `<Studio>` isn't handed an instance.
    const i18n = createStudioI18n(locale);

    // Theme lives in a provider so the resolved class can be applied to the
    // studio's own scoped root (see StudioShell) rather than `<html>`.
    //
    // Token gate: with no admin token (none injected by the dev host, none
    // persisted), render the login page and nothing else — every studio page
    // sits behind it. A token (dev `.dev.vars` auto-inject, a prior paste, or
    // submitting the login) drops straight into the app; clearing it returns here.
    //
    // An injected `client` skips the gate entirely: the caller owns that client's
    // credentials (that is the documented contract — `baseUrl`/`adminToken` are
    // ignored when it is set), so there is no token here to gate on and the login
    // form could not affect it anyway.
    return (
        <ThemeProvider>
            {token === "" && injectedClient === undefined ? (
                <StudioLogin i18n={i18n} onSubmit={setToken} />
            ) : (
                <StudioShell
                    basePath={basePath}
                    clearToken={clearToken}
                    client={client}
                    i18n={i18n}
                    onTokenChange={onTokenChange}
                    rulesInstalled={rulesInstalled}
                    studio={studio}
                    token={token}
                />
            )}
        </ThemeProvider>
    );
};

export { StudioApp };
export type { StudioAppProps };
