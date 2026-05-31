import Link from "next/link";
import type { CSSProperties, ReactElement } from "react";

const features = [
    {
        body: "Subscriptions hibernate when idle, replay deltas on reconnect, and stay strongly consistent within a shard.",
        title: "Real-time by default",
    },
    {
        body: "Start with a single root Durable Object. Opt into .shardBy() or .global() once your workload demands it.",
        title: "Sharding when you need it",
    },
    {
        body: "Codegen runs through the Vite module graph. HMR updates types and routes the moment a schema changes.",
        title: "Vite-first DX",
    },
];

// Hoisted so the inline literals aren't reallocated (and re-flagged) per render.
const MAIN_STYLE: CSSProperties = { margin: "0 auto", maxWidth: 960, padding: "6rem 1.5rem" };
const EYEBROW_STYLE: CSSProperties = { color: "#7CC4FF", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase" };
const HEADING_STYLE: CSSProperties = { fontSize: 48, lineHeight: 1.1, marginTop: 16 };
const LEAD_STYLE: CSSProperties = { color: "#475569", fontSize: 18, marginTop: 16, maxWidth: 640 };
const CTA_WRAP_STYLE: CSSProperties = { marginTop: 28 };
const CTA_LINK_STYLE: CSSProperties = {
    background: "#0B0F19",
    borderRadius: 8,
    color: "white",
    display: "inline-block",
    padding: "12px 20px",
    textDecoration: "none",
};
const GRID_STYLE: CSSProperties = { display: "grid", gap: 24, gridTemplateColumns: "repeat(3, 1fr)", marginTop: 72 };
const CARD_STYLE: CSSProperties = { border: "1px solid #E2E8F0", borderRadius: 12, padding: 20 };
const CARD_TITLE_STYLE: CSSProperties = { fontSize: 18, margin: 0 };
const CARD_BODY_STYLE: CSSProperties = { color: "#475569", marginTop: 8 };

const HomePage = (): ReactElement => (
    <main style={MAIN_STYLE}>
        <section>
            <p style={EYEBROW_STYLE}>≡ cirrus</p>
            <h1 style={HEADING_STYLE}>Type-safe real-time backend on your own Cloudflare account.</h1>
            <p style={LEAD_STYLE}>
                Cirrus brings the Convex developer experience to Cloudflare Workers, Durable Objects, D1, R2 and Queues — without vendor lock-in. Vite plugin
                first, standalone CLI second.
            </p>
            <p style={CTA_WRAP_STYLE}>
                <Link href="/docs" style={CTA_LINK_STYLE}>
                    Read the docs
                </Link>
            </p>
        </section>

        <section style={GRID_STYLE}>
            {features.map((feature) => (
                <article key={feature.title} style={CARD_STYLE}>
                    <h2 style={CARD_TITLE_STYLE}>{feature.title}</h2>
                    <p style={CARD_BODY_STYLE}>{feature.body}</p>
                </article>
            ))}
        </section>
    </main>
);

export default HomePage;
