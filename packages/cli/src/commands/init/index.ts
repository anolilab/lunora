import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const initCommand: Command = {
    argument: { description: "Project name", name: "name", type: String },
    description: "Scaffold a new Lunora project",
    examples: [
        ["lunora init my-app", "Scaffold with the default (vite) template"],
        ["lunora init my-app -t tanstack-start-react", "Scaffold a TanStack Start (React) app"],
        ["lunora init my-app -t tanstack-start-solid", "Scaffold a TanStack Start (Solid) app"],
        ["lunora init my-app --ref alpha", "Scaffold from the alpha branch's templates"],
        ["lunora init --here", "Add Lunora to the current project"],
        ["lunora init my-app --ci github", "Scaffold + add a GitHub Actions deploy pipeline"],
        ["lunora init my-app --ci gitlab", "Scaffold + add a GitLab CI deploy pipeline"],
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
            defaultValue: "vite-react",
            description: "Template to scaffold (vite-react | standalone | astro | nuxt | sveltekit | tanstack-start-react | tanstack-start-solid)",
            name: "template",
            type: String,
        },
        {
            description:
                "Scaffold via the create-vite overlay for a framework (react | vue | solid | svelte | vanilla) — official create-vite base + Lunora layer",
            name: "vite",
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
            description: "Fetch templates from a git ref (branch, tag, or commit), e.g. --ref alpha. Overrides the version-derived default",
            name: "ref",
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
        {
            description: "Also scaffold a CI deploy pipeline: github (.github/workflows/deploy.yml) or gitlab (.gitlab-ci.yml)",
            name: "ci",
            type: String,
        },
    ],
};

export { initCommand };

export type InitOptions = CreateOptions<{
    "allow-unsafe-source": boolean | undefined;
    ci: string | undefined;
    from: string | undefined;
    here: boolean | undefined;
    interactive: boolean | undefined;
    ref: string | undefined;
    source: string | undefined;
    template: string | undefined;
    vite: string | undefined;
    yes: boolean | undefined;
}>;
