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
        // Declared as a `no-*` option, like `--no-studio` / `--no-codegen` /
        // `--no-worker`: cerebro only synthesizes a negation for options
        // declared that way, so a positive `strict-advisories` would have made
        // the advertised `--no-strict-advisories` an unknown-option error —
        // i.e. following the printed advice would break the build harder.
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
