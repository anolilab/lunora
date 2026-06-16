import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const migrateCommand: Command = {
    argument: { description: "generate | create | up | down | status [name|id]", name: "subcommand", type: String },
    description: "Schema (generate) and online data (create | up | down | status) migrations",
    examples: [
        ["lunora migrate generate", "Diff lunora/schema.ts and emit a SQL migration"],
        ["lunora migrate create add_users_email", "Scaffold a data migration"],
        ["lunora migrate up backfill-names", "Run a data migration across shards"],
        ["lunora migrate status backfill-names", "Report a migration's per-shard status"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "migrate",
    options: [
        { description: "Migration name slug (e.g. add_users_email)", name: "name", type: String },
        { description: "Target table for `create`", name: "table", type: String },
        { description: "Preview a data migration without rewriting rows", name: "dry-run", type: Boolean },
        { description: "Rows per batch for a data migration", name: "batch-size", type: Number },
        { description: "Cap batches processed this run (maps to the runner's maxBatches)", name: "steps", type: Number },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        { description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)", name: "token", type: String },
        { description: "Required with --prod for up/down — confirms running against production", name: "yes", type: Boolean },
    ],
};

export { migrateCommand };

export type MigrateOptions = CreateOptions<{
    "batch-size": number | undefined;
    "dry-run": boolean | undefined;
    name: string | undefined;
    prod: boolean | undefined;
    steps: number | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
