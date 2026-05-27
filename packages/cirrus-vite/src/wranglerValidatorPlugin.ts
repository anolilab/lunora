import { validateWranglerProject } from "@cirrus/config";
import type { Plugin } from "vite";

import type { ResolvedCirrusPluginOptions } from "./types.js";

const formatError = (wranglerPath: string, problems: ReadonlyArray<string>): Error => {
    const lines = [
        "[cirrus] wrangler configuration is missing bindings required by your schema.",
        `  file: ${wranglerPath}`,
        "",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "  Update your wrangler.jsonc and restart the dev server.",
    ];

    return new Error(lines.join("\n"));
};

/**
 * Vite plugin that validates the project's `wrangler.jsonc` against the
 * bindings implied by `cirrus/schema.ts`. Throws (Vite renders nicely) on
 * missing requirements during `configResolved`. Delegates the parsing /
 * validation logic to `@cirrus/config` so the rules stay in lockstep with
 * the CLI (`cirrus deploy`).
 */
export const wranglerValidatorPlugin = (options: ResolvedCirrusPluginOptions): Plugin => {
    return {
        name: "cirrus:wrangler-validator",
        configResolved() {
            const result = validateWranglerProject({
                projectRoot: options.projectRoot,
                schemaDir: options.schemaDir,
            });

            if (!result.wranglerPath) {
                throw new Error(
                    [
                        "[cirrus] wrangler.jsonc not found.",
                        `  searched in: ${options.projectRoot}`,
                        "  create a wrangler.jsonc declaring at least the SHARD durable object binding.",
                    ].join("\n"),
                );
            }

            if (result.report.warnings.length > 0) {
                for (const warning of result.report.warnings) {
                    // eslint-disable-next-line no-console
                    console.warn(`[cirrus] wrangler validator: ${warning}`);
                }
            }

            if (result.problems.length > 0) {
                throw formatError(result.wranglerPath, result.problems);
            }
        },
    };
};
