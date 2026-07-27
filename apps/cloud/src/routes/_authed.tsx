import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { authClient } from "../client/auth-client";
import { requireSession } from "../ssr/loader";

const AuthedLayout = (): ReactElement => {
    const { session } = Route.useRouteContext();
    const navigate = useNavigate();

    return (
        <div className="app">
            <header className="topbar">
                <Link className="brand" to="/">
                    Lunora Cloud
                </Link>
                <div className="topbar-right">
                    <span className="muted">{session.user.email}</span>
                    <button
                        className="link"
                        onClick={() => {
                            void authClient.signOut().then(() => navigate({ to: "/login" }));
                        }}
                        type="button"
                    >
                        Sign out
                    </button>
                </div>
            </header>
            <main className="content">
                <Outlet />
            </main>
        </div>
    );
};

/**
 * Pathless layout for every signed-in screen — the former `App.tsx` shell.
 *
 * The session gate lives in `beforeLoad`, so it runs **on the server** before any
 * markup is produced: an anonymous visitor is redirected to `/login` with a 302
 * rather than rendering a shell and flashing a login form after hydration (the
 * behaviour of the old `authClient.useSession()` check). The resolved user is
 * returned into the route context so the topbar renders server-side too.
 */
export const Route = createFileRoute("/_authed")({
    beforeLoad: async ({ location }) => {
        return { session: await requireSession(location.pathname) };
    },
    component: AuthedLayout,
});
