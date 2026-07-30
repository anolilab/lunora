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
        {
            description: "Exit non-zero when any ERROR-level advisory is reported. Defaults to on in CI, off locally; --no-strict-advisories opts out.",
            name: "strict-advisories",
            type: Boolean,
        },
        TARGET_OPTION,
    ],
};

export { codegenCommand };

export type CodegenOptions = CreateOptions<{
    "api-spec": string | undefined;
    format: string | undefined;
    "strict-advisories": boolean | undefined;
    target: string | undefined;
}>;
