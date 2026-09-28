/**
 * The wrangler-config precondition every build front-end enforces before it
 * builds: the project has a wrangler config, and that config declares the
 * bindings the schema implies.
 *
 * Lives beside {@link validateWranglerProject} rather than in a plugin because
 * `@lunora/vite` and `@lunora/rspack` enforce it identically — same
 * `LunoraError`, same warning loop, same problem list — and the only thing that
 * genuinely differs is how the reader gets un-stuck, which is the `remedy`
 * parameter. As two copies, a fix to this wording or to the warning handling had
 * to be made twice.
 */
import { LunoraError } from "@lunora/errors";

import { lunoraLine } from "../log-badge";
import { validateWranglerProject } from "./wrangler-validator";

/** The project coordinates the validator needs. */
interface AssertWranglerOptions {
    /** Absolute path to the project root holding `wrangler.jsonc`. */
    projectRoot: string;

    /** The schema directory, relative to `projectRoot` (usually `"lunora"`). */
    schemaDir: string;
}

/**
 * Throw unless `wrangler.jsonc` satisfies the schema's binding requirements.
 *
 * Non-blocking validator warnings go to `warn`. `remedy` closes both error
 * messages — the caller's own "and restart the dev server" / "and rebuild" —
 * since that is the only part a reader acts on differently per front-end.
 *
 * Must run AFTER binding provisioning: the bindings this requires are largely the
 * ones Lunora writes itself, so validating first fails the very first build of any
 * project that declares a `.global()` table or a container.
 */
const assertWranglerSatisfiesSchema = (options: AssertWranglerOptions, warn: (message: string) => void, remedy: string): void => {
    const result = validateWranglerProject({ projectRoot: options.projectRoot, schemaDir: options.schemaDir });

    if (!result.wranglerPath) {
        throw new LunoraError(
            "INTERNAL",
            [
                "[lunora] wrangler.jsonc not found.",
                `  searched in: ${options.projectRoot}`,
                "  create a wrangler.jsonc declaring at least the SHARD durable object binding.",
            ].join("\n"),
        );
    }

    for (const warning of result.report.warnings) {
        warn(lunoraLine(`wrangler validator: ${warning}`));
    }

    if (result.problems.length > 0) {
        throw new LunoraError(
            "INTERNAL",
            [
                "[lunora] wrangler configuration is missing bindings required by your schema.",
                `  file: ${result.wranglerPath}`,
                "",
                ...result.problems.map((problem) => `  - ${problem}`),
                "",
                `  ${remedy}`,
            ].join("\n"),
        );
    }
};

export type { AssertWranglerOptions };
export { assertWranglerSatisfiesSchema };
