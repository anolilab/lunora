import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const prepareCommand: Command = {
    description: "Run codegen + binding reconcile + wrangler validation (no Vite) — for CI",
    examples: [["lunora prepare", "Codegen + binding reconcile + validate (CI, before deploy)"]],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "prepare",
    options: [
        {
            description:
                "Override the schema-drift gate for this run (proceed even with breaking schema drift and no migration; the committed baseline is not advanced)",
            name: "allow-schema-drift",
            type: Boolean,
        },
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        // Both forms declared explicitly, for the reason `lunora deploy` spells
        // out at its identical pair: letting cerebro synthesize the positive
        // flag clones the `no-*` description and gives it a `defaultValue`, so
        // `strictAdvisories` is never `undefined` and the CI-vs-local fallback
        // in `resolveStrictAdvisories` never runs.
        {
            description: "Fail on ERROR-level codegen advisories even locally (the gate already defaults to on in CI)",
            name: "strict-advisories",
            type: Boolean,
        },
        {
            description: "Don't fail on ERROR-level codegen advisories (the gate defaults to on in CI, off locally). Never downgrades platform diagnostics.",
            name: "no-strict-advisories",
            type: Boolean,
        },
        TARGET_OPTION,
        {
            description: "Re-bless the committed schema baseline (lunora/.lunora-schema.json) with the current shape",
            name: "update-schema-baseline",
            type: Boolean,
        },
    ],
};

export { prepareCommand };

export type PrepareOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    "strict-advisories": boolean | undefined;
    target: string | undefined;
    "update-schema-baseline": boolean | undefined;
}>;
