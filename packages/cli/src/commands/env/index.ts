import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

const envCommand: Command = {
    argument: { description: "list | get <KEY> | set <KEY> <VALUE> | unset <KEY> | generate [KEY] | push | diff | doctor", name: "subcommand", type: String },
    description: "Manage .dev.vars and sync secrets via wrangler (list | get | set | unset | generate | push | diff | doctor)",
    examples: [
        ["lunora env list", "List .dev.vars keys"],
        ["lunora env set API_KEY secret", "Set a local variable"],
        ["lunora env generate", "Generate strong values for the project's secrets (print KEY=value)"],
        ["lunora env generate AUTH_SECRET --set", "Generate one secret and write it to .dev.vars"],
        ["lunora env push --yes", "Upload secrets to Cloudflare"],
        ["lunora env diff", "Compare local .dev.vars keys against Cloudflare"],
    ],
    group: "Data",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "env",
    options: [
        { description: "Target this Cloudflare environment for `push`/`diff` (passes --env <name> to wrangler)", name: "env", type: String },
        { description: "Alias for --env production", name: "prod", type: Boolean },
        { description: "For `generate` — write the generated secrets into .dev.vars instead of printing them", name: "set", type: Boolean },
        {
            description:
                "Push secrets to a temporary-account deployment when unauthenticated (wrangler secret put --temporary). Errors if you're already authenticated.",
            name: "temporary",
            type: Boolean,
        },
        { description: "Required for `push` — confirms uploading secrets to Cloudflare", name: "yes", type: Boolean },
    ],
};

export { envCommand };

export type EnvOptions = CreateOptions<{
    env: string | undefined;
    prod: boolean | undefined;
    set: boolean | undefined;
    temporary: boolean | undefined;
    yes: boolean | undefined;
}>;
