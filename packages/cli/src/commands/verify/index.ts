import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";

const verifyCommand: Command = {
    description: "Validate wrangler.jsonc + codegen dry-run + tsc --noEmit (no files written)",
    examples: [
        ["cirrus verify", "Validate wrangler + codegen + tsc"],
        ["cirrus verify --no-typecheck", "Skip the TypeScript type-check"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "verify",
    options: [
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Skip the TypeScript type-check step", name: "no-typecheck", type: Boolean },
    ],
};

export { verifyCommand };

// `--no-typecheck` is declared as a `no-*` option but cerebro exposes it at
// runtime under the negated `typecheck` key (false when passed, true when absent).
export type VerifyOptions = CreateOptions<{ "api-spec": string | undefined; typecheck: boolean | undefined }>;
