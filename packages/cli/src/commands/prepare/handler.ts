/**
 * `lunora prepare` — CI-friendly pre-deploy preparation without booting Vite.
 * Runs codegen, reconciles `wrangler.jsonc` bindings, then validates the config.
 * Returns `code: 0` only when both codegen and validation pass.
 * Idempotent and safe to run in CI before `lunora deploy`.
 */
import type { CodegenResult } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";
import { resolveDeployDriver } from "@lunora/config";

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

    /**
     * Deploy target, matching `deploy` and `logs`. Defaults to `"cloudflare"`.
     * Resolved through the same registry they use so a second driver does not
     * have to be found here separately.
     */
    target?: string;
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
 * Auto-provision the resources implied by the project's code into the deploy
 * target's configuration, through the `DeployDriver` seam.
 *
 * Best-effort: a driver folds a failed step into a warning rather than throwing,
 * because the subsequent `validateWrangler` call is the real gate on a
 * genuinely-missing requirement.
 *
 * Cloudflare is the only registered driver today, so this is behavior-identical
 * to the inline `inferLunoraBindings` + `reconcileWrangler*` sequence it
 * replaces — the driver delegates to exactly those functions.
 */
const provisionBindings = async (cwd: string, logger: Logger, cronTriggers: ReadonlyArray<string> = [], target?: string): Promise<void> => {
    const context = { crons: cronTriggers, projectRoot: cwd };
    const driver = resolveDeployDriver(target);

    // The portable summary of what the app needs — target-independent, so it
    // reads the same whichever driver is selected. Best-effort: a failed
    // inference must not stop provisioning, which reports its own warnings.
    try {
        const graph = await driver.infer(context);
        const requirements = [
            graph.shardNamespaces.length > 0 ? `${String(graph.shardNamespaces.length)} shard namespace(s)` : undefined,
            graph.queues.length > 0 ? `${String(graph.queues.length)} queue(s)` : undefined,
            graph.workflows.length > 0 ? `${String(graph.workflows.length)} workflow(s)` : undefined,
            graph.containers.length > 0 ? `${String(graph.containers.length)} container(s)` : undefined,
            graph.globalDatabase ? "global database" : undefined,
            graph.objectStorage ? "object storage" : undefined,
            graph.keyValueStore ? "key-value store" : undefined,
        ].filter((entry): entry is string => entry !== undefined);

        if (requirements.length > 0) {
            logger.info(`${driver.name} target requires: ${requirements.join(", ")}`);
        }
    } catch {
        // Inference is reporting-only here; `provision` surfaces the real problem.
    }

    const provisioned = await driver.provision(context);

    if (provisioned.changed) {
        logger.success(`provisioned: ${provisioned.added.join(", ")} → ${provisioned.configPath ?? "wrangler.jsonc"}`);
    }

    for (const warning of provisioned.warnings) {
        logger.warn(warning);
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

    await provisionBindings(cwd, options.logger, codegen.cronTriggers, options.target);

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
