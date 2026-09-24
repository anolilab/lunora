import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora ai gateway` — provision the Cloudflare AI Gateway that `ctx.ai`'s
 * `<provider>/<model>` slugs route through, and point the Worker at it by
 * writing `LUNORA_AI_GATEWAY_ID` / `LUNORA_AI_GATEWAY_ACCOUNT_ID` into the
 * wrangler config's `vars`.
 */
const aiCommand: Command = {
    argument: { description: "gateway", name: "subcommand", type: String },
    description: "Provision a Cloudflare AI Gateway for ctx.ai and write its id into wrangler vars",
    examples: [
        ["lunora ai gateway", "Create (or reuse) a gateway named after the worker and wire it into wrangler vars"],
        ["lunora ai gateway --id my-gateway", "Use an explicit gateway id"],
        ["lunora ai gateway --no-logs", "Create the gateway with prompt/response log collection off"],
        ["lunora ai gateway --dry-run", "Print what would be created and written, without calling Cloudflare"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "ai",
    options: [
        { description: "Gateway id (default: the worker `name` from wrangler.jsonc)", name: "id", type: String },
        // Both spellings declared, the same way `dev` declares `--studio` /
        // `--no-studio`: declaring only the `no-*` name makes cerebro list the
        // positive flag with the negative description.
        { description: "Collect request/response logs in the gateway (default)", name: "logs", type: Boolean },
        { description: "Create the gateway with log collection off (prompts and responses are not stored)", name: "no-logs", type: Boolean },
        { description: "Print what would be created and written, without calling Cloudflare or editing files", name: "dry-run", type: Boolean },
        OUTPUT_FORMAT_OPTION,
    ],
};

export { aiCommand };

export type AiOptions = CreateOptions<{
    "dry-run": boolean | undefined;
    format: string | undefined;
    id: string | undefined;
    logs: boolean | undefined;
}>;
