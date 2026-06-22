import type { Cell, Comparison, CompareRow, CompareSlug } from "./compare-page";

/**
 * Honest comparison data. Verified against primary sources (each vendor's docs,
 * GitHub, pricing) as of 2026. Keep it fair: name where the other tool genuinely
 * wins (maturity, breadth, SQL, mobile), and only claim real Lunora differences
 * (edge-native, your own Cloudflare account, reactive queries, ≈$0 idle, types).
 */

// Lunora's column, the same across every comparison.
const L = {
    data: { label: "SQLite Durable Objects (typed)", tone: "neutral" } as Cell,
    edge: { label: "Yes, Cloudflare edge + DO", tone: "yes" } as Cell,
    idle: { label: "≈$0, no forced pause", tone: "yes" } as Cell,
    maturity: { label: "Alpha", tone: "warn" } as Cell,
    noServers: { label: "Yes, serverless Workers", tone: "yes" } as Cell,
    oss: { label: "Yes (FSL-1.1 → Apache-2.0)", tone: "yes" } as Cell,
    reactive: { label: "Yes, reactive queries", tone: "yes" } as Cell,
    selfHost: { label: "Yes", tone: "yes" } as Cell,
    types: { label: "Yes, typed functions", tone: "yes" } as Cell,
};

interface ThemCells {
    data: Cell;
    edge: Cell;
    idle: Cell;
    maturity: Cell;
    noServers: Cell;
    oss: Cell;
    reactive: Cell;
    selfHost: Cell;
    types: Cell;
}

const buildRows = (them: ThemCells): CompareRow[] => [
    { criterion: "End-to-end TypeScript types", lunora: L.types, them: them.types },
    { criterion: "Reactive queries by default", lunora: L.reactive, them: them.reactive },
    { criterion: "Data model", lunora: L.data, them: them.data },
    { criterion: "Open source", lunora: L.oss, them: them.oss },
    { criterion: "Self-hostable", lunora: L.selfHost, them: them.selfHost },
    { criterion: "Self-host with no servers to run", lunora: L.noServers, them: them.noServers },
    { criterion: "Edge / global by default", lunora: L.edge, them: them.edge },
    { criterion: "≈$0 at idle, no forced pause", lunora: L.idle, them: them.idle },
    { criterion: "Maturity", lunora: L.maturity, them: them.maturity },
];

export const COMPARISONS: Record<string, Comparison> = {
    appwrite: {
        description:
            "Lunora vs Appwrite: both are open source and self-hostable, but Appwrite self-hosts as a Docker stack (MariaDB + services) while Lunora runs as serverless Workers on your own Cloudflare account, with reactive queries and edge-native Durable Objects. Honest comparison.",
        intro: "Appwrite is a mature open-source BaaS you self-host with Docker. Lunora is a Cloudflare-native framework that self-hosts as serverless Workers, with reactive queries and edge-native state. Here's the honest comparison.",
        lunoraDiffers: {
            body: "Appwrite's realtime is manual channel subscriptions over WebSocket; Lunora's reactive queries re-evaluate for you. Appwrite self-hosts as a Docker stack (MariaDB plus several services) you operate; Lunora self-hosts as serverless Workers on the Cloudflare account you already have, nothing to keep running, ≈$0 at idle, at the edge. Lunora's typed query/mutation/action model gives stronger end-to-end inference. The trade: Lunora is alpha.",
            title: "Reactive, typed, edge-native",
        },
        name: "Appwrite",
        rows: buildRows({
            data: { label: "MariaDB relational (abstraction)", tone: "neutral" },
            edge: { label: "Regional / your own server", tone: "no" },
            idle: { label: "Self-host free; Cloud free tier", tone: "neutral" },
            maturity: { label: "Production-ready (since 2019)", tone: "yes" },
            noServers: { label: "No, Docker stack", tone: "no" },
            oss: { label: "Yes (BSD-3-Clause)", tone: "yes" },
            reactive: { label: "No, channel subscriptions", tone: "no" },
            selfHost: { label: "Yes, Docker, no limits", tone: "yes" },
            types: { label: "SDKs; limited type inference", tone: "warn" },
        }),
        slug: "appwrite",
        summary: [
            "Looking for an Appwrite alternative that runs serverless on the edge? Both Appwrite and Lunora are open source and self-hostable. The difference is how. Appwrite self-hosts as a Docker stack (MariaDB plus several services) you operate; Lunora self-hosts as serverless Cloudflare Workers with nothing to keep running.",
            "Appwrite is broader and more battle-tested today, with Auth, Databases, Storage, Functions, and Messaging. Lunora trades that breadth for an edge-native model: reactive queries by default, per-tenant Durable Objects, stronger TypeScript inference, and roughly $0 at idle. Lunora is alpha.",
        ],
        faqs: [
            {
                a: "Both are open-source and self-hostable. Choose Lunora for serverless, edge-native deployment on your Cloudflare account with reactive queries; choose Appwrite for a broad, mature BaaS you run as a Docker stack.",
                q: "Is Lunora an Appwrite alternative?",
            },
            {
                a: "Yes, Appwrite is open source under the BSD-3-Clause license and self-hostable with Docker, with no usage limits.",
                q: "Is Appwrite open source?",
            },
            {
                a: "Yes, via Docker. It runs MariaDB plus several services you operate. Lunora self-hosts as serverless Workers on Cloudflare, with no containers or database to run.",
                q: "Can you self-host Appwrite?",
            },
            {
                a: "Appwrite offers realtime via channel subscriptions over WebSocket, which you wire up manually. Lunora's reactive queries re-evaluate for you by default.",
                q: "Does Appwrite have reactive queries?",
            },
            {
                a: "Appwrite uses MariaDB with a relational abstraction. Lunora uses typed SQLite Durable Objects at the edge, with end-to-end-typed query and mutation functions.",
                q: "How do the data models differ?",
            },
        ],
        theyWin: {
            body: "Appwrite is an established open-source BaaS (BSD-3, since 2019) with a broad product surface, Auth, Databases, Storage, Functions, Messaging, self-hostable via Docker with no usage limits, plus a friendly console and a managed Appwrite Cloud. It's broader and more battle-tested than alpha Lunora.",
            title: "Mature, broad, permissive",
        },
    },
    convex: {
        description:
            "Lunora vs Convex: the same Convex-style DX (typed functions, reactive queries) and the same FSL-1.1 → Apache-2.0 license, but Lunora runs on your own Cloudflare account at the edge, not on Convex's regional AWS. An honest comparison, including where Convex still wins.",
        intro: "Convex set the bar for real-time backend DX. Lunora gives you the same end-to-end-typed, reactive model and the same open-source license, but it runs on your own Cloudflare account at the edge instead of Convex's cloud. Here's the honest comparison.",
        lunoraDiffers: {
            body: "Both are end-to-end-typed, both have reactive queries, and both ship the same FSL-1.1 → Apache-2.0 license, so the real difference is not 'open source.' It is where it runs. Convex Cloud is regional AWS (US-East, EU-West) and a separate vendor and bill; Lunora runs on Cloudflare's global edge and Durable Objects, on the account you already have. Self-hosted Convex means operating a Rust server and a SQL database; Lunora self-hosts as serverless Workers, nothing to keep running, ≈$0 at idle.",
            title: "Edge-native, on your own Cloudflare",
        },
        name: "Convex",
        rows: buildRows({
            data: { label: "Document / reactive DB", tone: "neutral" },
            edge: { label: "No, regional AWS (US, EU)", tone: "no" },
            idle: { label: "Free tier on Convex's AWS", tone: "warn" },
            maturity: { label: "Production-ready (GA 2023)", tone: "yes" },
            noServers: { label: "No, Rust server + SQL DB", tone: "no" },
            oss: { label: "Yes (FSL-1.1 → Apache-2.0)", tone: "yes" },
            reactive: { label: "Yes", tone: "yes" },
            selfHost: { label: "Yes", tone: "yes" },
            types: { label: "Yes", tone: "yes" },
        }),
        slug: "convex",
        summary: [
            "Looking for a Convex alternative that runs on your own infrastructure? Lunora gives you the same developer experience, typed query, mutation, and action functions with reactive queries that update live, but it runs on Cloudflare Workers and Durable Objects instead of Convex's managed cloud.",
            "Both projects ship the same FSL-1.1 to Apache-2.0 license and both can be self-hosted, so the real choice is not open source versus closed. It is where your backend runs and who you pay. Convex Cloud is hosted on AWS in a few regions; Lunora runs on Cloudflare's global edge, on the account you already use, and idles at roughly zero cost.",
        ],
        faqs: [
            {
                a: "Yes. The Convex backend is open source under FSL-1.1-Apache-2.0, the same license model Lunora uses, so 'open source' is not a difference between them.",
                q: "Is Convex open source?",
            },
            {
                a: "Yes, Convex is self-hostable, but the self-hosted backend runs an always-on Rust server plus a SQL database. Lunora self-hosts as serverless Cloudflare Workers, with nothing to keep running and roughly $0 at idle.",
                q: "Can you self-host Convex?",
            },
            {
                a: "If you want Convex-style DX, typed functions and reactive queries, but running on your own Cloudflare account at the edge, yes. Convex is more mature today with more built-in features; Lunora is alpha.",
                q: "Is Lunora a good Convex alternative?",
            },
            {
                a: "Convex Cloud runs on AWS in US-East and EU-West. Lunora runs on Cloudflare's global edge network with per-tenant Durable Objects, on the Cloudflare account you already have.",
                q: "Where does Convex run compared to Lunora?",
            },
        ],
        theyWin: {
            body: "Convex has been GA since 2023 with a large ecosystem, built-in file storage, text and vector search, crons, scheduling, a polished dashboard, log streaming, backups, and a big community. It is fully managed: no Cloudflare account or Durable-Object knowledge needed. Lunora is alpha and has fewer batteries today.",
            title: "Breadth and maturity",
        },
    },
    firebase: {
        description:
            "Lunora vs Firebase: Firebase is mature, mobile-first, and proprietary Google-only. Lunora is open source, runs on your own Cloudflare account, gives you a typed schema instead of schemaless NoSQL, and idles near $0. Honest comparison, including where Firebase still wins.",
        intro: "Firebase is the mature, mobile-first default, proprietary and Google-only. Lunora is open source, typed, and runs on your own Cloudflare account at the edge. Here's the honest comparison, including where Firebase still wins.",
        lunoraDiffers: {
            body: "Firestore is schemaless NoSQL, type-safety means hand-writing a converter per collection. Lunora gives you a typed schema with end-to-end inference. Firebase is proprietary and Google-only, with well-known lock-in and per-operation billing that can spike under load; Lunora is open source, runs on the Cloudflare account you already have, and idles near $0. The trade: Lunora is alpha and web/TypeScript-first, no native mobile SDKs or push yet.",
            title: "Typed, open, and yours",
        },
        name: "Firebase",
        rows: buildRows({
            data: { label: "NoSQL documents", tone: "neutral" },
            edge: { label: "Google multi-region", tone: "warn" },
            idle: { label: "Free tier; per-op billing can spike", tone: "warn" },
            maturity: { label: "Production-ready (since 2011)", tone: "yes" },
            noServers: { label: "No self-host", tone: "no" },
            oss: { label: "No, proprietary (SDKs only)", tone: "no" },
            reactive: { label: "Yes, onSnapshot listeners", tone: "yes" },
            selfHost: { label: "No, Google-managed only", tone: "no" },
            types: { label: "Manual converters (schemaless)", tone: "warn" },
        }),
        slug: "firebase",
        summary: [
            "Looking for an open-source Firebase alternative? Firebase is mature and mobile-first, but it is proprietary, Google-only, and schemaless. Lunora is open source, gives you a typed schema with end-to-end type inference, and runs on your own Cloudflare account.",
            "Firestore's per-operation billing is well known for unpredictable bills as traffic grows, and there is no way to self-host or move off Google. Lunora runs on Cloudflare infrastructure you control and idles near zero. The trade: Firebase is far more mature and ships first-class native mobile SDKs and push, which Lunora does not have yet.",
        ],
        faqs: [
            {
                a: "Lunora is an open-source, typed, self-hostable alternative for web and TypeScript apps on Cloudflare. Firebase remains the stronger choice for native mobile apps and for teams that want maximum maturity.",
                q: "Is Lunora a Firebase alternative?",
            },
            {
                a: "No. The Firebase client SDKs are open source, but the backend platform is proprietary Google with no open backend you can run yourself.",
                q: "Is Firebase open source?",
            },
            {
                a: "No. Firestore is a fully managed Google Cloud service and cannot be self-hosted. Lunora runs on your own Cloudflare account.",
                q: "Can you self-host Firebase?",
            },
            {
                a: "Yes. Lunora has a typed schema with end-to-end inference. Firestore is schemaless, so type-safety means hand-writing a converter per collection that can drift from your data.",
                q: "Is Lunora type-safe compared to Firestore?",
            },
            {
                a: "Largely, yes. Its proprietary NoSQL model and Google-only hosting make migration hard. Lunora is open source and runs on infrastructure you own.",
                q: "Does Firebase lock you in?",
            },
        ],
        theyWin: {
            body: "Firebase is over a decade old with best-in-class native mobile SDKs (iOS, Android, Flutter), FCM push, a vast ecosystem, excellent docs, and the easiest possible cold start on a generous free tier. For mobile-first apps it is hard to beat.",
            title: "Maturity, mobile, and ecosystem",
        },
    },
    supabase: {
        description:
            "Lunora vs Supabase: Supabase gives you a real managed Postgres and a mature ecosystem. Lunora is edge-native, reactive queries, per-tenant Durable Objects on your own Cloudflare account, ≈$0 at idle with no project pause. Honest comparison, including where Supabase still wins.",
        intro: "Supabase gives you a real, managed Postgres and a mature ecosystem. Lunora is edge-native, reactive queries and per-tenant Durable Objects on your own Cloudflare account. Here's the honest comparison, including where Supabase still wins.",
        lunoraDiffers: {
            body: "Supabase Realtime is a separate change-feed and broadcast API you wire up; Lunora's reactive queries are the default. Supabase is a single-primary region (plus read replicas) on managed AWS, and its free projects pause after a week idle; Lunora runs per-tenant Durable Objects at the edge, ≈$0 at idle with no pause, on your own Cloudflare account, no Postgres to provision, size, or back up. Types are inferred from your functions, not generated from a schema.",
            title: "Edge-native, reactive, nothing to provision",
        },
        name: "Supabase",
        rows: buildRows({
            data: { label: "Full Postgres (SQL)", tone: "yes" },
            edge: { label: "Regional Postgres + read replicas", tone: "warn" },
            idle: { label: "Free tier pauses after ~7 days idle", tone: "warn" },
            maturity: { label: "Production-ready", tone: "yes" },
            noServers: { label: "No, Docker stack (community)", tone: "no" },
            oss: { label: "Yes (Apache-2.0)", tone: "yes" },
            reactive: { label: "No, change-feed / broadcast API", tone: "no" },
            selfHost: { label: "Yes, Docker (community)", tone: "yes" },
            types: { label: "Generated schema types", tone: "warn" },
        }),
        slug: "supabase",
        summary: [
            "Looking for a Supabase alternative built for the edge? Supabase gives you a real, managed Postgres with a mature ecosystem. Lunora takes a different shape: per-tenant Durable Objects on Cloudflare with reactive queries as the default primitive, running on your own Cloudflare account.",
            "The honest trade is data model versus locality. Supabase is full Postgres, with arbitrary SQL, joins, and extensions, in a single primary region with read replicas. Lunora colocates compute and state at the edge with no database to provision, but a Durable-Object and SQLite model does not match raw Postgres SQL.",
        ],
        faqs: [
            {
                a: "For edge-native, reactive real-time apps on your own Cloudflare account, yes. Supabase is the better fit if you want full managed Postgres, SQL, and a mature ecosystem today.",
                q: "Is Lunora a Supabase alternative?",
            },
            {
                a: "No. Lunora stores state in SQLite-backed Durable Objects at the edge. Supabase gives you a full Postgres database with the entire SQL and extension ecosystem.",
                q: "Does Lunora use Postgres?",
            },
            {
                a: "No. Supabase Realtime is a separate change-feed, broadcast, and presence API you wire up. Lunora's reactive queries re-evaluate and stay correct for you by default.",
                q: "Is Supabase realtime the same as reactive queries?",
            },
            {
                a: "Yes, via Docker, but it is a multi-service stack (Postgres, Auth, PostgREST, Realtime, Storage, and more) and is community-supported. Lunora self-hosts as serverless Workers on Cloudflare.",
                q: "Can you self-host Supabase?",
            },
            {
                a: "Yes. Supabase pauses free projects after about a week of inactivity. Lunora idles at roughly $0 on Cloudflare's free tier with no forced pause.",
                q: "Do free Supabase projects pause?",
            },
        ],
        theyWin: {
            body: "Supabase gives you a real, dedicated Postgres, arbitrary SQL, joins, transactions, and the whole extension ecosystem (pgvector, PostGIS). It is mature, broadly adopted, permissively licensed (Apache-2.0), and batteries-included (Auth, Storage, Edge Functions). A Durable-Object/SQLite model cannot match raw SQL breadth.",
            title: "Full Postgres and maturity",
        },
    },
};

/** Order used for the /compare index and the "compare with" links. */
export const COMPARE_LIST: { name: string; slug: CompareSlug; tagline: string }[] = [
    { name: "Convex", slug: "convex", tagline: "Same DX and license, on your own Cloudflare, at the edge." },
    { name: "Supabase", slug: "supabase", tagline: "Edge-native and reactive vs managed Postgres." },
    { name: "Firebase", slug: "firebase", tagline: "Open and typed vs proprietary, Google-only NoSQL." },
    { name: "Appwrite", slug: "appwrite", tagline: "Serverless on your Cloudflare vs a self-hosted Docker stack." },
];

export const othersFor = (slug: CompareSlug): { name: string; slug: CompareSlug }[] =>
    COMPARE_LIST.filter((item) => item.slug !== slug).map(({ name, slug: s }) => ({ name, slug: s }));
