import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { type ReactElement, useMemo, useState } from "react";

import { Dashboard, type DashboardProps } from "./dashboard.js";

export interface DashboardAppProps {
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
 * pointed at the worker, wires it through a `<CirrusProvider>`, manages the
 * admin token, and renders the composed {@link Dashboard}.
 *
 * Mount this directly (the standalone app and the `@cirrus/vite` dev route both
 * do) when you want the batteries-included page rather than composing panels
 * yourself. For embedding into an existing admin UI, use the individual panels
 * or `<Dashboard>` under your own provider instead.
 */
export function DashboardApp({ adminToken, baseUrl, dashboard }: DashboardAppProps = {}): ReactElement {
    const [token, setToken] = useState<string>(adminToken ?? "");

    const client = useMemo(() => {
        const created = new CirrusClient({ url: resolveBaseUrl(baseUrl) });

        if (token !== "") {
            created.setAuthToken(token);
        }

        return created;
    }, [baseUrl, token]);

    return (
        <div data-testid="cirrus-dashboard-app">
            <header data-testid="dash-app-header">
                <strong>Cirrus Dashboard</strong>
                <label>
                    {" admin token "}
                    <input
                        aria-label="Admin token"
                        data-testid="dash-app-token"
                        onChange={(event) => {
                            setToken(event.target.value);
                        }}
                        placeholder="CIRRUS_ADMIN_TOKEN"
                        type="password"
                        value={token}
                    />
                </label>
            </header>

            <CirrusProvider client={client}>
                <Dashboard {...dashboard} />
            </CirrusProvider>
        </div>
    );
}
