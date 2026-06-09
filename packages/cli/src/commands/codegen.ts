import { runCodegen } from "@cirrus/codegen";

import type { Logger } from "../util/logger";

/** Cloudflare caps a Worker at 3 Cron Triggers (distinct cron expressions). */
const CRON_TRIGGER_LIMIT = 3;

export interface CodegenCommandOptions {
    cwd?: string;
    logger: Logger;
}

export const runCodegenCommand = (options: CodegenCommandOptions): { outputDirectory: string } => {
    const projectRoot = options.cwd ?? process.cwd();

    const result = runCodegen({ projectRoot });

    options.logger.success(`codegen wrote dataModel.ts, api.ts, server.ts to ${result.outputDirectory}`);

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
