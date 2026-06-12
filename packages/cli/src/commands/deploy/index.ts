import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";

const deployCommand: Command = {
    description: "Codegen, validate wrangler, then wrangler deploy",
    examples: [
        ["cirrus deploy", "Deploy to Cloudflare"],
        ["cirrus deploy --env production", "Deploy to a named environment"],
        ["cirrus deploy --migrate", "Deploy, then run pending data migrations"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "deploy",
    options: [
        { description: "Override the schema-drift gate (deploy even with breaking schema drift and no migration)", name: "allow-schema-drift", type: Boolean },
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Cloudflare environment name", name: "env", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "After a successful deploy, run pending data migrations against the live worker", name: "migrate", type: Boolean },
        { description: "Admin bearer token for --migrate (falls back to CIRRUS_ADMIN_TOKEN)", name: "migrate-token", type: String },
        { description: "Worker URL for --migrate (defaults to the deploy target)", name: "migrate-url", type: String },
        {
            description: "Re-bless the committed schema baseline (cirrus/.cirrus-schema.json) with the current shape",
            name: "update-schema-baseline",
            type: Boolean,
        },
    ],
};

export { deployCommand };

export type DeployOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    env: string | undefined;
    format: string | undefined;
    migrate: boolean | undefined;
    "migrate-token": string | undefined;
    "migrate-url": string | undefined;
    "update-schema-baseline": boolean | undefined;
}>;
