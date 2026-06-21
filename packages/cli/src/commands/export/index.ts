import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const exportCommand: Command = {
    argument: { description: "Optional path (alias for --out)", name: "path", type: String },
    description: "Stream NDJSON of every shard-local + global table from the worker",
    examples: [
        ["lunora export --out backup.ndjson", "Dump every table to an NDJSON file"],
        ["lunora export --tables messages,users", "Export only specific tables"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "export",
    options: [
        { description: "Output file path (`-` for stdout, default)", name: "out", type: String },
        { description: "Comma-separated table allowlist", name: "tables", type: String },
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer token (prefer LUNORA_ADMIN_TOKEN; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
    ],
};

export { exportCommand };

export type ExportOptions = CreateOptions<{
    out: string | undefined;
    prod: boolean | undefined;
    tables: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
