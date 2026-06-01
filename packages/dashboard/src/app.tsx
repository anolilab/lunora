import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConnectionBadge from "./connection-badge.js";
import type { DashboardProps } from "./dashboard.js";
import { Dashboard } from "./dashboard.js";
import { ErrorBoundary } from "./error-boundary.js";
import DashboardStyles from "./theme.js";
import DASHBOARD_ROOT_CLASS from "./theme-constants.js";
import { loadToken, saveToken } from "./token-storage.js";

interface DashboardAppProps {
    /**
     * Admin bearer token to send with every admin request. When omitted the app
     * renders a small prompt so an operator can paste it at runtime — handy in
     * dev where you don't want to bake the token into a bundle.
     */
    readonly adminToken?: string;

    /**
     * Base URL of the Cirrus worker the dashboard talks to. Defaults to the
     * current origin, which is correct when the dashboard is served from the
     * same worker (the `@cirrus/vite` dev route) or proxied to it.
     */
    readonly baseUrl?: string;
    /** Forwarded to the composed {@link Dashboard} (functions, initialShardKey, scheduled overrides). */
    readonly dashboard?: Omit<DashboardProps, "children">;
}

const TOKEN_WARNING_STYLE = {
    color: "var(--c-danger)",
    fontSize: "12px",
    width: "100%",
} as const;

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
 * A fully self-contained dashboard page: it constructs a {@link CirrusClient}
 * pointed at the worker, wires it through a `&lt;CirrusProvider>`, manages the
 * admin token, and renders the composed {@link Dashboard}.
 *
 * Mount this directly (the standalone app and the `@cirrus/vite` dev route both
 * do) when you want the batteries-included page rather than composing panels
 * yourself. For embedding into an existing admin UI, use the individual panels
 * or `&lt;Dashboard>` under your own provider instead.
 */
export const DashboardApp = ({ adminToken, baseUrl, dashboard }: DashboardAppProps = {}): ReactElement => {
    // Seed from the prop, else a token persisted in a prior session (so a reload
    // doesn't force a re-paste). The prop wins when explicitly provided.
    const [token, setToken] = useState<string>(() => adminToken ?? loadToken());

    // Mirror the token into sessionStorage so it survives reloads.
    useEffect(() => {
        saveToken(token);
    }, [token]);

    const client = useMemo(() => {
        // The token doubles as the WS credential (`wsToken`) so live admin
        // subscriptions clear the upgrade's admin gate, mirroring the bearer the
        // HTTP admin RPCs already send.
        const created = new CirrusClient({ url: resolveBaseUrl(baseUrl), ...token === "" ? {} : { wsToken: token } });

        if (token !== "") {
            created.setAuthToken(token);
        }

        return created;
    }, [baseUrl, token]);

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

    return (
        <div className={DASHBOARD_ROOT_CLASS} data-testid="cirrus-dashboard-app">
            <DashboardStyles />
            <CirrusProvider client={client}>
                <header data-testid="dash-app-header">
                    <strong>Cirrus Dashboard</strong>
                    <div data-testid="dash-app-token-warning" role="note" style={TOKEN_WARNING_STYLE}>
                        This token is sent in the WebSocket URL and may appear in browser DevTools and server logs. Use a development-only token.
                    </div>
                    <label htmlFor="dash-app-token">
                        {" admin token "}
                        <input
                            data-testid="dash-app-token"
                            id="dash-app-token"
                            onChange={onTokenChange}
                            placeholder="CIRRUS_ADMIN_TOKEN"
                            type="password"
                            value={token}
                        />
                    </label>
                    {token !== "" && (
                        <button data-testid="dash-app-clear-token" onClick={clearToken} type="button">
                            Clear
                        </button>
                    )}
                    <ConnectionBadge />
                </header>

                <ErrorBoundary label="Dashboard">
                    <Dashboard
                        dataEditable={dashboard?.dataEditable}
                        functions={dashboard?.functions}
                        initialShardKey={dashboard?.initialShardKey}
                        scheduledCancel={dashboard?.scheduledCancel}
                        scheduledLoad={dashboard?.scheduledLoad}
                    />
                </ErrorBoundary>
            </CirrusProvider>
        </div>
    );
};

export type { DashboardAppProps };
