import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import TARGET_OPTION from "../../util/deploy-target";
import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/**
 * `lunora preview` — an isolated copy of the app per pull request: its own Worker, Durable Object namespace,
 * D1, KV and R2, and the way to remove it. Metadata only; the handler (lazy-loaded via `loader`) holds the logic.
 */
const previewCommand: Command = {
    argument: { description: "deploy <name> | list | delete <name>", name: "subcommand", type: String },
    description: "Deploy, list and delete isolated preview copies of the app (own Worker, Durable Objects, D1, KV, R2)",
    examples: [
        ["lunora preview deploy 123", "Deploy preview 123 as its own Worker with its own data, then print its URL"],
        ["lunora preview deploy 123 --seed", "Deploy, then fill the preview with `lunora seed` data"],
        ["lunora preview deploy 123 --secret RESEND_API_KEY", "Give the preview a secret, read from the environment"],
        ["lunora preview deploy 123 --var AUTH_URL=https://app-preview-123.acme.workers.dev", "Override a production var in the preview"],
        ["lunora preview deploy 123 --env production", "Plan the preview from env.production's bindings, for an app that declares them only there"],
        ["lunora preview deploy 123 --dry-run", "Show the Worker, resources and env block a deploy would use"],
        ["lunora preview list", "List the previews on record"],
        ["lunora preview delete 123 --env production", "Delete a preview made with --env production, in that environment's account"],
        ["lunora preview delete 123", "Delete the preview Worker and every resource recorded for it"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "preview",
    options: [
        {
            description: "deploy: show the plan without calling Cloudflare; delete: read the record and show what would be deleted, changing nothing",
            name: "dry-run",
            type: Boolean,
        },
        {
            description:
                "deploy: plan the preview from this Wrangler environment (the top level with env.<name> laid over it), for an app whose bindings live in env.<name>. delete, list: look in that environment's account_id; required (or CLOUDFLARE_ACCOUNT_ID) when an environment names an account other than the top level's",
            name: "env",
            type: String,
        },
        OUTPUT_FORMAT_OPTION,
        {
            description: "deploy: give the preview this secret, with the value of the same-named environment variable. Repeatable; nothing else is copied",
            lazyMultiple: true,
            name: "secret",
            type: String,
        },
        { description: "deploy: run `lunora seed` against the preview once it is live", name: "seed", type: Boolean },
        TARGET_OPTION,
        {
            description: "deploy: set a var in the preview, over production's value (e.g. an auth base URL). KEY=VALUE, repeatable",
            lazyMultiple: true,
            name: "var",
            type: String,
        },
    ],
};

export { previewCommand };

export type PreviewOptions = CreateOptions<{
    "dry-run": boolean | undefined;
    env: string | undefined;
    format: string | undefined;
    secret: string[] | undefined;
    seed: boolean | undefined;
    target: string | undefined;
    var: string[] | undefined;
}>;
