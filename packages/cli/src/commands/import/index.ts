import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const importCommand: Command = {
    argument: { description: "Source NDJSON file", name: "file", type: String },
    description: "Bulk-insert rows from an NDJSON file via the worker's admin endpoint",
    examples: [["lunora import backup.ndjson", "Bulk-insert rows from an NDJSON file"]],
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
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        { description: "Admin bearer token (or LUNORA_ADMIN_TOKEN)", name: "token", type: String },
    ],
};

export { importCommand };

export type ImportOptions = CreateOptions<{
    "batch-size": number | undefined;
    prod: boolean | undefined;
    table: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
