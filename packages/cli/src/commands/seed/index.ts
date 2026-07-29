import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const seedCommand: Command = {
    description: "Generate deterministic fake data from lunora/schema.ts and bulk-insert it via the worker's admin endpoint",
    examples: [
        ["lunora seed", "Seed every table with the default row count"],
        ["lunora seed --table posts --count 50", "Seed 50 posts; FK-parent tables are seeded automatically"],
        ["lunora seed --reset", "Wipe local .wrangler/state, then seed from scratch"],
        ["lunora seed --seed 7 --dry-run", "Print the NDJSON for seed 7 without inserting"],
        ["lunora seed --seed 7 --now 1785000000000", "Byte-identical rows across runs (pins the clock too)"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "seed",
    options: [
        { description: "Rows per table (default 10)", name: "count", type: Number },
        { description: "Seed only this table; its FK-parent tables are seeded automatically", name: "table", type: String },
        { description: "Deterministic seed — same value yields identical rows (default 0)", name: "seed", type: Number },
        {
            description:
                "Epoch-ms reference for time columns (createdAt, expiresAt, …). Pin it with --seed for byte-identical rows across runs; defaults to now",
            name: "now",
            type: Number,
        },
        { description: "Print the generated NDJSON instead of inserting", name: "dry-run", type: Boolean },
        { description: "Wipe local .wrangler/state before seeding (local dev only)", name: "reset", type: Boolean },
        { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
        { description: "Skip the confirmation prompt when seeding a non-local/production target", name: "yes", type: Boolean },
    ],
};

export { seedCommand };

export type SeedOptions = CreateOptions<{
    "batch-size": number | undefined;
    count: number | undefined;
    "dry-run": boolean | undefined;
    now: number | undefined;
    prod: boolean | undefined;
    reset: boolean | undefined;
    seed: number | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
