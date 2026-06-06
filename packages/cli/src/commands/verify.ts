import { runCodegen } from "@cirrus/codegen";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../util/logger.js";
import type { Spawner } from "../util/spawn.js";
import { defaultSpawner } from "../util/spawn.js";
import { validateWrangler } from "../util/wrangler-validator.js";

export interface VerifyCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Injectable subprocess runner for the tsc step; defaults to the real spawner. */
    spawner?: Spawner;
    /** When false, skip the TypeScript type-check step. Defaults to true. */
    typecheck?: boolean;
}

export interface VerifyCommandResult {
    code: number;
    errors: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
    wranglerPath: string | undefined;
}

/**
 * Validate a Cirrus project without mutating any file. First the wrangler
 * config (bindings, compat date, schema-driven D1/Vectorize), then a codegen
 * dry-run that surfaces schema/function parse errors without touching
 * `cirrus/_generated/`, then a TypeScript type-check (`tsc --noEmit`) when the
 * project ships a `tsconfig.json`. Exits non-zero if any step reports an error.
 */
export const runVerifyCommand = async (options: VerifyCommandOptions): Promise<VerifyCommandResult> => {
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

    if (options.typecheck !== false) {
        if (existsSync(join(cwd, "tsconfig.json"))) {
            const spawner = options.spawner ?? defaultSpawner;

            const result = await spawner({
                args: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
                command: "pnpm",
                cwd,
            });

            if (result.code !== 0) {
                errors.push(`type errors: tsc --noEmit exited ${String(result.code)}`);
            }
        } else {
            warnings.push("no tsconfig.json found — skipping TypeScript type-check");
        }
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
