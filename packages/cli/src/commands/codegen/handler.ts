import type { Finding } from "@lunora/codegen";
import { runCodegen } from "@lunora/codegen";
import { collectWranglerSecretVariables } from "@lunora/config/cloudflare";

import { evaluateAdvisoryGate, resolveStrictAdvisories } from "../../util/advisory-gate";
import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import reportPlatformDiagnostics from "../../util/platform-diagnostics";
import type { CodegenOptions } from "./index";

/** Cloudflare caps a Worker at 3 Cron Triggers (distinct cron expressions). */
const CRON_TRIGGER_LIMIT = 3;

interface CodegenCommandOptions {
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    logger: Logger;

    /**
     * Fail the run when any ERROR-level advisory is reported. Defaults to CI
     * detection so a local `lunora codegen` stays advisory while a pipeline
     * gates on it; `--no-strict-advisories` forces it off either way.
     */
    strictAdvisories?: boolean;
    /** Deploy target the emitted `ctx.*` surface is tailored to. Resolved by the caller; falls back to `"target"` in `lunora.json`, then `"cloudflare"`. */
    target?: string;
}

interface CodegenCommandResult {
    advisories: ReadonlyArray<{ detail: string; level: Finding["level"]; name: string; remediation: string }>;
    cronTriggers: ReadonlyArray<string>;
    /** Set when the run failed: an invalid `--format`, an unregistered target, or an error-level platform diagnostic. */
    error?: string;
    /** ERROR-level advisories that made the run fail, when strict mode is on. */
    failedAdvisories: number;
    outputDirectory: string;
}

const runCodegenCommand = (options: CodegenCommandOptions): CodegenCommandResult => {
    const projectRoot = options.cwd ?? process.cwd();
    const json = isJsonFormat(options.format);
    // In `--format json` mode every human/progress line goes to stderr so
    // stdout carries only the serialized structured result.
    const logger = loggerForFormat(options.format, options.logger);

    const formatError = validateOutputFormat("codegen", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { advisories: [], cronTriggers: [], error: formatError, failedAdvisories: 0, outputDirectory: "" };
    }

    // CI is the default gate: a pipeline should fail on an ERROR advisory, a
    // local run should not have its workflow interrupted by one.
    const strictAdvisories = resolveStrictAdvisories(options);

    // Validated here because codegen resolves no driver of its own — an
    // unregistered name would otherwise emit the full Cloudflare surface
    // un-gated and exit 0.
    const resolvedTarget = resolveTargetOrError(projectRoot, options.target);

    if (resolvedTarget.target === undefined) {
        options.logger.error(resolvedTarget.error ?? "unknown deploy target");

        return {
            advisories: [],
            cronTriggers: [],
            error: resolvedTarget.error ?? "unknown deploy target",
            failedAdvisories: 0,
            outputDirectory: "",
        };
    }

    const { target } = resolvedTarget;

    const result = runCodegen({
        apiSpec: options.apiSpec,
        projectRoot,
        target,
        wranglerVariables: collectWranglerSecretVariables(projectRoot),
    });
    const commandResult: CodegenCommandResult = {
        advisories: result.advisories.map((advisory) => {
            return {
                detail: advisory.detail,
                level: advisory.level,
                name: advisory.name,
                remediation: advisory.remediation,
            };
        }),
        cronTriggers: result.cronTriggers,
        failedAdvisories: 0,
        outputDirectory: result.outputDirectory,
    };

    logger.success(`codegen wrote dataModel.ts, api.ts, server.ts to ${result.outputDirectory}`);

    // Static schema advisories (unindexed FKs, …). Surface each with its
    // remediation so the warning is actionable; one grouped `warn` keeps it in
    // line with the cron-trigger warning below.
    if (result.advisories.length > 0) {
        const count = result.advisories.length;
        const lines = result.advisories.map((advisory) => `  [${advisory.level}] ${advisory.name} — ${advisory.detail}\n      ↳ ${advisory.remediation}`);

        logger.warn(`${count.toString()} schema ${count === 1 ? "advisory" : "advisories"}:\n${lines.join("\n")}`);
    }

    const platformError = reportPlatformDiagnostics(result.platformDiagnostics, logger);

    if (platformError !== undefined) {
        commandResult.error = platformError;
    }

    // An ERROR advisory says something is broken, not merely untidy — the one
    // that prompted this read "the call throws at runtime". Exiting 0 on those
    // meant three workflows could deploy and fail on first use with a green
    // build. WARN and INFO stay non-blocking.
    const { errorAdvisories, names, shouldBlock } = evaluateAdvisoryGate(commandResult.advisories, strictAdvisories);

    if (shouldBlock) {
        logger.error(
            `${errorAdvisories.length.toString()} ERROR-level ${errorAdvisories.length === 1 ? "advisory" : "advisories"} (${names.join(", ")}). ` +
                `Codegen wrote its output; this exit code is the gate. Pass --no-strict-advisories to downgrade it to a warning.`,
        );
    }

    // Distinct cron expressions map 1:1 to wrangler `triggers.crons`; Cloudflare
    // caps a Worker at CRON_TRIGGER_LIMIT of them. Jobs sharing an expression
    // count once, so this fires only on genuinely distinct over-scheduling.
    if (result.cronTriggers.length > CRON_TRIGGER_LIMIT) {
        logger.warn(
            `${result.cronTriggers.length.toString()} distinct cron expressions declared — Cloudflare allows at most ${CRON_TRIGGER_LIMIT.toString()} Cron Triggers per Worker. ` +
                `Consolidate schedules (jobs can share one expression) or move finer-grained work to Durable Object alarms via @lunora/scheduler (runAfter/runAt).`,
        );
    }

    const finalResult: CodegenCommandResult = { ...commandResult, failedAdvisories: strictAdvisories ? errorAdvisories.length : 0 };

    if (json) {
        printJson(finalResult);
    }

    return finalResult;
};

/** `lunora codegen` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CodegenOptions> = defineHandler<CodegenOptions>(({ cwd, logger, options }) => {
    const result = runCodegenCommand({
        apiSpec: parseApiSpec(options.apiSpec),
        cwd,
        format: options.format,
        logger,
        strictAdvisories: options.strictAdvisories,
        target: options.target,
    });

    return { code: result.error === undefined && result.failedAdvisories === 0 ? 0 : 1 };
});

export { execute, runCodegenCommand };
export type { CodegenCommandOptions, CodegenCommandResult };
