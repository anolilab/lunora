import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConnectionBadge from "../components/connection-badge";
import { ErrorBoundary } from "../components/error-boundary";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { TooltipProvider } from "../components/ui/tooltip";
import useDebounced from "../hooks/use-debounced";
import { createStudioI18n, useT } from "../i18n/i18n-context";
import { StudioI18nProvider } from "../i18n/i18n-provider";
import STUDIO_ROOT_CLASS from "../lib/theme-constants";
import { loadToken, saveToken } from "../lib/token-storage";
import { cn } from "../lib/utils";
import { openCommandPalette } from "./command-palette";
import type { StudioProps } from "./studio";
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
    readonly studio?: Omit<StudioProps, "children" | "i18n" | "locale">;
}

/**
 * The Lunora raven mark (see `.github/assets/lunora.svg`): a bowed raven head
 * carved out of a full moon. Filled with `currentColor` so it inherits the
 * top-bar foreground in both themes (the source asset hard-codes near-black,
 * which would disappear in dark mode).
 */
const BrandMark = (): ReactElement => (
    <svg aria-hidden="true" className="h-5 w-6 text-foreground" fill="currentColor" viewBox="0 0 543 446">
        <path
            d="M 259.500 10.552 C 220.080 15.859, 182.424 32.566, 152.500 58.025 C 110.179 94.031, 85.380 137.183, 77.518 188.500 C 75.410 202.255, 74.569 225.677, 75.796 236.466 C 76.757 244.917, 76.683 245.692, 74.518 249.966 C 63.118 272.466, 53.141 303.876, 51.382 322.799 L 50.718 329.943 71.960 320.471 C 83.643 315.262, 93.326 311, 93.478 311 C 93.630 311, 96.547 316.063, 99.959 322.250 C 103.371 328.438, 107.249 334.850, 108.577 336.500 L 110.990 339.500 110.981 336 C 110.977 334.075, 111.499 324.991, 112.143 315.813 L 113.312 299.127 121.406 293.336 C 132.495 285.403, 149.593 271.554, 161 261.268 C 171.556 251.748, 189.116 235, 188.540 235 C 188.337 235, 183.069 238.648, 176.835 243.106 C 142.318 267.789, 68.537 314, 63.646 314 C 61.843 314, 72.791 281.179, 80.905 262.259 C 92.233 235.845, 107.473 212.389, 132.106 183.453 L 138.451 176 148.268 176 C 176.192 176, 197.512 187.154, 212.868 209.797 C 216.470 215.108, 217.035 216.595, 216.477 219.297 C 211.386 243.968, 202.359 274.496, 193.797 296 C 183.898 320.861, 167.147 352.101, 152.395 373.215 L 147.004 380.930 152.891 385.830 C 161.400 392.911, 165.563 396, 166.594 395.998 C 167.092 395.998, 168.772 391.641, 170.327 386.317 C 176.279 365.934, 188.422 338.749, 200.942 317.778 C 223.060 280.731, 256.432 244.369, 294.500 215.836 C 309.956 204.252, 313.937 201.603, 314.719 202.385 C 315.116 202.783, 315.449 213.096, 315.460 225.304 C 315.474 241.855, 315.021 250.405, 313.680 258.924 C 307.009 301.272, 291.175 336.677, 263.112 372 C 255.259 381.883, 227.182 410.673, 218.516 417.727 L 213.532 421.783 223.439 424.880 C 281.705 443.093, 349.165 436.018, 398.616 406.508 C 446.728 377.797, 483.322 331.466, 497.366 281.481 C 503.381 260.075, 504.480 250.741, 504.491 221 C 504.501 191.997, 503.598 184.047, 497.987 163.732 C 484.768 115.871, 452.505 72.708, 407.718 42.964 C 381.051 25.254, 352.818 14.828, 319.695 10.460 C 305.932 8.645, 273.298 8.695, 259.500 10.552"
            fillRule="evenodd"
        />
    </svg>
);

interface StudioAppBodyProps {
    readonly basePath?: string;
    readonly clearToken: () => void;
    readonly onToggleTheme: () => void;
    readonly onTokenChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly rulesInstalled?: boolean;
    readonly studio?: StudioAppProps["studio"];
    readonly theme: "dark" | "light";
    readonly token: string;
}

/** `localStorage` key remembering that the developer dismissed the rules banner. */
const RULES_BANNER_DISMISSED_KEY = "lunora.studio.rulesBannerDismissed";

/** Read the persisted "rules banner dismissed" flag, tolerating storage being unavailable. */
const readBannerDismissed = (): boolean => {
    try {
        return globalThis.localStorage.getItem(RULES_BANNER_DISMISSED_KEY) === "1";
    } catch {
        return false;
    }
};

/** Persist the "rules banner dismissed" flag, swallowing storage failures (private mode / disabled). */
const writeBannerDismissed = (): void => {
    try {
        globalThis.localStorage.setItem(RULES_BANNER_DISMISSED_KEY, "1");
    } catch {
        // ignore — dismissal just won't survive a reload
    }
};

/**
 * The header + composed studio. Kept separate from {@link StudioApp}
 * because its `useT` (for the top-bar strings and the error-boundary label) must
 * read the `StudioI18nProvider` the app renders above it. The composed
 * `&lt;Studio>` inherits that same provider, so it isn't handed an instance here.
 */
const StudioAppBody = ({ basePath, clearToken, studio, onToggleTheme, onTokenChange, rulesInstalled, theme, token }: StudioAppBodyProps): ReactElement => {
    const t = useT();

    // The "rules not installed" banner is a one-time nudge — let the developer
    // dismiss it, persisted so it stays gone across reloads. Reads lazily and
    // tolerates storage being unavailable (private mode / embeddings).
    const [rulesBannerDismissed, setRulesBannerDismissed] = useState<boolean>(() => readBannerDismissed());

    const dismissRulesBanner = useCallback((): void => {
        setRulesBannerDismissed(true);
        writeBannerDismissed();
    }, []);

    return (
        <>
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3" data-testid="dash-app-header">
                <span className="flex items-center gap-2">
                    <BrandMark />
                    <strong className="text-sm font-semibold tracking-tight">lunora</strong>
                    <span aria-hidden="true" className="size-1 rounded-full bg-primary" />
                    <Badge className="ms-1 px-1.5 text-[10px] tracking-wider uppercase" variant="secondary">
                        {t("Studio")}
                    </Badge>
                </span>

                {/* Center command/search affordance — opens the ⌘K palette
                    rendered inside the studio shell (below the router). */}
                <button
                    className="mx-auto hidden h-7 w-72 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted md:flex"
                    data-testid="dash-app-search"
                    onClick={openCommandPalette}
                    type="button"
                >
                    <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                        <circle cx="11" cy="11" r="7" />
                        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
                    </svg>
                    {t("Search…")}
                    <kbd className="ms-auto rounded border border-border bg-background px-1 font-sans text-[10px] text-muted-foreground">⌘K</kbd>
                </button>

                <div className="ms-auto flex items-center gap-2">
                    <ConnectionBadge />

                    {/* Connection/admin-token disclosure — Studio-style "Connect" button
                        that opens a popover with the token field; kept mounted so the
                        field stays scriptable/accessible even while collapsed. */}
                    <Popover>
                        <PopoverTrigger
                            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                            data-testid="dash-app-connect"
                        >
                            <svg
                                aria-hidden="true"
                                className="size-3.5"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.7}
                                viewBox="0 0 24 24"
                            >
                                <path d="M9 7 5.5 10.5a4 4 0 0 0 0 5.7l.5.5a4 4 0 0 0 5.7 0L15 13M15 17l3.5-3.5a4 4 0 0 0 0-5.7l-.5-.5a4 4 0 0 0-5.7 0L9 11" />
                            </svg>
                            {token === "" ? t("Connect") : t("Connected")}
                            {token !== "" && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />}
                        </PopoverTrigger>
                        <PopoverContent keepMounted>
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-medium text-foreground" htmlFor="dash-app-token">
                                    {t("admin token")}
                                </label>
                                <Input
                                    className="h-8"
                                    data-testid="dash-app-token"
                                    id="dash-app-token"
                                    onChange={onTokenChange}
                                    placeholder="LUNORA_ADMIN_TOKEN"
                                    type="password"
                                    value={token}
                                />
                                {token !== "" && (
                                    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground" data-testid="dash-app-token-warning" role="note">
                                        <span aria-hidden="true" className="text-amber-500">
                                            ⚠
                                        </span>
                                        {t("Token rides the WebSocket URL — it can surface in browser DevTools and server logs. Use a dev-only token.")}
                                    </p>
                                )}
                                {token !== "" && (
                                    <Button
                                        className="self-start"
                                        data-testid="dash-app-clear-token"
                                        onClick={clearToken}
                                        size="sm"
                                        type="button"
                                        variant="outline"
                                    >
                                        {t("Clear")}
                                    </Button>
                                )}
                            </div>
                        </PopoverContent>
                    </Popover>

                    <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

                    {/* Theme toggle — keeps dark mode reachable; light is the default. */}
                    <button
                        aria-label={theme === "dark" ? t("Switch to light theme") : t("Switch to dark theme")}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
                        data-testid="dash-app-theme"
                        onClick={onToggleTheme}
                        title={theme === "dark" ? t("Switch to light theme") : t("Switch to dark theme")}
                        type="button"
                    >
                        {theme === "dark" ? (
                            <svg
                                aria-hidden="true"
                                className="size-4"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.7}
                                viewBox="0 0 24 24"
                            >
                                <circle cx="12" cy="12" r="4" />
                                <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                            </svg>
                        ) : (
                            <svg
                                aria-hidden="true"
                                className="size-4"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.7}
                                viewBox="0 0 24 24"
                            >
                                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                            </svg>
                        )}
                    </button>

                    {/* Account placeholder — rounds out the top-bar cluster. */}
                    <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-accent text-[11px] font-medium text-foreground">
                        C
                    </span>
                </div>
            </header>

            {rulesInstalled === false && !rulesBannerDismissed && (
                <div
                    className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-foreground"
                    data-testid="dash-app-rules-banner"
                    role="note"
                >
                    <span aria-hidden="true" className="text-amber-500">
                        ⚠
                    </span>
                    <span>
                        {t("Lunora AI rules aren't installed.")}{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">lunora rules install</code>{" "}
                        {t("lets your coding agent use Lunora correctly.")}
                    </span>
                    <button
                        aria-label={t("Dismiss")}
                        className="ms-auto flex size-5 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
                        data-testid="dash-app-rules-banner-dismiss"
                        onClick={dismissRulesBanner}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth={1.8}
                            viewBox="0 0 24 24"
                        >
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            )}

            <ErrorBoundary fallbackTitle={t("Studio failed")} label={t("Studio")} retryLabel={t("Try again")}>
                <Studio
                    basePath={basePath}
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
 * A fully self-contained studio page: it constructs a {@link LunoraClient}
 * pointed at the worker, wires it through a `&lt;LunoraProvider>`, manages the
 * admin token, and renders the composed {@link Studio}.
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

    // Light is the default (matches the Studio look); the top-bar toggle flips
    // to dark and the `.dark` class on the root scopes every token.
    const [theme, setTheme] = useState<"dark" | "light">("light");

    const onToggleTheme = useCallback((): void => {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
    }, []);

    // A studio-scoped Lingui instance (never the global singleton). This app
    // is the sole provider owner — the header and the composed `<Studio>` both
    // resolve their strings from it, so `<Studio>` isn't handed an instance.
    const i18n = useMemo(() => createStudioI18n(locale), [locale]);

    return (
        <div
            className={cn(STUDIO_ROOT_CLASS, theme === "dark" && "dark", "flex h-dvh flex-col overflow-hidden bg-background text-sm text-foreground")}
            data-testid="lunora-studio-app"
        >
            <LunoraProvider client={client}>
                <StudioI18nProvider i18n={i18n}>
                    <TooltipProvider>
                        <StudioAppBody
                            basePath={basePath}
                            clearToken={clearToken}
                            onToggleTheme={onToggleTheme}
                            onTokenChange={onTokenChange}
                            rulesInstalled={rulesInstalled}
                            studio={studio}
                            theme={theme}
                            token={token}
                        />
                    </TooltipProvider>
                </StudioI18nProvider>
            </LunoraProvider>
        </div>
    );
};

export type { StudioAppProps };
