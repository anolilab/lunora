import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const deployCommand: Command = {
    description: "Codegen, validate wrangler, then wrangler deploy",
    examples: [
        ["lunora deploy", "Deploy to Cloudflare"],
        ["lunora deploy --env production", "Deploy to a named environment"],
        ["lunora deploy --dry-run", "Validate + bundle without publishing"],
        ["lunora deploy --migrate", "Deploy, then run pending data migrations"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "deploy",
    options: [
        {
            description:
                "Override the schema-drift gate for this run (deploy even with breaking schema drift and no migration; the committed baseline is not advanced — use --update-schema-baseline to accept the new shape)",
            name: "allow-schema-drift",
            type: Boolean,
        },
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Validate, bundle, and run pre-deploy gates without publishing (wrangler deploy --dry-run)", name: "dry-run", type: Boolean },
        { description: "Cloudflare environment name", name: "env", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        {
            description:
                "After the deploy, probe the new version's health route (/_lunora/health/ready, falling back to /_lunora/health) and fail if it never answers",
            name: "health-check",
            type: Boolean,
        },
        { description: "After a successful deploy, run pending data migrations against the live worker", name: "migrate", type: Boolean },
        {
            description:
                "Skip codegen + the schema-drift gate (assumes `lunora build`/`prepare` already ran in this CI run). Wrangler still bundles the worker.",
            name: "prebuilt",
            type: Boolean,
        },
        { description: "Admin bearer token for --migrate (falls back to LUNORA_ADMIN_TOKEN)", name: "migrate-token", type: String },
        {
            description: "Worker URL for --migrate (REQUIRED with --migrate; the deploy target URL is not captured automatically)",
            name: "migrate-url",
            type: String,
        },
        { description: "Confirm running the production data migration triggered by --migrate (required with --migrate)", name: "migrate-yes", type: Boolean },
        // Both the positive AND the `no-*` form are declared explicitly, same as
        // `lunora codegen`'s identically-named flag (#285): relying on cerebro to
        // synthesize `--strict-advisories` from only the `no-*` declaration clones
        // this option's "Don't fail…" description onto the positive flag verbatim
        // (so `--help` couldn't distinguish the two), AND gives the synthesized
        // option an unconditional `defaultValue: true` — meaning
        // `options.strictAdvisories` was never `undefined` and the CI-vs-local
        // fallback in `resolveStrictAdvisories` never ran. Declaring both forms
        // ourselves, neither with a `defaultValue`, fixes both.
        {
            description: "Fail the deploy on ERROR-level codegen advisories even locally (the gate already defaults to on in CI)",
            name: "strict-advisories",
            type: Boolean,
        },
        {
            description:
                "Don't fail the deploy on ERROR-level codegen advisories (the gate defaults to on in CI, off locally). Never downgrades platform diagnostics.",
            name: "no-strict-advisories",
            type: Boolean,
        },
        {
            description: "Upload a preview version (wrangler versions upload) instead of going live — prints a preview URL; doesn't shift production traffic",
            name: "preview",
            type: Boolean,
        },
        TARGET_OPTION,
        {
            description:
                "Deploy to a temporary Cloudflare account when unauthenticated (wrangler deploy --temporary; live ~60min, then claim or it's deleted). Wrangler errors if you're already authenticated.",
            name: "temporary",
            type: Boolean,
        },
        {
            description: "Re-bless the committed schema baseline (lunora/.lunora-schema.json) with the current shape",
            name: "update-schema-baseline",
            type: Boolean,
        },
    ],
};

export { deployCommand };

export type DeployOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    "dry-run": boolean | undefined;
    env: string | undefined;
    format: string | undefined;
    "health-check": boolean | undefined;
    migrate: boolean | undefined;
    "migrate-token": string | undefined;
    "migrate-url": string | undefined;
    "migrate-yes": boolean | undefined;
    prebuilt: boolean | undefined;
    preview: boolean | undefined;
    "strict-advisories": boolean | undefined;
    target: string | undefined;
    temporary: boolean | undefined;
    "update-schema-baseline": boolean | undefined;
}>;
