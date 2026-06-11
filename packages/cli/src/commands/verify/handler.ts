import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCodegen } from "@cirrus/codegen";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { validateWrangler } from "../../util/wrangler-validator";
import type { VerifyOptions } from "./index";

interface VerifyCommandOptions {
    /** Which API spec(s) codegen would emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    logger: Logger;
    /** Injectable subprocess runner for the tsc step; defaults to the real spawner. */
    spawner?: Spawner;
    /** When false, skip the TypeScript type-check step. Defaults to true. */
    typecheck?: boolean;
}

interface VerifyCommandResult {
    code: number;
    errors: ReadonlyArray<string>;
    warnings: ReadonlyArray<string>;
    wranglerPath: string | undefined;
}

/**
 * Run `tsc --noEmit` for the project when it ships a `tsconfig.json`. Returns an
 * `{ error }` when type-checking failed, `{ warning }` when it was skipped (no
 * tsconfig), or an empty object on success.
 */
const runTypecheckStep = async (cwd: string, spawner: Spawner): Promise<{ error?: string; warning?: string }> => {
    if (!existsSync(join(cwd, "tsconfig.json"))) {
        return { warning: "no tsconfig.json found — skipping TypeScript type-check" };
    }

    const result = await spawner({ args: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], command: "pnpm", cwd });

    return result.code === 0 ? {} : { error: `type errors: tsc --noEmit exited ${String(result.code)}` };
};

/** Log the collected errors/warnings and build the command result. */
const reportVerifyResult = (logger: Logger, errors: string[], warnings: string[], wranglerPath: string | undefined): VerifyCommandResult => {
    if (errors.length === 0 && warnings.length === 0) {
        logger.success("verify: project is valid");

        return { code: 0, errors: [], warnings: [], wranglerPath };
    }

    if (warnings.length > 0) {
        logger.warn("verify: warnings:");

        for (const warning of warnings) {
            logger.warn(`  - ${warning}`);
        }
    }

    if (errors.length > 0) {
        logger.error("verify: errors:");

        for (const error of errors) {
            logger.error(`  - ${error}`);
        }

        return { code: 1, errors, warnings, wranglerPath };
    }

    logger.success("verify: project is valid (with warnings)");

    return { code: 0, errors: [], warnings, wranglerPath };
};

/**
 * Validate a Cirrus project without mutating any file. First the wrangler
 * config (bindings, compat date, schema-driven D1/Vectorize), then a codegen
 * dry-run that surfaces schema/function parse errors without touching
 * `cirrus/_generated/`, then a TypeScript type-check (`tsc --noEmit`) when the
 * project ships a `tsconfig.json`. Exits non-zero if any step reports an error.
 */
const runVerifyCommand = async (options: VerifyCommandOptions): Promise<VerifyCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    const validation = validateWrangler({ projectRoot: cwd });
    const errors: string[] = [...validation.report.errors];
    const warnings: string[] = [...validation.report.warnings];

    try {
        runCodegen({ apiSpec: options.apiSpec, dryRun: true, projectRoot: cwd });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        errors.push(`codegen failed: ${message}`);
    }

    if (options.typecheck !== false) {
        const typecheck = await runTypecheckStep(cwd, options.spawner ?? defaultSpawner);

        if (typecheck.error !== undefined) {
            errors.push(typecheck.error);
        }

        if (typecheck.warning !== undefined) {
            warnings.push(typecheck.warning);
        }
    }

    return reportVerifyResult(options.logger, errors, warnings, validation.wranglerPath);
};

/** `cirrus verify` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<VerifyOptions> = defineHandler<VerifyOptions>(({ cwd, logger, options }) =>
    runVerifyCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        logger,
        // `--no-typecheck` is declared as a `no-*` option but cerebro exposes it
        // under the negated `typecheck` key (false when passed, true when absent).
        typecheck: options.typecheck === false ? false : undefined,
    }),
);

export { execute };
export type { VerifyCommandOptions, VerifyCommandResult };
export { runVerifyCommand };
