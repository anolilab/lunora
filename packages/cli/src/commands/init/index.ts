import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const initCommand: Command = {
    argument: { description: "Project name", name: "name", type: String },
    description: "Scaffold a new Lunora project",
    examples: [
        ["lunora init my-app", "Scaffold with the default (vite) template"],
        ["lunora init my-app -t tanstack-start-react", "Scaffold a TanStack Start (React) app"],
        ["lunora init my-app -t tanstack-start-solid", "Scaffold a TanStack Start (Solid) app"],
        ["lunora init --here", "Add Lunora to the current project"],
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
            description: "Template to scaffold (vite | standalone | astro | nuxt | sveltekit | tanstack-start-react | tanstack-start-solid)",
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
            description: "Add Lunora to the current project: detect the framework, patch the config, scaffold lunora/, print per-framework wiring steps",
            name: "here",
            type: Boolean,
        },
        {
            alias: "i",
            description: "After scaffolding, offer to add auth + email (defaults on when stdin is a TTY)",
            name: "interactive",
            type: Boolean,
        },
        {
            alias: "y",
            description: "Skip the auth/email offer; scaffold only",
            name: "yes",
            type: Boolean,
        },
    ],
};

export { initCommand };

export type InitOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    from: string | undefined;
    here: boolean | undefined;
    interactive: boolean | undefined;
    source: string | undefined;
    template: string | undefined;
    yes: boolean | undefined;
}>;
