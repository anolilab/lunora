import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `cirrus insights` — a Convex-Insights-style report over the live worker's
 * per-function metrics. Surfaces write-conflict hot-spots (OCC contention, the
 * sharding signal), error hot-spots, and latency outliers. Metadata only; the
 * handler (lazy-loaded via `loader`) holds the logic.
 */
const insightsCommand: Command = {
    description: "Report write-conflict hot-spots, error rates, and latency outliers from a running Worker",
    examples: [
        ["cirrus insights", "Report against the local dev worker"],
        ["cirrus insights --shard channel:demo", "Scope the report to one shard"],
        ["cirrus insights --json", "Emit the raw report as JSON"],
        ["cirrus insights --prod --url https://app.example.com --token $CIRRUS_ADMIN_TOKEN", "Report against production"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "insights",
    options: [
        { description: "Explicit shard key (defaults to the root shard)", name: "shard", type: String },
        { description: "Max rows per section (default 10)", name: "limit", type: String },
        { description: "Emit a JSON report instead of human text", name: "json", type: Boolean },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
    ],
};

export { insightsCommand };

export type InsightsOptions = CreateOptions<{
    json: boolean | undefined;
    limit: string | undefined;
    prod: boolean | undefined;
    shard: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
