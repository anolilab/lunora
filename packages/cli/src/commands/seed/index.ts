import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const seedCommand: Command = {
    description: "Generate deterministic fake data from cirrus/schema.ts and bulk-insert it via the worker's admin endpoint",
    examples: [
        ["cirrus seed", "Seed every table with the default row count"],
        ["cirrus seed --table posts --count 50", "Seed 50 posts; FK-parent tables are seeded automatically"],
        ["cirrus seed --reset", "Wipe local .wrangler/state, then seed from scratch"],
        ["cirrus seed --seed 7 --dry-run", "Print the NDJSON for seed 7 without inserting"],
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
        { description: "Print the generated NDJSON instead of inserting", name: "dry-run", type: Boolean },
        { description: "Wipe local .wrangler/state before seeding (local dev only)", name: "reset", type: Boolean },
        { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
    ],
};

export { seedCommand };

export type SeedOptions = CreateOptions<{
    "batch-size": number | undefined;
    count: number | undefined;
    "dry-run": boolean | undefined;
    prod: boolean | undefined;
    reset: boolean | undefined;
    seed: number | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
