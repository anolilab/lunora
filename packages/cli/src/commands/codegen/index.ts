import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

const codegenCommand: Command = {
    description: "Run codegen for lunora/ functions and schema",
    examples: [["lunora codegen", "Generate lunora/_generated/ from your schema + functions"]],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "codegen",
    options: [
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        // Both the positive AND the `no-*` form are declared explicitly (#285).
        // Declaring only `no-strict-advisories` and relying on cerebro to
        // synthesize `--strict-advisories` has two problems: (1) the synthesized
        // option clones this option's `description` verbatim instead of
        // inverting it, so `--help` showed the SAME "Don't fail…" text under
        // both flags with no way to tell what the positive form does; (2) the
        // synthesized option's `defaultValue` is unconditionally `true`, so
        // `options.strictAdvisories` was NEVER `undefined` — it was `true` on
        // every invocation that didn't pass `--no-strict-advisories`, silently
        // overriding `resolveStrictAdvisories`'s CI-vs-local `??` fallback and
        // making the gate strict locally despite `--help` (and this comment,
        // before the fix) saying "off locally". Declaring BOTH forms ourselves
        // — each with its own accurate description, neither with a
        // `defaultValue` — leaves `options.strictAdvisories` genuinely
        // `undefined` until the user picks a side, which is what
        // `resolveStrictAdvisories`'s fallback needs to ever run.
        {
            description: "Fail on ERROR-level advisories even locally (the gate already defaults to on in CI)",
            name: "strict-advisories",
            type: Boolean,
        },
        {
            description: "Don't fail on ERROR-level advisories (the gate defaults to on in CI, off locally)",
            name: "no-strict-advisories",
            type: Boolean,
        },
        TARGET_OPTION,
    ],
};

export { codegenCommand };

// `--no-strict-advisories` is declared as a `no-*` option; cerebro exposes it
// under the negated positive key (`strictAdvisories`) at runtime, and
// `CreateOptions` derives that camel key from the kebab one written here —
// same convention as dev's `--no-codegen` / `--no-studio` / `--no-worker`.
export type CodegenOptions = CreateOptions<{
    "api-spec": string | undefined;
    format: string | undefined;
    "strict-advisories": boolean | undefined;
    target: string | undefined;
}>;
