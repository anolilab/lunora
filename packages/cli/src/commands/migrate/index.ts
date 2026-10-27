import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

const migrateCommand: Command = {
    argument: { description: "generate | create | up | down | status | d1-to-hyperdrive | hyperdrive-to-d1 [name|id]", name: "subcommand", type: String },
    description: "Schema (generate), online data (create | up | down | status), and backend (d1-to-hyperdrive | hyperdrive-to-d1) migrations",
    examples: [
        ["lunora migrate generate", "Diff lunora/schema.ts and emit a SQL migration"],
        ["lunora migrate create add_users_email", "Scaffold a data migration"],
        ["lunora migrate up backfill-names", "Run a data migration across shards"],
        ["lunora migrate status backfill-names", "Report a migration's per-shard status"],
        ["lunora migrate status backfill-names --format json", "Same, as a single JSON document on stdout"],
        ["lunora migrate d1-to-hyperdrive --from-url https://old --to-url https://new", "Copy .global() data from D1 to Hyperdrive"],
        ["lunora migrate hyperdrive-to-d1 --from-url https://new --to-url https://old", "Roll .global() data back from Hyperdrive to D1"],
        [
            "lunora migrate hyperdrive-to-d1 --from-url https://new --to-url https://old --tables settings --replace --yes",
            "Roll back, overwriting rows D1 already holds",
        ],
    ],
    group: "Data",
    loader: () =>
        import("./dispatch").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "migrate",
    options: [
        { description: "Migration name slug (e.g. add_users_email)", name: "name", type: String },
        { description: "Target table for `create` (prompted for interactively when omitted)", name: "table", type: String },
        { description: "Preview a data migration without rewriting rows", name: "dry-run", type: Boolean },
        OUTPUT_FORMAT_OPTION,
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
        // d1-to-hyperdrive / hyperdrive-to-d1 backend migration.
        { description: "backend migration: source worker URL (defaults to --url)", name: "from-url", type: String },
        { description: "backend migration: source admin token (defaults to --token / LUNORA_ADMIN_TOKEN)", name: "from-token", type: String },
        { description: "backend migration: target worker URL (defaults to --url)", name: "to-url", type: String },
        { description: "backend migration: target admin token (defaults to --token / LUNORA_ADMIN_TOKEN)", name: "to-token", type: String },
        { description: "backend migration: comma-separated .global() tables to move (default: all global tables)", name: "tables", type: String },
        { description: "backend migration: keep the intermediate NDJSON dump at this path", name: "out", type: String },
        {
            description: "backend migration: overwrite rows that already exist in the target with the source's values (default: leave them, report conflicts)",
            name: "replace",
            type: Boolean,
        },
    ],
};

export { migrateCommand };

export type MigrateOptions = CreateOptions<{
    "batch-size": number | undefined;
    "dry-run": boolean | undefined;
    format: string | undefined;
    "from-token": string | undefined;
    "from-url": string | undefined;
    name: string | undefined;
    out: string | undefined;
    prod: boolean | undefined;
    replace: boolean | undefined;
    steps: number | undefined;
    table: string | undefined;
    tables: string | undefined;
    "to-token": string | undefined;
    "to-url": string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
