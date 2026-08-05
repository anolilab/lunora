import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";

/**
 * Wrap `children` in a minimal in-memory TanStack router so components that
 * call `useNavigate` / `useRouter` / `useSearch` mount under a
 * `RouterProvider` and don't emit `useRouter must be used inside a
 * <RouterProvider> component!` on every render. The studio's reports / advisors
 * panels only use `useNavigate` for click-throughs (`/traces`, `/schema`,
 * `/migrations`) — the tests never assert on those navigations, so a single
 * catch-all route at `/` with a no-op history is enough.
 *
 * A fresh router is built per call so each test's `children` are closed over by
 * the route's `component` (TanStack caches the route tree, not the closure).
 */
const wrapInRouter = (children: ReactNode): ReactElement => {
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({
        component: (): ReactElement => <>{children}</>,
        getParentRoute: () => rootRoute,
        path: "/",
    });
    const router = createRouter({
        history: createMemoryHistory({ initialEntries: ["/"] }),
        routeTree: rootRoute.addChildren([indexRoute]),
    });

    return <RouterProvider router={router} />;
};

export default wrapInRouter;
