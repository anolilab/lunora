import { runCodegen } from "@cirrus/codegen";

import type { Logger } from "../util/logger.js";
import { validateWrangler } from "../util/wrangler-validator.js";

export interface VerifyCommandOptions {
    cwd?: string;
    logger: Logger;
}

export interface VerifyCommandResult {
    code: number;
    errors: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
    wranglerPath: string | undefined;
}

/**
 * Validate a Cirrus project without mutating any file:
 *   1. Wrangler config (bindings, compat date, schema-driven D1/Vectorize).
 *   2. Codegen dry-run — surfaces schema/function parse errors without
 *      touching `cirrus/_generated/`.
 * Exits non-zero if either step reports an error.
 */
export const runVerifyCommand = (options: VerifyCommandOptions): VerifyCommandResult => {
    const cwd = options.cwd ?? process.cwd();

    const validation = validateWrangler({ projectRoot: cwd });
    const errors: string[] = [...validation.report.errors];
    const warnings: string[] = [...validation.report.warnings];

    try {
        runCodegen({ dryRun: true, projectRoot: cwd });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        errors.push(`codegen failed: ${message}`);
    }

    if (errors.length === 0 && warnings.length === 0) {
        options.logger.success("verify: project is valid");

        return { code: 0, errors: [], warnings: [], wranglerPath: validation.wranglerPath };
    }

    if (warnings.length > 0) {
        options.logger.warn("verify: warnings:");

        for (const warning of warnings) {
            options.logger.warn(`  - ${warning}`);
        }
    }

    if (errors.length > 0) {
        options.logger.error("verify: errors:");

        for (const error of errors) {
            options.logger.error(`  - ${error}`);
        }

        return { code: 1, errors, warnings, wranglerPath: validation.wranglerPath };
    }

    options.logger.success("verify: project is valid (with warnings)");

    return { code: 0, errors: [], warnings, wranglerPath: validation.wranglerPath };
};
