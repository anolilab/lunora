import type { Cell, Comparison, CompareRow, CompareSlug } from "./compare-page";

/**
 * Honest comparison data. Verified against primary sources (each vendor's docs,
 * GitHub, pricing) as of 2026. Keep it fair: name where the other tool genuinely
 * wins (maturity, breadth, SQL, mobile), and only claim real Lunora differences
 * (edge-native, your own Cloudflare account, reactive queries, ≈$0 idle, types).
 */

// Lunora's column — the same across every comparison.
const L = {
    data: { label: "SQLite Durable Objects (typed)", tone: "neutral" } as Cell,
    edge: { label: "Yes — Cloudflare edge + DO", tone: "yes" } as Cell,
    idle: { label: "≈$0, no forced pause", tone: "yes" } as Cell,
    maturity: { label: "Alpha", tone: "warn" } as Cell,
    noServers: { label: "Yes — serverless Workers", tone: "yes" } as Cell,
    oss: { label: "Yes (FSL-1.1 → Apache-2.0)", tone: "yes" } as Cell,
    reactive: { label: "Yes — reactive queries", tone: "yes" } as Cell,
    selfHost: { label: "Yes", tone: "yes" } as Cell,
    types: { label: "Yes — typed functions", tone: "yes" } as Cell,
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
            body: "Appwrite's realtime is manual channel subscriptions over WebSocket; Lunora's reactive queries re-evaluate for you. Appwrite self-hosts as a Docker stack (MariaDB plus several services) you operate; Lunora self-hosts as serverless Workers on the Cloudflare account you already have — nothing to keep running, ≈$0 at idle, at the edge. Lunora's typed query/mutation/action model gives stronger end-to-end inference. The trade: Lunora is alpha.",
            title: "Reactive, typed, edge-native",
        },
        name: "Appwrite",
        rows: buildRows({
            data: { label: "MariaDB relational (abstraction)", tone: "neutral" },
            edge: { label: "Regional / your own server", tone: "no" },
            idle: { label: "Self-host free; Cloud free tier", tone: "neutral" },
            maturity: { label: "Production-ready (since 2019)", tone: "yes" },
            noServers: { label: "No — Docker stack", tone: "no" },
            oss: { label: "Yes (BSD-3-Clause)", tone: "yes" },
            reactive: { label: "No — channel subscriptions", tone: "no" },
            selfHost: { label: "Yes — Docker, no limits", tone: "yes" },
            types: { label: "SDKs; limited type inference", tone: "warn" },
        }),
        slug: "appwrite",
        theyWin: {
            body: "Appwrite is an established open-source BaaS (BSD-3, since 2019) with a broad product surface — Auth, Databases, Storage, Functions, Messaging — self-hostable via Docker with no usage limits, plus a friendly console and a managed Appwrite Cloud. It's broader and more battle-tested than alpha Lunora.",
            title: "Mature, broad, permissive",
        },
    },
    convex: {
        description:
            "Lunora vs Convex: the same Convex-style DX (typed functions, reactive queries) and the same FSL-1.1 → Apache-2.0 license — but Lunora runs on your own Cloudflare account at the edge, not on Convex's regional AWS. An honest comparison, including where Convex still wins.",
        intro: "Convex set the bar for real-time backend DX. Lunora gives you the same end-to-end-typed, reactive model and the same open-source license, but it runs on your own Cloudflare account at the edge instead of Convex's cloud. Here's the honest comparison.",
        lunoraDiffers: {
            body: "Both are end-to-end-typed, both have reactive queries, and both ship the same FSL-1.1 → Apache-2.0 license — so the real difference is not 'open source.' It is where it runs. Convex Cloud is regional AWS (US-East, EU-West) and a separate vendor and bill; Lunora runs on Cloudflare's global edge and Durable Objects, on the account you already have. Self-hosted Convex means operating a Rust server and a SQL database; Lunora self-hosts as serverless Workers — nothing to keep running, ≈$0 at idle.",
            title: "Edge-native, on your own Cloudflare",
        },
        name: "Convex",
        rows: buildRows({
            data: { label: "Document / reactive DB", tone: "neutral" },
            edge: { label: "No — regional AWS (US, EU)", tone: "no" },
            idle: { label: "Free tier on Convex's AWS", tone: "warn" },
            maturity: { label: "Production-ready (GA 2023)", tone: "yes" },
            noServers: { label: "No — Rust server + SQL DB", tone: "no" },
            oss: { label: "Yes (FSL-1.1 → Apache-2.0)", tone: "yes" },
            reactive: { label: "Yes", tone: "yes" },
            selfHost: { label: "Yes", tone: "yes" },
            types: { label: "Yes", tone: "yes" },
        }),
        slug: "convex",
        theyWin: {
            body: "Convex has been GA since 2023 with a large ecosystem — built-in file storage, text and vector search, crons, scheduling, a polished dashboard, log streaming, backups, and a big community. It is fully managed: no Cloudflare account or Durable-Object knowledge needed. Lunora is alpha and has fewer batteries today.",
            title: "Breadth and maturity",
        },
    },
    firebase: {
        description:
            "Lunora vs Firebase: Firebase is mature, mobile-first, and proprietary Google-only. Lunora is open source, runs on your own Cloudflare account, gives you a typed schema instead of schemaless NoSQL, and idles near $0. Honest comparison, including where Firebase still wins.",
        intro: "Firebase is the mature, mobile-first default — proprietary and Google-only. Lunora is open source, typed, and runs on your own Cloudflare account at the edge. Here's the honest comparison, including where Firebase still wins.",
        lunoraDiffers: {
            body: "Firestore is schemaless NoSQL — type-safety means hand-writing a converter per collection. Lunora gives you a typed schema with end-to-end inference. Firebase is proprietary and Google-only, with well-known lock-in and per-operation billing that can spike under load; Lunora is open source, runs on the Cloudflare account you already have, and idles near $0. The trade: Lunora is alpha and web/TypeScript-first — no native mobile SDKs or push yet.",
            title: "Typed, open, and yours",
        },
        name: "Firebase",
        rows: buildRows({
            data: { label: "NoSQL documents", tone: "neutral" },
            edge: { label: "Google multi-region", tone: "warn" },
            idle: { label: "Free tier; per-op billing can spike", tone: "warn" },
            maturity: { label: "Production-ready (since 2011)", tone: "yes" },
            noServers: { label: "No self-host", tone: "no" },
            oss: { label: "No — proprietary (SDKs only)", tone: "no" },
            reactive: { label: "Yes — onSnapshot listeners", tone: "yes" },
            selfHost: { label: "No — Google-managed only", tone: "no" },
            types: { label: "Manual converters (schemaless)", tone: "warn" },
        }),
        slug: "firebase",
        theyWin: {
            body: "Firebase is over a decade old with best-in-class native mobile SDKs (iOS, Android, Flutter), FCM push, a vast ecosystem, excellent docs, and the easiest possible cold start on a generous free tier. For mobile-first apps it is hard to beat.",
            title: "Maturity, mobile, and ecosystem",
        },
    },
    supabase: {
        description:
            "Lunora vs Supabase: Supabase gives you a real managed Postgres and a mature ecosystem. Lunora is edge-native — reactive queries, per-tenant Durable Objects on your own Cloudflare account, ≈$0 at idle with no project pause. Honest comparison, including where Supabase still wins.",
        intro: "Supabase gives you a real, managed Postgres and a mature ecosystem. Lunora is edge-native — reactive queries and per-tenant Durable Objects on your own Cloudflare account. Here's the honest comparison, including where Supabase still wins.",
        lunoraDiffers: {
            body: "Supabase Realtime is a separate change-feed and broadcast API you wire up; Lunora's reactive queries are the default. Supabase is a single-primary region (plus read replicas) on managed AWS, and its free projects pause after a week idle; Lunora runs per-tenant Durable Objects at the edge, ≈$0 at idle with no pause, on your own Cloudflare account — no Postgres to provision, size, or back up. Types are inferred from your functions, not generated from a schema.",
            title: "Edge-native, reactive, nothing to provision",
        },
        name: "Supabase",
        rows: buildRows({
            data: { label: "Full Postgres (SQL)", tone: "yes" },
            edge: { label: "Regional Postgres + read replicas", tone: "warn" },
            idle: { label: "Free tier pauses after ~7 days idle", tone: "warn" },
            maturity: { label: "Production-ready", tone: "yes" },
            noServers: { label: "No — Docker stack (community)", tone: "no" },
            oss: { label: "Yes (Apache-2.0)", tone: "yes" },
            reactive: { label: "No — change-feed / broadcast API", tone: "no" },
            selfHost: { label: "Yes — Docker (community)", tone: "yes" },
            types: { label: "Generated schema types", tone: "warn" },
        }),
        slug: "supabase",
        theyWin: {
            body: "Supabase gives you a real, dedicated Postgres — arbitrary SQL, joins, transactions, and the whole extension ecosystem (pgvector, PostGIS). It is mature, broadly adopted, permissively licensed (Apache-2.0), and batteries-included (Auth, Storage, Edge Functions). A Durable-Object/SQLite model cannot match raw SQL breadth.",
            title: "Full Postgres and maturity",
        },
    },
};

/** Order used for the /compare index and the "compare with" links. */
export const COMPARE_LIST: { name: string; slug: CompareSlug; tagline: string }[] = [
    { name: "Convex", slug: "convex", tagline: "Same DX and license — on your own Cloudflare, at the edge." },
    { name: "Supabase", slug: "supabase", tagline: "Edge-native and reactive vs managed Postgres." },
    { name: "Firebase", slug: "firebase", tagline: "Open and typed vs proprietary, Google-only NoSQL." },
    { name: "Appwrite", slug: "appwrite", tagline: "Serverless on your Cloudflare vs a self-hosted Docker stack." },
];

export const othersFor = (slug: CompareSlug): { name: string; slug: CompareSlug }[] =>
    COMPARE_LIST.filter((item) => item.slug !== slug).map(({ name, slug: s }) => ({ name, slug: s }));
