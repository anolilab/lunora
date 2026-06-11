import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";

const prepareCommand: Command = {
    description: "Run codegen + binding reconcile + wrangler validation (no Vite) — for CI",
    examples: [["cirrus prepare", "Codegen + binding reconcile + validate (CI, before deploy)"]],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "prepare",
    options: [{ description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String }],
};

export { prepareCommand };

export type PrepareOptions = CreateOptions<{ "api-spec": string | undefined }>;
