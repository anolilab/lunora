import { LunoraProvider } from "@lunora/react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";

/**
 * Document shell. React Router v7 framework mode renders this `Layout` around
 * every route (and around the `ErrorBoundary` below). `<Meta>` / `<Links>` emit
 * the head tags collected from route modules; `<Scripts>` injects the client
 * bundle; `<ScrollRestoration>` preserves scroll position across navigations.
 */
export function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta content="width=device-width, initial-scale=1" name="viewport" />
                <title>{"{{name}}"}</title>
                <Meta />
                <Links />
            </head>
            <body>
                {children}
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

/**
 * Root route component. Mounts the LunoraProvider so every child route can call
 * `useQuery` / `useMutation` / `useSubscription`. On the server the URL points at
 * the local worker; in the browser it points at the page origin (same worker, via
 * the composed `virtual:lunora/worker` entry).
 */
export default function App() {
    return (
        <LunoraProvider url={typeof window === "undefined" ? "http://localhost:8787" : window.location.origin}>
            <Outlet />
        </LunoraProvider>
    );
}

/**
 * Framework-mode error boundary. Renders a 404 page for unmatched routes and a
 * generic error page for everything else.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
    let heading = "Oops!";
    let message = "An unexpected error occurred.";

    if (isRouteErrorResponse(error)) {
        heading = error.status === 404 ? "404" : `${error.status}`;
        message = error.status === 404 ? "This page could not be found." : error.statusText || message;
    }

    return (
        <main style={{ fontFamily: "system-ui", padding: "3rem", textAlign: "center" }}>
            <h1>{heading}</h1>
            <p>{message}</p>
            <a href="/">Go home</a>
        </main>
    );
}
