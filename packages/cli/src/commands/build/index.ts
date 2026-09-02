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
        ["lunora build --emit-bindings bindings.json", "Also write what the bundle needs provisioned, for an external deployer"],
    ],
    group: "Deploy",
    loader: () =>
        import("./handler").then((m) => {
            return { default: m.execute as CommandExecute<Toolbox> };
        }),
    name: "build",
    options: [
        {
            description:
                "Override the schema-drift gate for this run (build even with breaking schema drift and no migration; the committed baseline is not advanced)",
            name: "allow-schema-drift",
            type: Boolean,
        },
        { description: `Which API spec(s) to emit: ${API_SPEC_HELP} (default openapi)`, name: "api-spec", type: String },
        {
            description: "Write a JSON manifest of the bindings + crons the bundle needs to this path, for an IaC program to consume",
            name: "emit-bindings",
            type: String,
        },
        { description: "Output format: pretty (default) or json", name: "format", type: String },
        { description: "Directory to write the bundled Worker to (default .lunora/build)", name: "out-dir", type: String },
        TARGET_OPTION,
    ],
};

export { buildCommand };

export type BuildOptions = CreateOptions<{
    "allow-schema-drift": boolean | undefined;
    "api-spec": string | undefined;
    "emit-bindings": string | undefined;
    format: string | undefined;
    "out-dir": string | undefined;
    target: string | undefined;
}>;
