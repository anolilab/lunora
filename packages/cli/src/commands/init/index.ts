import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const initCommand: Command = {
    argument: { description: "Project name", name: "name", type: String },
    description: "Scaffold a new Cirrus project",
    examples: [
        ["cirrus init my-app", "Scaffold with the default (vite) template"],
        ["cirrus init my-app -t tanstack-start", "Scaffold a TanStack Start app"],
        ["cirrus init --here", "Add Cirrus to the current project"],
    ],
    group: "Project",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "init",
    options: [
        {
            alias: "t",
            defaultValue: "vite",
            description: "Template to scaffold (vite | standalone | astro | nuxt | sveltekit | tanstack-start)",
            name: "template",
            type: String,
        },
        {
            description: "Local templates root to copy from (offline-friendly; expects <type>/ subdirs)",
            name: "from",
            type: String,
        },
        {
            description: "Override the remote template source (e.g. gh:owner/repo/sub#ref)",
            name: "source",
            type: String,
        },
        {
            description: "Permit --source values outside gh:/github:/https:// (e.g. local file://)",
            name: "allow-unsafe-source",
            type: Boolean,
        },
        {
            description: "Add Cirrus to the current project: detect the framework, patch the config, scaffold cirrus/, print per-framework wiring steps",
            name: "here",
            type: Boolean,
        },
    ],
};

export { initCommand };

export type InitOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    from: string | undefined;
    here: boolean | undefined;
    source: string | undefined;
    template: string | undefined;
}>;
