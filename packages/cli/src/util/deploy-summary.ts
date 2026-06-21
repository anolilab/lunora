/**
 * The summary block printed after a successful `lunora deploy` — Vercel's
 * deploy ends with a tidy "Production / Inspect" panel, and this is Lunora's
 * equivalent: the worker name, its public URL (from the `.lunora/project.json`
 * link when present), and the next-step commands (Studio, logs).
 *
 * It is purely informational logging — it never fails a deploy — and is skipped
 * in `--format json` mode by the caller so it can't corrupt the JSON document.
 */
import { readLinkedProject } from "@lunora/config";

import type { Logger } from "./logger";
import readWranglerName from "./wrangler-name";

interface DeploySummaryInputs {
    cwd: string;
    /** Cloudflare environment the deploy targeted, when named. */
    env?: string;
    logger: Logger;
    /** True when `--migrate` ran data migrations as part of this deploy. */
    migrated?: boolean;
}

/**
 * Render the post-deploy summary. Best-effort: any failure reading config is
 * swallowed so a cosmetic summary never turns a successful deploy into a
 * non-zero exit.
 */
const renderDeploySummary = (inputs: DeploySummaryInputs): void => {
    const { cwd, env, logger, migrated } = inputs;

    try {
        const link = readLinkedProject(cwd);
        const workerName = link?.workerName ?? readWranglerName(cwd);

        logger.success("deploy complete");
        logger.info(`  worker:  ${workerName ?? "(see wrangler output above)"}`);

        if (env !== undefined) {
            logger.info(`  env:     ${env}`);
        }

        if (link?.workerUrl === undefined) {
            logger.info("  url:     run `lunora link --url <https://your-worker>` to record it");
        } else {
            logger.info(`  url:     ${link.workerUrl}`);
        }

        if (migrated) {
            logger.info("  migrations: applied");
        }

        logger.info("  studio:  lunora view --remote");
        logger.info("  logs:    lunora logs");
    } catch {
        // A cosmetic summary must never fail an otherwise-successful deploy.
    }
};

export type { DeploySummaryInputs };
export { renderDeploySummary };
