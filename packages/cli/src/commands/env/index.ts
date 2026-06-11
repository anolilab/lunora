import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const envCommand: Command = {
    argument: { description: "list | get <KEY> | set <KEY> <VALUE> | unset <KEY> | push | doctor", name: "subcommand", type: String },
    description: "Manage .dev.vars and push secrets via wrangler (list | get | set | unset | push | doctor)",
    examples: [
        ["cirrus env list", "List .dev.vars keys"],
        ["cirrus env set API_KEY secret", "Set a local variable"],
        ["cirrus env push --yes", "Upload secrets to Cloudflare"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "env",
    options: [
        { description: "Target production for `push` (passes --env production to wrangler)", name: "prod", type: Boolean },
        { description: "Required for `push` — confirms uploading secrets to Cloudflare", name: "yes", type: Boolean },
    ],
};

export { envCommand };

export type EnvOptions = CreateOptions<{ prod: boolean | undefined; yes: boolean | undefined }>;
