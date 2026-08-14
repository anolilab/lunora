/**
 * Site configuration — every project-specific value the chrome and the
 * marketing pages read.
 *
 * This file plus `src/theme/tokens.css` are the two things a downstream project
 * replaces. Components under `src/kit/` never reference Lunora by name; they
 * take their strings, links, and structure from here.
 *
 * Keep *content* here and *behaviour* in the components. If you find yourself
 * wanting a boolean that toggles a layout, the layout belongs in the page.
 */

interface NavLeaf {
    /** One line, sentence case, no trailing period in nav lists. */
    description: string;
    href: string;
    /** Lucide icon name, resolved by the navbar. */
    icon: string;
    title: string;
}

interface NavFeature {
    href: string;
    /** Key into the navbar's image map, or an absolute URL. */
    image: string;
    subtitle: string;
    title: string;
}

interface NavSection {
    featureLink?: { href: string; title: string };
    features: NavFeature[];
    /** Lay the nav items out in N columns (suppresses feature cards). */
    navColumns?: number;
    navItems: NavLeaf[];
    navTitle: string;
}

type FooterEntry = { consentDialog: true; title: string } | { href: string; title: string } | { title: string; to: string };

export const siteConfig = {
    /**
     * Brand identity. `logo` names the file a downstream project swaps in
     * `src/assets/` — it is not read at runtime, because svgr imports
     * (`@/assets/*.svg?react`) are resolved by Vite at build time and a string
     * here can never become one.
     */
    brand: {
        description: "A type-safe, real-time backend on Cloudflare Workers and Durable Objects with a Vite-first developer experience.",
        logo: "lunora_logo.svg",
        name: "Lunora",
        tagline: "The realtime backend for Cloudflare",
        url: "https://lunora.sh",
    },

    /**
     * The footer's "Built by" band. Always rendered; the wordmark itself is a
     * static svgr import in `footer.tsx` (see `brand.logo`), so a downstream
     * project changes it there and changes the link and label here.
     */
    builtBy: {
        href: "https://anolilab.com?ref=lunora",
        name: "anolilab",
    },

    /** Primary CTA, used by the hero and the navbar. */
    cta: {
        install: "npx lunorash@alpha init my-app",
        primary: { label: "Start building", to: "/docs/getting-started" },
        secondary: { href: "https://github.com/anolilab/lunora", label: "View on GitHub" },
    },

    footer: {
        columns: [
            {
                links: [
                    { title: "Server", to: "/packages/server" },
                    { title: "Client", to: "/packages/client" },
                    { title: "React", to: "/packages/react" },
                    { title: "All packages", to: "/packages" },
                ] as FooterEntry[],
                title: "Packages",
            },
            {
                links: [
                    { title: "Getting started", to: "/docs/getting-started" },
                    { title: "Documentation", to: "/docs" },
                    { title: "Examples", to: "/examples" },
                    { title: "Lunora Cloud", to: "/cloud" },
                    { title: "Compare", to: "/compare" },
                    { title: "Blog", to: "/blog" },
                    { title: "Changelog", to: "/changelog" },
                ] as FooterEntry[],
                title: "Developers",
            },
            {
                links: [
                    { title: "Privacy", to: "/privacy" },
                    { consentDialog: true, title: "Cookie settings" },
                    { title: "Code of Conduct", to: "/code-of-conduct" },
                    { title: "Imprint", to: "/imprint" },
                    { title: "Press & Brand", to: "/press" },
                ] as FooterEntry[],
                title: "Legal",
            },
        ],
        legal: "Code: FSL-1.1-Apache-2.0. Visual Design & Branding: All Rights Reserved (CC BY-NC-ND 4.0).",
        copyright: "© 2026–present Lunora & Lunora Contributors",
    },

    /** Mega-menu. Each entry becomes one top-level navbar trigger. */
    nav: [
        {
            featureLink: { href: "/packages", title: "All packages" },
            features: [{ href: "/studio", image: "schema", subtitle: "Schema, data, SQL, and logs", title: "Studio" }],
            navItems: [
                { description: "Schema, queries, mutations, actions.", href: "/packages/server", icon: "Server", title: "Server" },
                { description: "ShardDO + SessionDO: SQLite, OCC, WS.", href: "/packages/do", icon: "Database", title: "Durable Objects" },
                { description: "Browser SDK, optimistic + offline queue.", href: "/packages/client", icon: "Boxes", title: "Client" },
                { description: "useQuery, useMutation, useSubscription.", href: "/packages/react", icon: "Sparkles", title: "React" },
                { description: "Live, indexed TanStack DB collections.", href: "/packages/db", icon: "HardDriveDownload", title: "TanStack DB" },
            ],
            navTitle: "Packages",
        },
        {
            features: [{ href: "/docs/getting-started", image: "home", subtitle: "A typed, live backend in an afternoon", title: "Getting started" }],
            navItems: [
                { description: "Build your first app in minutes.", href: "/docs/getting-started", icon: "Rocket", title: "Quickstart" },
                { description: "Scaffold an app for your framework.", href: "/start", icon: "LayoutTemplate", title: "Starter kits" },
                { description: "The full Lunora framework reference.", href: "/docs/", icon: "Book", title: "Documentation" },
                { description: "Auth: email/password, OAuth, passkeys.", href: "/packages/auth", icon: "KeyRound", title: "Auth" },
                { description: "Workers AI on the Vercel AI SDK.", href: "/packages/ai", icon: "Bot", title: "AI" },
                { description: "runAfter / runAt + Cron Triggers.", href: "/packages/scheduler", icon: "Clock", title: "Scheduler" },
            ],
            navTitle: "Developers",
        },
        {
            features: [
                { href: "/studio", image: "dashboards", subtitle: "A local studio for your backend", title: "Lunora Studio" },
                { href: "https://discord.gg/eajEZvk2PG", image: "community", subtitle: "Join us on Discord", title: "Community" },
            ],
            navItems: [
                { description: "Thirteen runnable apps, five deploy in a click.", href: "/examples", icon: "Boxes", title: "Examples" },
                { description: "Managed Lunora — join the waitlist.", href: "/cloud", icon: "Cloud", title: "Lunora Cloud" },
                { description: "vs Convex, Supabase, Firebase, Appwrite.", href: "/compare", icon: "Scale", title: "Compare" },
                { description: "Admin UI for schema, data, advisors.", href: "/studio", icon: "LayoutDashboard", title: "Studio" },
                { description: "R2 typed buckets and signed URLs.", href: "/packages/storage", icon: "HardDrive", title: "Storage" },
                { description: "New updates and improvements.", href: "/changelog", icon: "ScrollText", title: "Changelog" },
                { description: "Q&A, ideas, and discussion.", href: "https://github.com/anolilab/lunora/discussions", icon: "Handshake", title: "Discussions" },
                { description: "Chat with the community in real time.", href: "https://discord.gg/eajEZvk2PG", icon: "Discord", title: "Discord" },
                { description: "Issues, requests, and source code.", href: "https://github.com/anolilab/lunora", icon: "GitHub", title: "GitHub" },
            ],
            navColumns: 3,
            navTitle: "Resources",
        },
    ] satisfies NavSection[],

    /** Repository the docs "edit this page" links and stats point at. */
    repo: { branch: "alpha", contentPath: "apps/docs/src/content/docs", name: "lunora", owner: "anolilab" },

    social: [
        { href: "https://github.com/anolilab/lunora", icon: "GitHub", label: "GitHub" },
        { href: "https://discord.gg/eajEZvk2PG", icon: "Discord", label: "Discord" },
        { href: "https://github.com/anolilab/lunora/discussions", icon: "Discussions", label: "Discussions" },
    ],
};

export type { FooterEntry, NavFeature, NavLeaf, NavSection };
