/**
 * `lunora prepare` — CI-friendly pre-deploy preparation without booting Vite.
 * Runs codegen, reconciles `wrangler.jsonc` bindings, then validates the config.
 * Returns `code: 0` only when both codegen and validation pass.
 * Idempotent and safe to run in CI before `lunora deploy`.
 */
import type { CodegenResult } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";
import { inferLunoraBindings, reconcileWranglerBindings, reconcileWranglerCompatibilityDate, reconcileWranglerCrons } from "@lunora/config";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import { renderCodegenFailure } from "../../util/codegen-error";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { runSchemaDriftGate } from "../../util/schema-drift-gate";
import { validateWrangler } from "../../util/wrangler-validator";
import type { PrepareOptions } from "./index";

interface PrepareCommandOptions {
    /** Override the schema-drift gate — proceed even with breaking drift and no new migration. */
    allowSchemaDrift?: boolean;
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    logger: Logger;
    /** Re-bless the committed schema baseline with the current shape. */
    updateSchemaBaseline?: boolean;
}

interface PrepareCommandResult {
    code: number;
    /** Set when the run aborted in an early phase (codegen / validation / drift gate). */
    error?: string;
    /** The schema-drift gate verdict. */
    schemaDrift?: { blocked: boolean; reason: string };
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
const provisionBindings = async (cwd: string, logger: Logger, cronTriggers: ReadonlyArray<string> = []): Promise<void> => {
    try {
        const inferred = await inferLunoraBindings({ projectRoot: cwd });
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

    try {
        const reconciled = reconcileWranglerCompatibilityDate(cwd);

        if (reconciled.changed) {
            logger.success(
                `bumped compatibility_date to ${reconciled.date ?? "unknown"} (Workers Cache enabled) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`,
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`compatibility date sync skipped: ${message}`);
    }

    try {
        const reconciled = reconcileWranglerCrons(cwd, cronTriggers);

        if (reconciled.changed) {
            logger.success(`synced ${String(cronTriggers.length)} cron trigger(s) → ${reconciled.wranglerPath ?? "wrangler.jsonc"}`);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn(`cron trigger sync skipped: ${message}`);
    }
};

/**
 * `lunora prepare` — get the project ready for deployment without booting Vite.
 *
 * Suitable for CI pipelines: runs codegen, reconciles `wrangler.jsonc` bindings,
 * and validates the config, stopping at the first failure with a non-zero code.
 */
const runPrepareCommand = async (options: PrepareCommandOptions): Promise<PrepareCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    options.logger.info("running codegen");

    let codegen: CodegenResult;

    try {
        codegen = runCodegen({ apiSpec: options.apiSpec, projectRoot: cwd });
        options.logger.success("codegen complete");
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        // Render the failure plus any matched Lunora fix (same hint the Vite
        // overlay and `lunora dev` show); the returned `error` stays the plain
        // machine-readable string for `--format json` and callers.
        options.logger.error(renderCodegenFailure(error));

        return {
            code: 1,
            error: `codegen failed: ${message}`,
            validation: { problems: [], wranglerPath: undefined },
        };
    }

    // Schema-drift gate — block when breaking schema changes ship without a new
    // data migration. CI-friendly: `lunora prepare` is the canonical pre-deploy
    // step, so the gate lives here as well as in `lunora deploy`.
    const gate = runSchemaDriftGate({
        allowDrift: options.allowSchemaDrift === true,
        codegen,
        logger: options.logger,
        updateBaseline: options.updateSchemaBaseline === true,
    });

    if (gate.blocked) {
        return {
            code: 1,
            error: "schema drift gate blocked prepare",
            schemaDrift: { blocked: true, reason: gate.reason },
            validation: { problems: [], wranglerPath: undefined },
        };
    }

    await provisionBindings(cwd, options.logger, codegen.cronTriggers);

    const validation = validateWrangler({ projectRoot: cwd });

    if (validation.problems.length > 0) {
        options.logger.error("wrangler.jsonc validation failed:");

        for (const problem of validation.problems) {
            options.logger.error(`  - ${problem}`);
        }

        // Validation failed — do NOT advance the committed schema baseline, so a
        // later deploy still re-checks this drift against the pre-prepare shape.
        return {
            code: 1,
            error: "wrangler validation failed",
            validation,
        };
    }

    // Prepare fully succeeded — safe to advance the committed schema baseline.
    gate.rebless?.();

    options.logger.success("project is ready to deploy");

    return { code: 0, validation };
};

/** `lunora prepare` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<PrepareOptions> = defineHandler<PrepareOptions>(({ cwd, logger, options }) =>
    runPrepareCommand({
        allowSchemaDrift: options.allowSchemaDrift === true,
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        logger,
        updateSchemaBaseline: options.updateSchemaBaseline === true,
    }),
);

export { execute };
export type { PrepareCommandOptions, PrepareCommandResult };
export { runPrepareCommand };
