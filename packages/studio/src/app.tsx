import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import ConnectionBadge from "./connection-badge.js";
import type { StudioProps } from "./studio.js";
import { Studio } from "./studio.js";
import { ErrorBoundary } from "./error-boundary.js";
import { createStudioI18n, useT } from "./i18n-context.js";
import { StudioI18nProvider } from "./i18n-provider.js";
import STUDIO_ROOT_CLASS from "./theme-constants.js";
import { loadToken, saveToken } from "./token-storage.js";
import useDebounced from "./use-debounced.js";

interface StudioAppProps {
    /**
     * Admin bearer token to send with every admin request. When omitted the app
     * renders a small prompt so an operator can paste it at runtime — handy in
     * dev where you don't want to bake the token into a bundle.
     */
    readonly adminToken?: string;

    /**
     * URL path prefix the studio is mounted under (router `basepath`). Defaults
     * to `/`. The `@cirrus/vite` dev route sets `/__cirrus`. Forwarded to the
     * composed {@link Studio}.
     */
    readonly basePath?: string;

    /**
     * Base URL of the Cirrus worker the studio talks to. Defaults to the
     * current origin, which is correct when the studio is served from the
     * same worker (the `@cirrus/vite` dev route) or proxied to it.
     */
    readonly baseUrl?: string;
    /** Forwarded to the composed {@link Studio} (functions, initialShardKey, scheduled overrides). */
    readonly studio?: Omit<StudioProps, "children" | "i18n" | "locale">;

    /** UI language for the studio's own strings. Defaults to `en`. */
    readonly locale?: string;
}

/**
 * The Cirrus triple-streak mark (see `BRAND.md`): three thin strokes,
 * long → medium → short. Drawn with `currentColor` so it inherits the top-bar
 * foreground in both themes.
 */
const BrandMark = (): ReactElement => (
    <svg aria-hidden="true" className="h-4 w-6 text-foreground" fill="none" viewBox="0 0 120 80">
        <path d="M12 24 H108" stroke="currentColor" strokeLinecap="round" strokeWidth={8} />
        <path d="M12 40 H92" stroke="currentColor" strokeLinecap="round" strokeWidth={8} />
        <path d="M12 56 H72" stroke="currentColor" strokeLinecap="round" strokeWidth={8} />
    </svg>
);

interface StudioAppBodyProps {
    readonly basePath?: string;
    readonly clearToken: () => void;
    readonly studio?: StudioAppProps["studio"];
    readonly onTokenChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly token: string;
}

/**
 * The header + composed studio. Kept separate from {@link StudioApp}
 * because its `useT` (for the top-bar strings and the error-boundary label) must
 * read the `StudioI18nProvider` the app renders above it. The composed
 * `&lt;Studio>` inherits that same provider, so it isn't handed an instance here.
 */
const StudioAppBody = ({ basePath, clearToken, studio, onTokenChange, token }: StudioAppBodyProps): ReactElement => {
    const t = useT();

    return (
        <>
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4" data-testid="dash-app-header">
                <span className="flex items-center gap-2">
                    <BrandMark />
                    <strong className="text-sm font-semibold tracking-tight">cirrus</strong>
                    <span aria-hidden="true" className="size-1 rounded-full bg-primary" />
                    <Badge className="ms-1 px-1.5 text-[10px] tracking-wider uppercase" variant="secondary">
                        {t("Studio")}
                    </Badge>
                </span>
                <div className="ms-auto flex items-center gap-2">
                    {token !== "" && (
                        // Compact, contextual warning: only while a token is set, shown as a
                        // single amber glyph; the full caution is in the tooltip + for SRs.
                        <span
                            className="inline-flex items-center text-sm text-amber-500"
                            data-testid="dash-app-token-warning"
                            role="note"
                            title={t("Token rides the WebSocket URL — it can surface in browser DevTools and server logs. Use a dev-only token.")}
                        >
                            <span aria-hidden="true">⚠</span>
                            <span className="sr-only">
                                {t("Token rides the WebSocket URL — it can surface in browser DevTools and server logs. Use a dev-only token.")}
                            </span>
                        </span>
                    )}
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" htmlFor="dash-app-token">
                        {t("admin token")}
                        <Input
                            className="h-7 w-44"
                            data-testid="dash-app-token"
                            id="dash-app-token"
                            onChange={onTokenChange}
                            placeholder="CIRRUS_ADMIN_TOKEN"
                            type="password"
                            value={token}
                        />
                    </label>
                    {token !== "" && (
                        <Button data-testid="dash-app-clear-token" onClick={clearToken} size="sm" type="button" variant="ghost">
                            {t("Clear")}
                        </Button>
                    )}
                    <ConnectionBadge />
                </div>
            </header>

            <ErrorBoundary fallbackTitle={t("Studio failed")} label={t("Studio")} retryLabel={t("Try again")}>
                <Studio
                    basePath={basePath}
                    dataEditable={studio?.dataEditable}
                    functions={studio?.functions}
                    initialShardKey={studio?.initialShardKey}
                    scheduledCancel={studio?.scheduledCancel}
                    scheduledLoad={studio?.scheduledLoad}
                />
            </ErrorBoundary>
        </>
    );
};

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
 * A fully self-contained studio page: it constructs a {@link CirrusClient}
 * pointed at the worker, wires it through a `&lt;CirrusProvider>`, manages the
 * admin token, and renders the composed {@link Studio}.
 *
 * Mount this directly (the standalone app and the `@cirrus/vite` dev route both
 * do) when you want the batteries-included page rather than composing panels
 * yourself. For embedding into an existing admin UI, use the individual panels
 * or `&lt;Studio>` under your own provider instead.
 */
export const StudioApp = ({ adminToken, basePath, baseUrl, studio, locale }: StudioAppProps = {}): ReactElement => {
    // Seed from the prop, else a token persisted in a prior session (so a reload
    // doesn't force a re-paste). The prop wins when explicitly provided.
    const [token, setToken] = useState<string>(() => adminToken ?? loadToken());

    // Mirror the token into sessionStorage so it survives reloads.
    useEffect(() => {
        saveToken(token);
    }, [token]);

    // Debounce the value that feeds the client so typing/pasting a multi-character
    // token doesn't rebuild the CirrusClient (and tear down its WebSocket +
    // reconnect timers) once per keystroke. The raw `token` still drives the
    // controlled input; the client rebuilds at most once per typing pause.
    const debouncedToken = useDebounced(token, 300);

    const client = useMemo(() => {
        // The token doubles as the WS credential (`wsToken`) so live admin
        // subscriptions clear the upgrade's admin gate, mirroring the bearer the
        // HTTP admin RPCs already send.
        const created = new CirrusClient({ url: resolveBaseUrl(baseUrl), ...(debouncedToken === "" ? {} : { wsToken: debouncedToken }) });

        if (debouncedToken !== "") {
            created.setAuthToken(debouncedToken);
        }

        return created;
    }, [baseUrl, debouncedToken]);

    // Close the previous client when `token`/`baseUrl` changes (and on unmount)
    // so we don't leak sockets, in-flight streams, or reconnect timers each
    // time the admin pastes a new token.
    useEffect(
        () => (): void => {
            client.close();
        },
        [client],
    );

    const onTokenChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setToken(event.target.value);
    }, []);

    const clearToken = useCallback((): void => {
        setToken("");
    }, []);

    // A studio-scoped Lingui instance (never the global singleton). This app
    // is the sole provider owner — the header and the composed `<Studio>` both
    // resolve their strings from it, so `<Studio>` isn't handed an instance.
    const i18n = useMemo(() => createStudioI18n(locale), [locale]);

    return (
        <div className={`${STUDIO_ROOT_CLASS} dark flex min-h-screen flex-col bg-background text-sm text-foreground`} data-testid="cirrus-studio-app">
            <CirrusProvider client={client}>
                <StudioI18nProvider i18n={i18n}>
                    <TooltipProvider>
                        <StudioAppBody basePath={basePath} clearToken={clearToken} studio={studio} onTokenChange={onTokenChange} token={token} />
                    </TooltipProvider>
                </StudioI18nProvider>
            </CirrusProvider>
        </div>
    );
};

export type { StudioAppProps };
