import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const verifyCommand: Command = {
    description: "Validate wrangler.jsonc + codegen dry-run + tsc --noEmit (no files written)",
    examples: [
        ["lunora verify", "Validate wrangler + codegen + tsc"],
        ["lunora verify --no-typecheck", "Skip the TypeScript type-check"],
        ["lunora verify --health-url https://my-app.workers.dev", "Also probe the deployment's /_lunora/health"],
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
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        {
            description: "Probe this deployment's /_lunora/health endpoint (off by default; keeps verify offline-safe)",
            name: "health-url",
            type: String,
        },
        { description: "Skip the TypeScript type-check step", name: "no-typecheck", type: Boolean },
        TARGET_OPTION,
    ],
};

export { verifyCommand };

// `--no-typecheck` is declared as a `no-*` option but cerebro exposes it at
// runtime under the negated `typecheck` key (false when passed, true when absent).
export type VerifyOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    format: string | undefined;
    "health-url": string | undefined;
    target: string | undefined;
    typecheck: boolean | undefined;
}>;
