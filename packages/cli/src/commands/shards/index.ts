import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora shards prune` — drop the shard registry's entries for shards that no
 * longer hold rows of their `.shardBy()` table, so export, backup, CDC sync and
 * migrations stop visiting them. Metadata only; the handler (lazy-loaded via
 * `loader`) holds the logic.
 */
const shardsCommand: Command = {
    argument: { description: "prune", name: "subcommand", type: String },
    description: "Maintain the shard registry: prune shards that no longer hold any rows of their .shardBy() table",
    examples: [
        ["lunora shards prune --dry-run", "Show which registered shards are empty, without removing anything"],
        ["lunora shards prune", "Remove the empty shards from the registry"],
        ["lunora shards prune --tables messages", "Only prune the shards listed for `messages`"],
        ["lunora shards prune --prod --url https://app.example.com", "Prune production"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "shards",
    options: [
        { description: "Comma-separated .shardBy() tables (default: all of them)", name: "tables", type: String },
        { description: "Report what would be pruned without changing the registry", name: "dry-run", type: Boolean },
        OUTPUT_FORMAT_OPTION,
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (defaults to the running dev server)", name: "url", type: String },
        { description: "Admin bearer token (or LUNORA_ADMIN_TOKEN)", name: "token", type: String },
    ],
};

export { shardsCommand };

export type ShardsOptions = CreateOptions<{
    "dry-run": boolean | undefined;
    format: string | undefined;
    prod: boolean | undefined;
    tables: string | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
