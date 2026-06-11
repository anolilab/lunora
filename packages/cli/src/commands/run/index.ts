import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `cirrus run &lt;functionPath>` — send a single RPC to a running Cirrus worker.
 * Metadata only; the handler (lazy-loaded via `loader`) holds the logic.
 */
const runCommand: Command = {
    argument: { description: "Function path (e.g. messages:send)", name: "functionPath", type: String },
    description: "Send a single RPC to a running Cirrus Worker",
    examples: [
        ['cirrus run messages:send --args \'{"text":"hi"}\'', "Call a function with JSON args"],
        ["cirrus run messages:list --shard channel:demo", "Target a specific shard"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "run",
    options: [
        { description: "JSON-encoded args object", name: "args", type: String },
        { description: "Explicit shard key", name: "shard", type: String },
        { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
    ],
};

export { runCommand };

export type RunRpcOptions = CreateOptions<{
    args: string | undefined;
    shard: string | undefined;
    url: string | undefined;
}>;
