/**
 * `cirrus prepare` — CI-friendly pre-deploy preparation without booting Vite.
 * Runs codegen, reconciles `wrangler.jsonc` bindings, then validates the config.
 * Returns `code: 0` only when both codegen and validation pass.
 * Idempotent and safe to run in CI before `cirrus deploy`.
 */
import { runCodegen } from "@cirrus/codegen";
import { inferCirrusBindings, reconcileWranglerBindings } from "@cirrus/config";

import type { Logger } from "../util/logger.js";
import { validateWrangler } from "../util/wrangler-validator.js";

interface PrepareCommandOptions {
    cwd?: string;
    logger: Logger;
}

interface PrepareCommandResult {
    code: number;
    /** Set when the run aborted in an early phase (codegen / validation). */
    error?: string;
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

/**
 * Auto-provision bindings implied by the project's code into `wrangler.jsonc`.
 * Best-effort: a failure here is logged as a warning and does not abort
 * `prepare`, because the subsequent `validateWrangler` call will catch any
 * truly-missing requirement.
 */
const provisionBindings = async (cwd: string, logger: Logger): Promise<void> => {
    try {
        const inferred = await inferCirrusBindings({ projectRoot: cwd });
        const reconciled = reconcileWranglerBindings(cwd, inferred);

        if (reconciled.changed) {
            logger.success(`provisioned bindings: ${reconciled.added.join(", ")} → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }

        for (const warning of reconciled.warnings) {
            logger.warn(warning);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`binding inference skipped: ${message}`);
    }
};

/**
 * `cirrus prepare` — get the project ready for deployment without booting Vite.
 *
 * Suitable for CI pipelines: runs codegen, reconciles `wrangler.jsonc` bindings,
 * and validates the config, stopping at the first failure with a non-zero code.
 */
const runPrepareCommand = async (options: PrepareCommandOptions): Promise<PrepareCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    options.logger.info("running codegen");

    try {
        runCodegen({ projectRoot: cwd });
        options.logger.success("codegen complete");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`codegen failed: ${message}`);

        return {
            code: 1,
            error: `codegen failed: ${message}`,
            validation: { problems: [], wranglerPath: undefined },
        };
    }

    await provisionBindings(cwd, options.logger);

    const validation = validateWrangler({ projectRoot: cwd });

    if (validation.problems.length > 0) {
        options.logger.error("wrangler.jsonc validation failed:");

        for (const problem of validation.problems) {
            options.logger.error(`  - ${problem}`);
        }

        return {
            code: 1,
            error: "wrangler validation failed",
            validation,
        };
    }

    options.logger.success("project is ready to deploy");

    return { code: 0, validation };
};

export type { PrepareCommandOptions, PrepareCommandResult };
export { runPrepareCommand };
