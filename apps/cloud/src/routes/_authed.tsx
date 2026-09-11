import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { requireSession } from "../ssr/loader";

/**
 * Pathless layout for every signed-in screen.
 *
 * It renders nothing but the `Outlet`. Since the Luna + Aurora redesign the chrome
 * — top bar, account menu, sign-out, theme toggle — belongs to `DashboardLayout`,
 * which each screen mounts itself along with its own sidebar contents. Keeping the
 * old `.app`/`.topbar` markup here too would wrap that shell in a second, redundant
 * header.
 *
 * The session gate stays, and stays in `beforeLoad`, so it runs **on the server**
 * before any markup is produced: an anonymous visitor gets a 302 to `/login` rather
 * than a shell that flashes a login form after hydration. The resolved user is
 * returned into the route context, so child screens render the account menu
 * server-side.
 */
const AuthedLayout = (): ReactElement => <Outlet />;

export const Route = createFileRoute("/_authed")({
    beforeLoad: async ({ location }) => {
        // `href`, not `pathname`: the search string is part of what the visitor asked
        // for (a `?traceId=` deep link), and dropping it returned them to the bare tab.
        return { session: await requireSession(location.href) };
    },
    component: AuthedLayout,
});
