import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora cloudflare <tool>` — tools that only apply to an app deployed to the
 * user's own Cloudflare account (Lunora also targets Node and celld hosts, where
 * none of them mean anything). Today the one tool is `alerts`: usage alerts
 * that catch a runaway bill. Metadata only; the handler (lazy-loaded via
 * `loader`) dispatches on the first positional.
 */
const cloudflareCommand: Command = {
    argument: { description: "alerts [status | setup | test]", name: "tool", type: String },
    description: "Cloudflare-only tools: usage alerts that catch a runaway bill",
    examples: [
        ["lunora cloudflare alerts", "Show last month's usage and which products have an alert"],
        ["lunora cloudflare alerts setup --email ops@example.com --dry-run", "Show the alerts setup would create, without creating them"],
        ["lunora cloudflare alerts setup --email ops@example.com --multiplier 5 --yes", "Create or update the alerts at 5x last month"],
        [
            "lunora cloudflare alerts setup --email ops@example.com --threshold do-duration=500000 --yes",
            "Also alert on Durable Objects duration at a limit you choose",
        ],
        ["lunora cloudflare alerts test", "Show what Cloudflare has delivered to your alert destinations"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "cloudflare",
    options: [
        { description: "alerts setup: email address to notify. Repeatable", lazyMultiple: true, name: "email", type: String },
        { description: "alerts setup / test: Cloudflare webhook destination id. Repeatable", lazyMultiple: true, name: "webhook", type: String },
        { description: "alerts setup: alert at this many times last month's usage (default 3)", name: "multiplier", type: String },
        {
            description: "alerts setup: set one metric's limit yourself, in the product's unit: <metric>=<n>. Repeatable",
            lazyMultiple: true,
            name: "threshold",
            type: String,
        },
        { description: "alerts setup: accept the floor for a metric whose usage could not be read", name: "allow-floor", type: Boolean },
        { description: "alerts setup: replace an updated alert's recipients instead of adding to them", name: "replace-recipients", type: Boolean },
        { description: "alerts setup: show the plan without creating or updating anything", name: "dry-run", type: Boolean },
        { description: "alerts setup: apply the plan without asking (required when stdin is not a TTY)", name: "yes", type: Boolean },
        OUTPUT_FORMAT_OPTION,
    ],
};

export { cloudflareCommand };

export type CloudflareOptions = CreateOptions<{
    "allow-floor": boolean | undefined;
    "dry-run": boolean | undefined;
    email: string[] | undefined;
    format: string | undefined;
    multiplier: string | undefined;
    "replace-recipients": boolean | undefined;
    threshold: string[] | undefined;
    webhook: string[] | undefined;
    yes: boolean | undefined;
}>;
