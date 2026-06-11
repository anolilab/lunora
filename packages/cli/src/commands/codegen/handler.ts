import { runCodegen } from "@cirrus/codegen";

import type { ApiSpec } from "../../util/api-spec";
import { parseApiSpec } from "../../util/api-spec";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { CodegenOptions } from "./index";

/** Cloudflare caps a Worker at 3 Cron Triggers (distinct cron expressions). */
const CRON_TRIGGER_LIMIT = 3;

interface CodegenCommandOptions {
    /** Which API spec(s) to emit. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;
    cwd?: string;
    logger: Logger;
}

const runCodegenCommand = (options: CodegenCommandOptions): { outputDirectory: string } => {
    const projectRoot = options.cwd ?? process.cwd();

    const result = runCodegen({ apiSpec: options.apiSpec, projectRoot });

    options.logger.success(`codegen wrote dataModel.ts, api.ts, server.ts to ${result.outputDirectory}`);

    // Static schema advisories (unindexed FKs, …). Surface each with its
    // remediation so the warning is actionable; one grouped `warn` keeps it in
    // line with the cron-trigger warning below.
    if (result.advisories.length > 0) {
        const count = result.advisories.length;
        const lines = result.advisories.map((advisory) => `  [${advisory.level}] ${advisory.name} — ${advisory.detail}\n      ↳ ${advisory.remediation}`);

        options.logger.warn(`${count.toString()} schema ${count === 1 ? "advisory" : "advisories"}:\n${lines.join("\n")}`);
    }

    // Distinct cron expressions map 1:1 to wrangler `triggers.crons`; Cloudflare
    // caps a Worker at CRON_TRIGGER_LIMIT of them. Jobs sharing an expression
    // count once, so this fires only on genuinely distinct over-scheduling.
    if (result.cronTriggers.length > CRON_TRIGGER_LIMIT) {
        options.logger.warn(
            `${result.cronTriggers.length.toString()} distinct cron expressions declared — Cloudflare allows at most ${CRON_TRIGGER_LIMIT.toString()} Cron Triggers per Worker. ` +
                `Consolidate schedules (jobs can share one expression) or move finer-grained work to Durable Object alarms via @cirrus/scheduler (runAfter/runAt).`,
        );
    }

    return { outputDirectory: result.outputDirectory };
};

/** `cirrus codegen` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<CodegenOptions> = defineHandler<CodegenOptions>(({ cwd, logger, options }) => {
    runCodegenCommand({ apiSpec: parseApiSpec(options.apiSpec), cwd, logger });

    return { code: 0 };
});

export { execute, runCodegenCommand };
export type { CodegenCommandOptions };
