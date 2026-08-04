import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

/**
 * `lunora deployments <subcommand>` — inspect deployment history and move
 * traffic between Worker versions, wrapping `wrangler versions` / `rollback`.
 */
const deploymentsCommand: Command = {
    argument: { description: "list | inspect <version-id> | rollback [version-id] | promote <version-id>", name: "subcommand", type: String },
    description: "List deployments and roll back / promote / inspect Worker versions",
    examples: [
        ["lunora deployments list", "Show the 10 most recent deployments"],
        ["lunora deployments inspect <version-id>", "View a specific Worker version"],
        ["lunora deployments rollback --yes", "Roll back to the previous version"],
        ["lunora deployments promote <version-id> --yes", "Send 100% of traffic to a version"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "deployments",
    options: [
        { description: "Cloudflare environment name", name: "env", type: String },
        { description: "Display `list` output as JSON", name: "json", type: Boolean },
        { description: "Reason/description recorded with a rollback or promote", name: "message", type: String },
        { description: "Confirm a rollback or promote (required — these change live traffic)", name: "yes", type: Boolean },
    ],
};

export { deploymentsCommand };

export type DeploymentsOptions = CreateOptions<{
    env: string | undefined;
    json: boolean | undefined;
    message: string | undefined;
    yes: boolean | undefined;
}>;
