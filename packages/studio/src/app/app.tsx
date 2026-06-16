import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ErrorBoundary } from "../components/error-boundary";
import { TooltipProvider } from "../components/ui/tooltip";
import useDebounced from "../hooks/use-debounced";
import { createStudioI18n, useT } from "../i18n/i18n-context";
import { StudioI18nProvider } from "../i18n/i18n-provider";
import STUDIO_ROOT_CLASS from "../lib/theme-constants";
import { loadToken, saveToken } from "../lib/token-storage";
import { cn } from "../lib/utils";
import type { StudioChrome, StudioProps } from "./studio";
import { Studio } from "./studio";

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

const resolveBaseUrl = (explicit: string | undefined): string => {
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }

    const loc = (globalThis as { location?: { origin?: string } }).location;

    if (loc?.origin !== undefined && loc.origin !== "") {
        return loc.origin;
    }

    return "http://localhost:5173";
};

/**
 * A fully self-contained studio page: it constructs a {@link LunoraClient}
 * pointed at the worker, wires it through a `&lt;LunoraProvider>`, manages the
 * admin token + theme, and renders the composed {@link Studio} — handing it the
 * top-bar/sidebar {@link StudioChrome} (theme toggle, admin-token popover, rules
 * banner) so those affordances render inside the sidebar shell.
 *
 * Mount this directly (the standalone app and the `@lunora/vite` dev route both
 * do) when you want the batteries-included page rather than composing panels
 * yourself. For embedding into an existing admin UI, use the individual panels
 * or `&lt;Studio>` under your own provider instead.
 */
export const StudioApp = ({ adminToken, basePath, baseUrl, client: injectedClient, rulesInstalled, studio, locale }: StudioAppProps = {}): ReactElement => {
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
    const debouncedToken = useDebounced(token, 300);

    const client = useMemo(() => {
        // A supplied client (dev mock / embedding) wins — render the chrome
        // against it and don't build or own a real one.
        if (injectedClient !== undefined) {
            return injectedClient;
        }

        // The token doubles as the WS credential (`wsToken`) so live admin
        // subscriptions clear the upgrade's admin gate, mirroring the bearer the
        // HTTP admin RPCs already send.
        const created = new LunoraClient({ url: resolveBaseUrl(baseUrl), ...(debouncedToken === "" ? {} : { wsToken: debouncedToken }) });

        if (debouncedToken !== "") {
            created.setAuthToken(debouncedToken);
        }

        return created;
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

    const onTokenChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setToken(event.target.value);
    }, []);

    const clearToken = useCallback((): void => {
        setToken("");
    }, []);

    // Light is the default (matches the reference look); the toggle flips to dark
    // and the `.dark` class on the root scopes every token.
    const [theme, setTheme] = useState<"dark" | "light">("light");

    const onToggleTheme = useCallback((): void => {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
    }, []);

    // A studio-scoped Lingui instance (never the global singleton). This app
    // is the sole provider owner — the composed `<Studio>` resolves its strings
    // from it, so `<Studio>` isn't handed an instance.
    const i18n = useMemo(() => createStudioI18n(locale), [locale]);

    // The app-owned chrome rendered inside the sidebar shell (header theme toggle,
    // footer admin-token popover, rules banner).
    const chrome = useMemo<StudioChrome>(
        () => {return { clearToken, onToggleTheme, onTokenChange, rulesInstalled, theme, token }},
        [clearToken, onToggleTheme, onTokenChange, rulesInstalled, theme, token],
    );

    return (
        <div
            className={cn(STUDIO_ROOT_CLASS, theme === "dark" && "dark", "flex h-dvh flex-col overflow-hidden bg-sidebar text-sm text-foreground")}
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

interface StudioAppBodyProps {
    readonly basePath?: string;
    readonly chrome: StudioChrome;
    readonly studio?: StudioAppProps["studio"];
}

/**
 * The composed studio plus its error boundary. Kept separate from {@link
 * StudioApp} because its `useT` (for the error-boundary label) must read the
 * `StudioI18nProvider` the app renders above it. The composed `&lt;Studio>`
 * inherits that same provider, so it isn't handed an instance here.
 */
const StudioAppBody = ({ basePath, chrome, studio }: StudioAppBodyProps): ReactElement => {
    const t = useT();

    return (
        <ErrorBoundary fallbackTitle={t("Studio failed")} label={t("Studio")} retryLabel={t("Try again")}>
            <Studio
                basePath={basePath}
                chrome={chrome}
                dataEditable={studio?.dataEditable}
                functions={studio?.functions}
                initialShardKey={studio?.initialShardKey}
                openApiSpec={studio?.openApiSpec}
                openRpcSpec={studio?.openRpcSpec}
                runAsIdentity={studio?.runAsIdentity}
                scheduledCancel={studio?.scheduledCancel}
                scheduledLoad={studio?.scheduledLoad}
                schemaEditable={studio?.schemaEditable}
            />
        </ErrorBoundary>
    );
};

export type { StudioAppProps };
