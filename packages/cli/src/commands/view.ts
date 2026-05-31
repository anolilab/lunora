import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import type { Logger } from "../util/logger.js";
import { openUrl, type OpenUrlOptions } from "../util/open-url.js";

export interface ViewCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Inject the opener so tests don't spawn a browser. */
    opener?: OpenUrlOptions["opener"];
    /** Open the deployed worker URL instead of the local dev dashboard. */
    remote?: boolean;
}

export interface ViewCommandResult {
    code: number;
    url: string | undefined;
}

const DEFAULT_DEV_PORT = 8787;
const DASHBOARD_PATH = "/_cirrus/dashboard";

const findWranglerFile = (projectRoot: string): string | undefined => {
    for (const candidate of ["wrangler.jsonc", "wrangler.json"]) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

const readWrangler = (projectRoot: string): Record<string, unknown> | undefined => {
    const file = findWranglerFile(projectRoot);

    if (!file) {
        return undefined;
    }

    try {
        const parsed = parseJsonc(readFileSync(file, "utf8"));

        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

const resolveDevPort = (wrangler: Record<string, unknown> | undefined): number => {
    if (!wrangler) {
        return DEFAULT_DEV_PORT;
    }

    const { dev } = wrangler;

    if (dev !== null && typeof dev === "object") {
        const { port } = (dev as Record<string, unknown>);

        if (typeof port === "number" && Number.isFinite(port)) {
            return port;
        }
    }

    return DEFAULT_DEV_PORT;
};

const resolveRemoteUrl = (wrangler: Record<string, unknown> | undefined): string | undefined => {
    if (!wrangler) {
        return undefined;
    }

    // Prefer the first declared `routes[].pattern` if present.
    const { routes } = wrangler;

    if (Array.isArray(routes) && routes.length > 0) {
        const first = routes[0];

        if (typeof first === "string") {
            return `https://${first.split("/")[0] ?? first}${DASHBOARD_PATH}`;
        }

        if (first !== null && typeof first === "object") {
            const { pattern } = (first as Record<string, unknown>);

            if (typeof pattern === "string" && pattern.length > 0) {
                return `https://${pattern.split("/")[0] ?? pattern}${DASHBOARD_PATH}`;
            }
        }
    }

    // Otherwise fall back to the implicit workers.dev subdomain (best effort).
    const { name } = wrangler;

    if (typeof name === "string" && name.length > 0) {
        return `https://${name}.workers.dev${DASHBOARD_PATH}`;
    }

    return undefined;
};

export const runViewCommand = async (options: ViewCommandOptions): Promise<ViewCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const wrangler = readWrangler(cwd);
    const { logger } = options;

    let url: string | undefined;

    if (options.remote) {
        url = resolveRemoteUrl(wrangler);

        if (!url) {
            logger.error("view --remote: could not determine the remote URL from wrangler config (set `routes` or `name`).");

            return { code: 1, url: undefined };
        }
    } else {
        url = `http://localhost:${resolveDevPort(wrangler)}${DASHBOARD_PATH}`;
    }

    logger.info(`opening ${url}`);

    try {
        await openUrl(url, { opener: options.opener });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        logger.error(`view: failed to open URL: ${message}`);

        return { code: 1, url };
    }

    return { code: 0, url };
};
