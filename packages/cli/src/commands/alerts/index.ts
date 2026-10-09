import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora alerts [status|setup|test]` — guard a self-hosted Cloudflare account
 * against a runaway bill with usage notifications set well above last month's
 * usage. Metadata only; the handler (lazy-loaded via `loader`) holds the logic.
 */
const alertsCommand: Command = {
    argument: { description: "status (default) | setup | test", name: "subcommand", type: String },
    description: "Check and set up Cloudflare usage alerts that catch a runaway bill",
    examples: [
        ["lunora alerts", "Show last month's usage and which products have an alert"],
        ["lunora alerts setup --email ops@example.com --dry-run", "Show the alerts setup would create, without creating them"],
        ["lunora alerts setup --email ops@example.com --multiplier 5 --yes", "Create or update the alerts at 5x last month"],
        ["lunora alerts setup --email ops@example.com --threshold do-duration=500000 --yes", "Also alert on Durable Objects duration at a limit you choose"],
        ["lunora alerts test", "Show what Cloudflare has delivered to your alert destinations"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "alerts",
    options: [
        { description: "Email address to notify (setup). Repeatable", lazyMultiple: true, name: "email", type: String },
        { description: "Cloudflare webhook destination id to notify (setup, test). Repeatable", lazyMultiple: true, name: "webhook", type: String },
        { description: "Alert at this many times last month's usage (setup, default 3)", name: "multiplier", type: String },
        {
            description: "Set one metric's limit yourself, in the product's unit: <metric>=<n> (setup). Repeatable",
            lazyMultiple: true,
            name: "threshold",
            type: String,
        },
        { description: "Accept the floor for a metric whose usage could not be read (setup)", name: "allow-floor", type: Boolean },
        { description: "Replace an updated alert's recipients instead of adding to them (setup)", name: "replace-recipients", type: Boolean },
        { description: "Show the plan without creating or updating anything (setup)", name: "dry-run", type: Boolean },
        { description: "Apply the plan without asking (setup; required when stdin is not a TTY)", name: "yes", type: Boolean },
        OUTPUT_FORMAT_OPTION,
    ],
};

export { alertsCommand };

export type AlertsOptions = CreateOptions<{
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
