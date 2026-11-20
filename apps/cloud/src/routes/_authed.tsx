import { createFileRoute, Outlet } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { loadSidebarOpen, parseSidebarOpen, requireSession } from "../ssr/loader";

/**
 * Pathless layout for every signed-in screen.
 *
 * It renders nothing but the `Outlet`. The chrome — header, account menu, sign-out,
 * theme toggle — belongs to `DashboardLayout`, which each screen mounts itself along
 * with its own sidebar contents, so this layout adds no header of its own.
 *
 * The session gate stays, and stays in `beforeLoad`, so it runs **on the server**
 * before any markup is produced: an anonymous visitor gets a 302 to `/login` rather
 * than a shell that flashes a login form after hydration. The resolved user is
 * returned into the route context, so child screens render the account menu
 * server-side.
 *
 * `sidebarOpen` rides the same context for the same reason: it comes off the request
 * cookie, so the server renders the rail in the state the browser will hydrate.
 */
const AuthedLayout = (): ReactElement => <Outlet />;

export const Route = createFileRoute("/_authed")({
    beforeLoad: async ({ location }) => {
        // `href`, not `pathname`: the search string is part of what the visitor asked
        // for (a `?traceId=` deep link), and dropping it returned them to the bare tab.
        // The server reads the cookie off the request. The browser reads it from
        // `document.cookie`: a server call here would run on every navigation and hover
        // preload, and the cookie is already in the browser.
        const sidebarOpen = import.meta.env.SSR ? loadSidebarOpen() : Promise.resolve(parseSidebarOpen(document.cookie));
        const [session, open] = await Promise.all([requireSession(location.href), sidebarOpen]);

        return { session, sidebarOpen: open };
    },
    component: AuthedLayout,
});
