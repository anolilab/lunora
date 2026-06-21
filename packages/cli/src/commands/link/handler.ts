import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { LinkedProject } from "@lunora/config";
import { LINKED_PROJECT_FILE, writeLinkedProject } from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import readWranglerName from "../../util/wrangler-name";
import type { LinkOptions } from "./index";

interface LinkCommandOptions {
    cwd?: string;
    /** Cloudflare environment name to record. */
    env?: string;
    logger: Logger;
    /** Worker name; defaults to the `name` in wrangler config. */
    name?: string;
    /** Stamp written as `linkedAt`; injected in tests for determinism. */
    now?: () => string;
    /** Remove the existing link instead of writing one. */
    remove?: boolean;
    /** Deployed Worker URL. */
    url?: string;
}

interface LinkCommandResult {
    code: number;
    /** The link record written (absent on `--remove` or on failure). */
    link?: LinkedProject;
}

/** Validate that a string parses as an absolute http(s) URL. */
const isValidWorkerUrl = (value: string): boolean => {
    try {
        const { protocol } = new URL(value);

        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
};

const runLinkRemove = (cwd: string, logger: Logger): LinkCommandResult => {
    const path = join(cwd, LINKED_PROJECT_FILE);

    if (!existsSync(path)) {
        logger.warn(`link: no ${LINKED_PROJECT_FILE} to remove`);

        return { code: 0 };
    }

    rmSync(path);
    logger.success(`link: removed ${LINKED_PROJECT_FILE}`);

    return { code: 0 };
};

const runLinkCommand = (options: LinkCommandOptions): LinkCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const { logger } = options;

    if (options.remove) {
        return runLinkRemove(cwd, logger);
    }

    if (options.url === undefined || options.url === "") {
        logger.error("link requires a deployed Worker URL. Usage: lunora link --url <https://your-worker>");

        return { code: 1 };
    }

    if (!isValidWorkerUrl(options.url)) {
        logger.error(`link: invalid --url "${options.url}" — expected an http(s) URL`);

        return { code: 1 };
    }

    const now = options.now ?? (() => new Date().toISOString());

    const link: LinkedProject = {
        env: options.env,
        linkedAt: now(),
        workerName: options.name ?? readWranglerName(cwd),
        workerUrl: options.url,
    };

    const path = writeLinkedProject(cwd, link);

    logger.success(`link: ${link.workerName ?? "(unnamed worker)"} -> ${options.url}`);
    logger.info(`link: wrote ${path}`);

    if (link.env !== undefined) {
        logger.info(`link: environment "${link.env}"`);
    }

    return { code: 0, link };
};

/** `lunora link` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<LinkOptions> = defineHandler<LinkOptions>(({ cwd, logger, options }) =>
    runLinkCommand({
        cwd,
        env: options.env,
        logger,
        name: options.name,
        remove: options.remove === true,
        url: options.url,
    }),
);

export { execute };
export type { LinkCommandOptions, LinkCommandResult };
export { runLinkCommand };
