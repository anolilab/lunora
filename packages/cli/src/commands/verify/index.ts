import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";
import { OUTPUT_FORMAT_OPTION } from "../../util/output-format";

const verifyCommand: Command = {
    description: "Validate wrangler.jsonc + codegen dry-run + tsc --noEmit (no files written)",
    examples: [
        ["lunora verify", "Validate wrangler + codegen + tsc"],
        ["lunora verify --no-typecheck", "Skip the TypeScript type-check"],
        ["lunora verify --health-url https://my-app.workers.dev", "Also probe the deployment's /_lunora/health"],
        ["lunora verify --env production", "Validate the env.production view, as `lunora deploy --env production` will"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "verify",
    options: [
        { description: "Treat breaking schema drift as a warning instead of a failure", name: "allow-schema-drift", type: Boolean },
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        // `verify` is the cheap gate people put in PR CI while `build`/`deploy`
        // run on the deploy job — so it has to validate the view the deploy
        // will. Without this it read the TOP LEVEL for an `--env`-scoped
        // project: `durable_objects` is non-inheritable, so a binding declared
        // only under `env.<name>` was never cross-checked at all.
        {
            description: "Cloudflare environment name — validate the env.<name> view of wrangler.jsonc, as `lunora deploy --env` does",
            name: "env",
            type: String,
        },
        OUTPUT_FORMAT_OPTION,
        {
            description: "Probe this deployment's /_lunora/health endpoint (off by default; keeps verify offline-safe)",
            name: "health-url",
            type: String,
        },
        // `verify` runs the same ERROR-advisory gate `codegen`/`prepare`/`deploy`
        // do, so it takes the same opt-out. Both halves declared explicitly, for
        // the reason spelled out on `--typecheck` below and in `codegen/index.ts`.
        {
            description: "Fail verification on ERROR-level codegen advisories even locally (the gate already defaults to on in CI)",
            name: "strict-advisories",
            type: Boolean,
        },
        {
            description:
                "Don't fail verification on ERROR-level codegen advisories (the gate defaults to on in CI, off locally). Never downgrades platform diagnostics.",
            name: "no-strict-advisories",
            type: Boolean,
        },
        // Both halves declared explicitly: a `no-*`-only declaration makes cerebro
        // synthesize `--typecheck` by cloning this description verbatim, so
        // `--help` advertised the positive flag as "Skip the TypeScript type-check step".
        { description: "Run the TypeScript type-check step (default)", name: "typecheck", type: Boolean },
        { description: "Skip the TypeScript type-check step", name: "no-typecheck", type: Boolean },
        TARGET_OPTION,
    ],
};

export { verifyCommand };

// `typecheck` is declared TWICE in `options` (the positive form and `no-typecheck`,
// each with its own description); cerebro exposes both under this one positive key.
// Neither carries a `defaultValue`, so it is `undefined` until the user picks a
// side and the handler's `!== false` read treats that as "run it".
export type VerifyOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    env: string | undefined;
    format: string | undefined;
    "health-url": string | undefined;
    "strict-advisories": boolean | undefined;
    target: string | undefined;
    typecheck: boolean | undefined;
}>;
