import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora registry <add|list|view|build>` — the component-registry command.
 * Metadata only; `./handler` dispatches the subcommand. (The sibling `./index`
 * barrel stays the library entry that exports the `run*` orchestrators + types.)
 */
const registryCommand: Command = {
    argument: { description: "<add|list|view|build> [item names…]", name: "args", type: String },
    description: "Component registry: add/list/view items, or build the catalog",
    examples: [
        ["lunora registry list", "List available registry items"],
        ["lunora registry add presence", "Scaffold a registry item into lunora/"],
        ["lunora registry build --check", "Verify the committed catalog is current"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "registry",
    options: [
        { description: "add: print the plan and stop without writing", name: "dry-run", type: Boolean },
        { description: "add: preview the file changes (content diff) and write nothing", name: "diff", type: Boolean },
        { description: "add: force-overwrite existing files (take the incoming copy)", name: "overwrite", type: Boolean },
        { description: "add: skip the package.json mutation confirmation prompt", name: "yes", type: Boolean },
        { description: "Local registry root (offline; expects <name>/ subdirs)", name: "from", type: String },
        { description: "Override the remote registry source base (e.g. gh:owner/repo/registry)", name: "source", type: String },
        {
            description: "Fetch items from a git ref (branch, tag, or commit), e.g. --ref alpha. Overrides the version-derived default",
            name: "ref",
            type: String,
        },
        { description: "Permit --source values outside gh:/github:/https://", name: "allow-unsafe-source", type: Boolean },
        { description: "Emit JSON output (add plan / list)", name: "json", type: Boolean },
        { description: "build: output path for the catalog (default <root>/index.json)", name: "out", type: String },
        { description: "build: verify the index is current instead of rewriting it", name: "check", type: Boolean },
    ],
};

export { registryCommand };

export type RegistryOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    check: boolean | undefined;
    diff: boolean | undefined;
    "dry-run": boolean | undefined;
    from: string | undefined;
    json: boolean | undefined;
    out: string | undefined;
    overwrite: boolean | undefined;
    ref: string | undefined;
    source: string | undefined;
    yes: boolean | undefined;
}>;
