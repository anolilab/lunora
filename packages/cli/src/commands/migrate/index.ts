import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const migrateCommand: Command = {
    argument: { description: "generate | create | up | down | status | d1-to-hyperdrive [name|id]", name: "subcommand", type: String },
    description: "Schema (generate), online data (create | up | down | status), and backend (d1-to-hyperdrive) migrations",
    examples: [
        ["lunora migrate generate", "Diff lunora/schema.ts and emit a SQL migration"],
        ["lunora migrate create add_users_email", "Scaffold a data migration"],
        ["lunora migrate up backfill-names", "Run a data migration across shards"],
        ["lunora migrate status backfill-names", "Report a migration's per-shard status"],
        ["lunora migrate d1-to-hyperdrive --from-url https://old --to-url https://new", "Copy .global() data from D1 to Hyperdrive"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "migrate",
    options: [
        { description: "Migration name slug (e.g. add_users_email)", name: "name", type: String },
        { description: "Target table for `create` (prompted for interactively when omitted)", name: "table", type: String },
        { description: "Preview a data migration without rewriting rows", name: "dry-run", type: Boolean },
        { description: "Rows per batch for a data migration", name: "batch-size", type: Number },
        { description: "Cap batches processed this run (maps to the runner's maxBatches)", name: "steps", type: Number },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
        { description: "Required with --prod for up/down — confirms running against production", name: "yes", type: Boolean },
        // d1-to-hyperdrive backend migration.
        { description: "d1-to-hyperdrive: source (D1) worker URL (defaults to --url)", name: "from-url", type: String },
        { description: "d1-to-hyperdrive: source admin token (defaults to --token / LUNORA_ADMIN_TOKEN)", name: "from-token", type: String },
        { description: "d1-to-hyperdrive: target (Hyperdrive) worker URL (defaults to --url)", name: "to-url", type: String },
        { description: "d1-to-hyperdrive: target admin token (defaults to --token / LUNORA_ADMIN_TOKEN)", name: "to-token", type: String },
        { description: "d1-to-hyperdrive: comma-separated .global() tables to move (default: all global tables)", name: "tables", type: String },
        { description: "d1-to-hyperdrive: keep the intermediate NDJSON dump at this path", name: "out", type: String },
    ],
};

export { migrateCommand };

export type MigrateOptions = CreateOptions<{
    "batch-size": number | undefined;
    "dry-run": boolean | undefined;
    "from-token": string | undefined;
    "from-url": string | undefined;
    name: string | undefined;
    out: string | undefined;
    prod: boolean | undefined;
    steps: number | undefined;
    table: string | undefined;
    tables: string | undefined;
    "to-token": string | undefined;
    "to-url": string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
