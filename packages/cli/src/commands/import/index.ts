import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const importCommand: Command = {
    argument: { description: "Source NDJSON file, or a `npx convex export --path <dir>` directory", name: "file", type: String },
    description: "Bulk-insert rows from an NDJSON file — or a Convex export directory — via the worker's admin endpoint",
    examples: [
        ["lunora import backup.ndjson", "Bulk-insert rows from an NDJSON file"],
        ["lunora import ./convex-export", "Import a `npx convex export --path` directory (ids are preserved, so no remapping)"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "import",
    options: [
        { description: "Wrap each bare doc as `{table:<name>,doc:...}`", name: "table", type: String },
        { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Confirm bulk-writing production (required with --prod)", name: "yes", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
    ],
};

export { importCommand };

export type ImportOptions = CreateOptions<{
    "batch-size": number | undefined;
    prod: boolean | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
    yes: boolean | undefined;
}>;
