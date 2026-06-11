import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const resetCommand: Command = {
    description: "Clear local Miniflare state (and .cirrus-cache with --all)",
    examples: [
        ["cirrus reset", "Clear local Miniflare state"],
        ["cirrus reset --all", "Also remove .cirrus-cache"],
    ],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "reset",
    options: [
        { description: "Also remove .cirrus-cache", name: "all", type: Boolean },
        { description: "Skip the confirmation prompt (required when stdin is not a TTY)", name: "yes", type: Boolean },
    ],
};

export { resetCommand };

export type ResetOptions = CreateOptions<{ all: boolean | undefined; yes: boolean | undefined }>;
