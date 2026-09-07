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
        // `build` runs the same advisory gate `deploy` does (it IS `deploy
        // --dry-run` underneath), and that gate's blocked message names this flag
        // — which `build` rejected as an unknown option, so half its own advice
        // did not work on the command that printed it. Same failure the drift
        // gate's `--allow-schema-drift` above already closed.
        //
        // Both halves are declared explicitly, like `codegen`/`deploy`/`prepare`:
        // letting cerebro synthesize the positive form from the `no-*` one clones
        // the "Don't fail…" description AND stamps `defaultValue: true`, which
        // would defeat `resolveStrictAdvisories`'s CI-vs-local fallback.
        {
            description: "Fail the build on ERROR-level codegen advisories even locally (the gate already defaults to on in CI)",
            name: "strict-advisories",
            type: Boolean,
        },
        {
            description:
                "Don't fail the build on ERROR-level codegen advisories (the gate defaults to on in CI, off locally). Never downgrades platform diagnostics.",
            name: "no-strict-advisories",
            type: Boolean,
        },
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
    // Declared as `strict-advisories` + `no-strict-advisories`; cerebro exposes
    // both under this one positive camelCase key, `undefined` until a side is
    // picked (which is what lets the CI-vs-local default apply).
    "strict-advisories": boolean | undefined;
    target: string | undefined;
}>;
