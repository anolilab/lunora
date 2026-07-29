import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora run &lt;functionPath>` — send a single RPC to a running Lunora worker.
 * Metadata only; the handler (lazy-loaded via `loader`) holds the logic.
 */
const runCommand: Command = {
    argument: { description: "Function path (e.g. messages:send)", name: "functionPath", type: String },
    description: "Send a single RPC to a running Lunora Worker",
    examples: [
        ['lunora run messages:send --args \'{"text":"hi"}\'', "Call a function with JSON args"],
        ["lunora run messages:list --shard channel:demo", "Target a specific shard"],
        ["lunora run messages:list --as user_123", "Run as an authenticated user (needed when the app gates on identity)"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "run",
    options: [
        { description: "JSON-encoded args object", name: "args", type: String },
        {
            description: "Run as this user id — dispatches through the admin-gated `runAs` op so identity-gated apps accept the call",
            name: "as",
            type: String,
        },
        { description: 'JSON-encoded extra identity claims to forge alongside --as (e.g. \'{"org":"acme"}\')', name: "claims", type: String },
        { description: "Explicit shard key", name: "shard", type: String },
        { description: "Worker URL (defaults to the running dev server, else http://localhost:8787)", name: "url", type: String },
        {
            description: "Admin bearer for --as (prefer LUNORA_ADMIN_TOKEN or .dev.vars; --token is visible to other local processes via the process table)",
            name: "token",
            type: String,
        },
    ],
};

export { runCommand };

export type RunRpcOptions = CreateOptions<{
    args: string | undefined;
    as: string | undefined;
    claims: string | undefined;
    shard: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
