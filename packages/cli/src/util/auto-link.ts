/**
 * Auto-link a checkout to its deployed Worker by parsing the URL out of
 * `wrangler deploy` output and writing `.lunora/project.json` — the zero-effort
 * equivalent of running `lunora link` after a deploy.
 *
 * Every real deploy re-checks the link, not just the first one: a URL that
 * CHANGED (custom domain added, worker renamed, environment repointed) otherwise
 * leaves a stale link that `run` / `logs` / `insights` / `deploy --migrate` then
 * silently target. But an existing link is never silently rewritten — `lunora
 * link` is an explicit user act — so a mismatch warns and keeps the recorded
 * value, naming both URLs and the command that resolves it.
 *
 * The parser is Cloudflare-shaped (`*.workers.dev`, `wrangler deploy` stdout)
 * and lives behind the Cloudflare deploy path; it is not a target-neutral seam.
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
const parseDeployedUrl = (output: string | undefined): string | undefined => {
    if (output === undefined) {
        return undefined;
    }

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
    /** The deployed URL this run published to, or `undefined` when it couldn't be read. */
    url: string | undefined;
}

/** `--env staging` → ` (--env staging)`; the top-level config has no suffix. */
const environmentLabel = (env: string | undefined): string => (env === undefined ? "" : ` (--env ${env})`);

/**
 * Record the deployed URL in `.lunora/project.json`:
 *
 * - no link yet → write it;
 * - a link recording the same URL for the same `--env` → nothing to do;
 * - a link recording something else → WARN and keep the existing value.
 *
 * Best-effort — never throws (a convenience must not affect the deploy's exit
 * code) and never called for a dry run, a preview, or a `--temporary` deploy,
 * none of which have a durable URL worth recording.
 */
const autoLinkFromDeployOutput = ({ cwd, env, logger, now, url }: AutoLinkInputs): void => {
    if (url === undefined) {
        return;
    }

    try {
        const existing = readLinkedProject(cwd);

        if (existing !== undefined) {
            if (existing.workerUrl === url && existing.env === env) {
                return;
            }

            logger.warn(
                `link: .lunora/project.json records ${existing.workerUrl ?? "(no url)"}${environmentLabel(existing.env)}, but this deploy published ${url}${environmentLabel(env)}. ` +
                    `Keeping the recorded value — run \`lunora link --url ${url}${env === undefined ? "" : ` --env ${env}`}\` to update it.`,
            );

            return;
        }

        const stamp = (now ?? (() => new Date().toISOString()))();

        writeLinkedProject(cwd, { env, linkedAt: stamp, workerName: readWranglerName(cwd), workerUrl: url });
        logger.success(`link: recorded ${url} in .lunora/project.json (run \`lunora link\` to change)`);
    } catch {
        // Best-effort: a link write failure must never fail the deploy.
    }
};

export type { AutoLinkInputs };
export { autoLinkFromDeployOutput, parseDeployedUrl };
