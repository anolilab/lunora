import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora admin-token create|list|revoke` — named, revocable admin tokens.
 * Metadata only; the handler (lazy-loaded via `loader`) holds the logic.
 */
const adminTokenCommand: Command = {
    argument: { description: "create <name> | list | revoke <name>", name: "subcommand", type: String },
    description: "Manage named admin tokens: create one per CI job or teammate, list them, revoke a leaked one",
    examples: [
        ["lunora admin-token create ci-deploy --prod --url https://app.example.com", "Create a token; the secret is printed once"],
        ["lunora admin-token create nightly --expires-days 30", "Create a token that stops working after 30 days"],
        ["lunora admin-token list", "List tokens with created / last-used / expiry"],
        ["lunora admin-token revoke ci-deploy", "Revoke a token (refused everywhere within 30 seconds)"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "admin-token",
    options: [
        { description: "For `create` — days until the token expires (default: never)", name: "expires-days", type: Number },
        OUTPUT_FORMAT_OPTION,
        { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
        { description: "Worker URL (defaults to the running dev server)", name: "url", type: String },
        { description: "Root admin bearer token (or LUNORA_ADMIN_TOKEN); a named token cannot manage tokens", name: "token", type: String },
    ],
};

export { adminTokenCommand };

export type AdminTokenOptions = CreateOptions<{
    "expires-days": number | undefined;
    format: string | undefined;
    prod: boolean | undefined;
    token: string | undefined;
    url: string | undefined;
}>;
