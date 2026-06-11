import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `cirrus logs [worker]` — stream live logs from a deployed Cirrus Worker
 * by wrapping `wrangler tail`.
 */
const logsCommand: Command = {
    argument: { description: "Worker name (defaults to the name in wrangler config)", name: "worker", type: String },
    description: "Stream live logs from a deployed Cirrus Worker",
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "logs",
    options: [
        { description: "Cloudflare environment name", name: "env", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "Substring filter on log messages", name: "search", type: String },
        { description: "Filter by invocation status: ok, error, or canceled", name: "status", type: String },
    ],
};

export { logsCommand };

export type LogsOptions = CreateOptions<{
    env: string | undefined;
    format: string | undefined;
    search: string | undefined;
    status: string | undefined;
}>;
