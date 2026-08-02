import "@/lib/posthog";
import "unfonts.css";

import { ConsentBanner, ConsentDialog, ConsentManagerProvider } from "@c15t/react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { FC, PropsWithChildren } from "react";
import { lazy, Suspense } from "react";

import Footer from "@/components/sections/footer";
import Navbar from "@/components/sections/navbar";
import JsonLd from "@/components/seo/json-ld";
import { getConsentOverrides } from "@/lib/consent-overrides";
import { NotFound } from "@/pages/not-found";
import AnalyticsProvider from "@/providers/analytics-provider";
import appCss from "@/styles/app.css?url";

const TanStackRouterDevtools =
    process.env.NODE_ENV === "production"
        ? () => null
        : lazy(() =>
              import("@tanstack/react-router-devtools").then((res) => {
                  return {
                      default: res.TanStackRouterDevtools,
                  };
              }),
          );

const RootDocument: FC<PropsWithChildren> = ({ children }) => {
    const overrides = Route.useLoaderData();

    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <HeadContent />
                <JsonLd
                    data={{
                        "@type": "Organization",
                        logo: "https://lunora.sh/favicon.svg",
                        name: "Lunora",
                        sameAs: ["https://github.com/anolilab/lunora"],
                        url: "https://lunora.sh",
                    }}
                />
                <JsonLd
                    data={{
                        "@type": "WebSite",
                        name: "Lunora",
                        potentialAction: {
                            "@type": "SearchAction",
                            "query-input": "required name=search_term_string",
                            target: "https://lunora.sh/docs?q={search_term_string}",
                        },
                        url: "https://lunora.sh",
                    }}
                />
            </head>
            <body>
                <ConsentManagerProvider
                    options={{
                        colorScheme: "dark",
                        consentCategories: ["measurement", "necessary"],
                        legalLinks: { privacyPolicy: { href: "/privacy", target: "_self" } },
                        mode: "offline",
                        overrides,
                    }}
                >
                    <ConsentBanner hideBranding />
                    <ConsentDialog hideBranding />
                    <AnalyticsProvider>
                        <div className="bg-dark-coal relative isolate font-sans antialiased">
                            <svg aria-hidden="true" height="0" width="0">
                                <defs>
                                    <pattern height="4" id="pattern-ivory" patternUnits="userSpaceOnUse" width="1">
                                        <rect className="fill-ivory" height="1" width="1" />
                                    </pattern>
                                    <pattern height="4" id="pattern-sky-sapphire" patternUnits="userSpaceOnUse" width="1">
                                        <rect className="fill-sky-sapphire" height="1" width="1" />
                                    </pattern>
                                    <pattern height="4" id="pattern-crimson-energy" patternUnits="userSpaceOnUse" width="1">
                                        <rect className="fill-crimson-energy" height="1" width="1" />
                                    </pattern>
                                    <pattern height="4" id="pattern-royal-amethyst" patternUnits="userSpaceOnUse" width="1">
                                        <rect className="fill-royal-amethyst" height="1" width="1" />
                                    </pattern>
                                </defs>
                            </svg>

                            <RootProvider search={{ enabled: true }} theme={{ enabled: true, defaultTheme: "dark", forcedTheme: "dark" }}>
                                <Navbar />
                                <main className="relative">{children}</main>
                            </RootProvider>
                            <Footer />
                        </div>
                    </AnalyticsProvider>
                </ConsentManagerProvider>
                <Suspense>
                    <TanStackRouterDevtools position="bottom-right" />
                </Suspense>
                <Scripts />
            </body>
        </html>
    );
};

export const Route = createRootRoute({
    component: () => (
        <RootDocument>
            <Outlet />
        </RootDocument>
    ),
    loader: () => getConsentOverrides(),
    head: () => {
        return {
            links: [
                { href: appCss, rel: "stylesheet" },
                { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
                { color: "#4F46E5", href: "/favicon.svg", rel: "mask-icon" },
                { href: "/manifest.json", rel: "manifest" },
            ],
            meta: [
                {
                    charSet: "utf8",
                },
                {
                    content: "width=device-width, initial-scale=1",
                    name: "viewport",
                },
                {
                    content: "#4F46E5",
                    name: "theme-color",
                },
            ],
        };
    },
    notFoundComponent: (props) => <NotFound {...props} />,
    // Geo headers don't change within a session — never re-fetch on navigation.
    staleTime: Number.POSITIVE_INFINITY,
});
