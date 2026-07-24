import { runCodegen } from "@lunora/codegen";
import { collectWranglerSecretVariables } from "@lunora/config";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
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
}

interface CodegenCommandResult {
    advisories: ReadonlyArray<{ detail: string; level: string; name: string; remediation: string }>;
    cronTriggers: ReadonlyArray<string>;
    /** Set when the run aborted on an invalid `--format` before codegen ran. */
    error?: string;
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

        return { advisories: [], cronTriggers: [], error: formatError, outputDirectory: "" };
    }

    const result = runCodegen({ apiSpec: options.apiSpec, projectRoot, wranglerVariables: collectWranglerSecretVariables(projectRoot) });
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

    // Platform-portability diagnostics: `ctx.*` features the deploy target does
    // not support (omitted from the emitted surface) or an unknown target.
    // Empty on the default Cloudflare target, so this stays silent there.
    if (result.platformDiagnostics.length > 0) {
        const count = result.platformDiagnostics.length;
        const lines = result.platformDiagnostics.map(
            (diagnostic) => `  [${diagnostic.level.toUpperCase()}] ${diagnostic.name} — ${diagnostic.message}\n      ↳ ${diagnostic.remediation}`,
        );

        logger.warn(`${count.toString()} platform ${count === 1 ? "diagnostic" : "diagnostics"}:\n${lines.join("\n")}`);
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

    if (json) {
        printJson(commandResult);
    }

    return commandResult;
};

/** `lunora codegen` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CodegenOptions> = defineHandler<CodegenOptions>(({ cwd, logger, options }) => {
    const result = runCodegenCommand({ apiSpec: parseApiSpec(options.apiSpec), cwd, format: options.format, logger });

    return { code: result.error === undefined ? 0 : 1 };
});

export { execute, runCodegenCommand };
export type { CodegenCommandOptions, CodegenCommandResult };
