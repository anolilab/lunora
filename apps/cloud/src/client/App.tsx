import type { ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client";
import { Login } from "./Login";
import { OrganizationDashboard } from "./OrganizationDashboard";
import { OrganizationList } from "./OrganizationList";
import type { OrgId } from "./types";

/**
 * Root of the hosted studio. Gates on the better-auth session: unauthenticated
 * visitors see {@link Login}; signed-in users get the organization picker and,
 * once an org is selected, its {@link OrganizationDashboard}.
 */
export const App = (): ReactElement => {
    const session = authClient.useSession();
    const [activeOrg, setActiveOrg] = useState<OrgId | null>(null);

    if (session.isPending) {
        return <p className="loading">Loading…</p>;
    }

    if (!session.data) {
        return <Login />;
    }

    return (
        <div className="app">
            <header className="topbar">
                <button
                    className="brand"
                    onClick={() => {
                        setActiveOrg(null);
                    }}
                    type="button"
                >
                    Lunora Cloud
                </button>
                <div className="topbar-right">
                    <span className="muted">{session.data.user.email}</span>
                    <button
                        className="link"
                        onClick={() => {
                            void authClient.signOut();
                            setActiveOrg(null);
                        }}
                        type="button"
                    >
                        Sign out
                    </button>
                </div>
            </header>
            <main className="content">
                {activeOrg ? (
                    <OrganizationDashboard
                        onBack={() => {
                            setActiveOrg(null);
                        }}
                        organizationId={activeOrg}
                    />
                ) : (
                    <OrganizationList onSelect={setActiveOrg} />
                )}
            </main>
        </div>
    );
};
