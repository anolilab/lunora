import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";

const codegenCommand: Command = {
    description: "Run codegen for cirrus/ functions and schema",
    examples: [["cirrus codegen", "Generate cirrus/_generated/ from your schema + functions"]],
    group: "Develop",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "codegen",
    options: [{ description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String }],
};

export { codegenCommand };

export type CodegenOptions = CreateOptions<{ "api-spec": string | undefined }>;
