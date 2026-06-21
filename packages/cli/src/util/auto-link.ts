/**
 * Auto-link a checkout to its deployed Worker by parsing the URL out of
 * `wrangler deploy` output and writing `.lunora/project.json` — the zero-effort
 * equivalent of running `lunora link` after the first deploy.
 *
 * It only writes when the checkout is NOT already linked, so it never clobbers
 * an explicit `lunora link`, and subsequent deploys keep wrangler's full TTY
 * output (the caller only captures stdout for the first, unlinked deploy).
 */
import { readLinkedProject, writeLinkedProject } from "@lunora/config";

import type { Logger } from "./logger";
import readWranglerName from "./wrangler-name";

/** A `*.workers.dev` URL — the default deployed origin wrangler prints. */
const WORKERS_DEV_URL = /https?:\/\/[^\s"'<>]+\.workers\.dev[^\s"'<>]*/u;
/** Fallback: any https URL (custom domain / route). */
const ANY_HTTPS_URL = /https:\/\/[^\s"'<>]+/u;

/**
 * Extract the deployed Worker URL from `wrangler deploy` output: prefer a
 * `*.workers.dev` origin, else the first https URL. Returns `undefined` when no
 * URL is present.
 */
const parseDeployedUrl = (output: string): string | undefined => {
    const workersDev = WORKERS_DEV_URL.exec(output);

    if (workersDev) {
        return workersDev[0];
    }

    return ANY_HTTPS_URL.exec(output)?.[0];
};

interface AutoLinkInputs {
    cwd: string;
    /** Cloudflare environment the deploy targeted, recorded alongside the link. */
    env?: string;
    logger: Logger;
    /** Stamp written as `linkedAt`; injected in tests. */
    now?: () => string;
    /** Captured `wrangler deploy` stdout, or `undefined` when not captured. */
    output: string | undefined;
}

/**
 * Write `.lunora/project.json` from a successful deploy's output, unless the
 * checkout is already linked. Best-effort — never throws (a cosmetic
 * convenience must not affect the deploy's exit code).
 */
const autoLinkFromDeployOutput = ({ cwd, env, logger, now, output }: AutoLinkInputs): void => {
    if (output === undefined || readLinkedProject(cwd) !== undefined) {
        return;
    }

    const url = parseDeployedUrl(output);

    if (url === undefined) {
        return;
    }

    try {
        const stamp = (now ?? (() => new Date().toISOString()))();

        writeLinkedProject(cwd, { env, linkedAt: stamp, workerName: readWranglerName(cwd), workerUrl: url });
        logger.success(`link: recorded ${url} in .lunora/project.json (run \`lunora link\` to change)`);
    } catch {
        // Best-effort: a link write failure must never fail the deploy.
    }
};

export type { AutoLinkInputs };
export { autoLinkFromDeployOutput, parseDeployedUrl };
