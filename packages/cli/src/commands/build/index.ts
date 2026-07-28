import type { Command, CommandExecute, CreateOptions, Toolbox } from "@visulima/cerebro";

import { API_SPEC_HELP } from "../../util/api-spec";
import { TARGET_OPTION } from "../../util/deploy-target";

/**
 * `lunora build` — run codegen + all pre-deploy gates and emit the bundled
 * Worker to disk WITHOUT publishing (`wrangler deploy --dry-run --outdir`).
 *
 * This is the "build" half of a build/deploy split: produce a verified artifact
 * in one CI step, then ship it with `lunora deploy --prebuilt` in another.
 */
const buildCommand: Command = {
    description: "Codegen + validate + bundle the Worker to disk without deploying",
    examples: [
        ["lunora build", "Bundle to .lunora/build without deploying"],
        ["lunora build --out-dir dist-worker", "Bundle to a custom directory"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "build",
    options: [
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "Directory to write the bundled Worker to (default .lunora/build)", name: "out-dir", type: String },
        TARGET_OPTION,
    ],
};

export { buildCommand };

export type BuildOptions = CreateOptions<{
    "api-spec": string | undefined;
    format: string | undefined;
    "out-dir": string | undefined;
    target: string | undefined;
}>;
