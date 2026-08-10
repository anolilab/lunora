import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { useState } from "react";
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

// Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed
// Worker; `vite.config.ts` otherwise defines it as the dev server's resolved
// origin, because the composed `virtual:lunora/worker` entry serves Lunora from
// this same worker. The literal below is only a last resort if that plugin is
// removed.
const isServer = typeof globalThis.window === "undefined";
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (isServer ? "http://localhost:5173" : globalThis.location.origin);

/**
 * Root route component. Mounts the LunoraProvider so every child route can call
 * `useQuery` / `useMutation` / `useSubscription`.
 */
export default function App() {
    // Built per render tree, NOT at module scope: on the server a module-level
    // client is shared by every concurrent request, so one visitor's cached
    // results — and eventually their identity — leak into the next render.
    const [lunoraClient] = useState(() => new LunoraClient({ url: lunoraUrl }));

    return (
        <LunoraProvider client={lunoraClient}>
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
