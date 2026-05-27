import Link from "next/link";
import type { ReactElement } from "react";

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

const HomePage = (): ReactElement => (
    <main style={{ margin: "0 auto", maxWidth: 960, padding: "6rem 1.5rem" }}>
        <section>
            <p style={{ color: "#7CC4FF", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase" }}>≡ cirrus</p>
            <h1 style={{ fontSize: 48, lineHeight: 1.1, marginTop: 16 }}>Type-safe real-time backend on your own Cloudflare account.</h1>
            <p style={{ color: "#475569", fontSize: 18, marginTop: 16, maxWidth: 640 }}>
                Cirrus brings the Convex developer experience to Cloudflare Workers, Durable Objects, D1, R2 and Queues — without vendor lock-in. Vite plugin
                first, standalone CLI second.
            </p>
            <p style={{ marginTop: 28 }}>
                <Link
                    href="/docs"
                    style={{
                        background: "#0B0F19",
                        borderRadius: 8,
                        color: "white",
                        display: "inline-block",
                        padding: "12px 20px",
                        textDecoration: "none",
                    }}
                >
                    Read the docs
                </Link>
            </p>
        </section>

        <section style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(3, 1fr)", marginTop: 72 }}>
            {features.map((feature) => (
                <article key={feature.title} style={{ border: "1px solid #E2E8F0", borderRadius: 12, padding: 20 }}>
                    <h2 style={{ fontSize: 18, margin: 0 }}>{feature.title}</h2>
                    <p style={{ color: "#475569", marginTop: 8 }}>{feature.body}</p>
                </article>
            ))}
        </section>
    </main>
);

export default HomePage;
