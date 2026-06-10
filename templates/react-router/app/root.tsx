import { CirrusProvider } from "@cirrus/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

/**
 * The HTML document shell. React Router renders this on both the server and the
 * client. The `CirrusProvider` opens the realtime client; TanStack Query owns
 * the client cache that Cirrus's `useQuery` / `usePreloadedQuery` read from.
 *
 * Same-origin note: on the server we have no `window`, so the provider points at
 * the local worker; in the browser it uses `window.location.origin` so the WS
 * upgrade (`/_cirrus/ws`) carries the same session cookie the SSR load used —
 * identity continuity without a token exchange (see app/routes/home.tsx).
 */
export function Layout({ children }: { children: React.ReactNode }) {
    // One QueryClient per document. A long stale time keeps TanStack Query from
    // racing the live WS subscription Cirrus attaches after hydration.
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: Number.POSITIVE_INFINITY,
                    },
                },
            }),
    );

    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{"{{name}}"}</title>
                <Meta />
                <Links />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <CirrusProvider url={typeof window === "undefined" ? "http://localhost:8787" : window.location.origin}>{children}</CirrusProvider>
                </QueryClientProvider>
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

export default function App() {
    return <Outlet />;
}
