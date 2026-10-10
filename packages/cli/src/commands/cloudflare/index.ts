/* eslint-disable no-secrets/no-secrets -- the tool table quotes `<build|push|images|list|info|delete>`-style subcommand lists, not credentials. */

import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { TARGET_OPTION } from "../../util/deploy-target";
import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

/** The `lunora cloudflare` tools. */
type CloudflareToolName = "ai-gateway" | "alerts" | "containers" | "deployments" | "profile";

/** One tool of the `lunora cloudflare` group: its name, its own arguments, and what it does. */
interface CloudflareTool {
    name: CloudflareToolName;
    summary: string;
    usage: string;
}

/**
 * Every `lunora cloudflare` tool, in display order. Drives the dispatcher, the
 * listing a bare `lunora cloudflare` prints, and the docs-reference test, so a
 * tool cannot be added to one without the others.
 */
const CLOUDFLARE_TOOLS: ReadonlyArray<CloudflareTool> = [
    { name: "alerts", summary: "usage alerts that catch a runaway bill", usage: "[status | setup | test]" },
    { name: "ai-gateway", summary: "create or reuse an AI Gateway for ctx.ai and write its id into wrangler vars", usage: "" },
    {
        name: "containers",
        summary: "build and push container images, manage instances (wraps wrangler containers)",
        usage: "<build|push|images|list|info|delete> [args…]",
    },
    {
        name: "deployments",
        summary: "deployment history; roll back or promote Worker versions",
        usage: "list | inspect <version-id> | rollback [version-id] | promote <version-id>",
    },
    {
        name: "profile",
        summary: "capture an on-demand CPU or heap profile (pprof) from the live Worker or one of its Durable Objects",
        usage: "[worker]",
    },
];

/**
 * `lunora cloudflare <tool>` — tools that only apply to an app deployed to the
 * user's own Cloudflare account (Lunora also targets Node and celld hosts, where
 * none of them mean anything). Metadata only; the handler (lazy-loaded via
 * `loader`) dispatches on the first positional. cerebro renders this one help
 * page for every tool, so the option table is the union of theirs, each entry
 * tagged with the tools it applies to.
 */
const cloudflareCommand: Command = {
    argument: { description: `${CLOUDFLARE_TOOLS.map((tool) => tool.name).join(" | ")}, then the tool's own arguments`, name: "tool", type: String },
    description: "Cloudflare-only tools: usage alerts, AI Gateway, containers, deployments, profiling",
    examples: [
        ["lunora cloudflare", "List the tools"],
        ["lunora cloudflare alerts", "Show last month's usage and which products have an alert"],
        ["lunora cloudflare alerts setup --email ops@example.com --dry-run", "Show the alerts setup would create, without creating them"],
        ["lunora cloudflare alerts setup --email ops@example.com --multiplier 5 --yes", "Create or update the alerts at 5x last month"],
        [
            "lunora cloudflare alerts setup --email ops@example.com --threshold do-duration=500000 --yes",
            "Also alert on Durable Objects duration at a limit you choose",
        ],
        ["lunora cloudflare alerts test", "Show what Cloudflare has delivered to your alert destinations"],
        ["lunora cloudflare ai-gateway", "Create (or reuse) a gateway named after the worker and wire it into wrangler vars"],
        ["lunora cloudflare ai-gateway --id my-gateway --no-logs", "Use an explicit gateway id, with prompt/response log collection off"],
        ["lunora cloudflare ai-gateway --dry-run", "Print what would be created and written, without calling Cloudflare"],
        ["lunora cloudflare containers build ./containers/transcoder --tag transcoder:v1 --push", "Build an image and push it to the Cloudflare Registry"],
        ["lunora cloudflare containers images list", "List images in your Cloudflare Registry"],
        ["lunora cloudflare containers list --format json", "List container instances as JSON (also `info`, `images list`)"],
        ["lunora cloudflare containers images delete transcoder:v1", "Delete an image to free registry storage"],
        ["lunora cloudflare deployments list", "Show the 10 most recent deployments"],
        ["lunora cloudflare deployments inspect <version-id>", "View a specific Worker version"],
        ["lunora cloudflare deployments rollback --yes", "Roll back to the previous version"],
        ["lunora cloudflare deployments promote <version-id> --yes", "Send 100% of traffic to a version"],
        ["lunora cloudflare profile", "Capture a 10s CPU profile of the latest version into ./<worker>-cpu-<time>.pprof.gz"],
        ["lunora cloudflare profile --type heap --duration-ms 30000 --out heap.pprof.gz", "Capture a 30s heap (allocation) profile"],
        ["lunora cloudflare profile --namespace-id <id> --actor-id <64-hex>", "Profile one Durable Object instance"],
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
        {
            description: "alerts setup / ai-gateway: show the plan without creating, updating or writing anything",
            name: "dry-run",
            type: Boolean,
        },
        {
            description:
                "alerts setup: apply the plan without asking (required when stdin is not a TTY). deployments rollback / promote: confirm the traffic change (required)",
            name: "yes",
            type: Boolean,
        },
        { description: "ai-gateway: gateway id (default: the worker `name` from wrangler.jsonc)", name: "id", type: String },
        // Both spellings declared, the same way `dev` declares `--studio` /
        // `--no-studio`: declaring only the `no-*` name makes cerebro list the
        // positive flag with the negative description.
        { description: "ai-gateway: collect request/response logs in the gateway (default)", name: "logs", type: Boolean },
        { description: "ai-gateway: create the gateway with log collection off (prompts and responses are not stored)", name: "no-logs", type: Boolean },
        { description: "containers build: name:tag for the image (forwarded to wrangler --tag)", name: "tag", type: String },
        { description: "containers build: push the image to the Cloudflare Registry after building", name: "push", type: Boolean },
        { description: "containers / deployments / profile: Cloudflare environment name", name: "env", type: String },
        { description: "profile: capture window in ms, 1000–50000 (default 10000)", name: "duration-ms", type: String },
        { description: "profile: cpu (default) or heap", name: "type", type: String },
        { description: "profile: Worker version id to profile (default latest)", name: "version", type: String },
        { description: "profile: file to write the gzip pprof to (default <worker>-<type>-<time>.pprof.gz)", name: "out", type: String },
        { description: "profile: Durable Object namespace id (with --actor-id)", name: "namespace-id", type: String },
        { description: "profile: Durable Object instance id, 64 hex characters (with --namespace-id)", name: "actor-id", type: String },
        { description: "deployments rollback / promote: reason recorded with the change", name: "message", type: String },
        {
            ...OUTPUT_FORMAT_OPTION,
            description: "Output format: pretty (default) or json (containers: list | info | images list; deployments: list only)",
        },
        TARGET_OPTION,
    ],
};

export type { CloudflareTool, CloudflareToolName };
export { CLOUDFLARE_TOOLS, cloudflareCommand };

export type CloudflareOptions = CreateOptions<{
    "actor-id": string | undefined;
    "allow-floor": boolean | undefined;
    "dry-run": boolean | undefined;
    "duration-ms": string | undefined;
    email: string[] | undefined;
    env: string | undefined;
    format: string | undefined;
    id: string | undefined;
    logs: boolean | undefined;
    message: string | undefined;
    multiplier: string | undefined;
    "namespace-id": string | undefined;
    out: string | undefined;
    push: boolean | undefined;
    "replace-recipients": boolean | undefined;
    tag: string | undefined;
    target: string | undefined;
    threshold: string[] | undefined;
    type: string | undefined;
    version: string | undefined;
    webhook: string[] | undefined;
    yes: boolean | undefined;
}>;
