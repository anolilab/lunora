/**
 * `lunora view` — open the Lunora studio in a browser.
 *
 * There is exactly one studio and it is served locally: the CLI's own server
 * (`util/studio-server.ts`, `http://127.0.0.1:6173`) for the wrangler flavor,
 * and `@lunora/vite`'s `/__lunora` route inside the Vite dev server for the
 * Vite flavor. The deployed worker serves no studio — its `/_lunora/*` table is
 * rpc/ws/status/migrate/admin only — so there is nothing remote to open.
 *
 * The running dev server records where its studio actually is in
 * `.lunora/dev.json`, so read that (the same source `admin-url.ts` reads for
 * the admin base URL) instead of guessing a port: the Vite flavor bumps to the
 * next free port when 5173 is taken, and no hardcoded default survives that.
 */
import { readLiveDevServerState } from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { OpenUrlOptions } from "../../util/open-url";
import { openUrl } from "../../util/open-url";

interface ViewCommandOptions {
    cwd?: string;
    logger: Logger;
    /** Inject the opener so tests don't spawn a browser. */
    opener?: OpenUrlOptions["opener"];
}

interface ViewCommandResult {
    code: number;
    url: string;
}

/** Where the CLI's embedded studio server listens (`dev`'s `DEFAULT_STUDIO_PORT`). */
const DEFAULT_STUDIO_URL = "http://127.0.0.1:6173";

/** Path `@lunora/vite`'s studio plugin mounts the studio on inside the Vite dev server. */
const VITE_STUDIO_PATH = "/__lunora";

const TRAILING_SLASH = /\/$/u;

/**
 * The studio URL for the dev server that is running right now, or the CLI
 * studio's default port when none is.
 *
 * `studioUrl` is written by the wrangler flavor once its studio server is
 * listening; the Vite flavor records only the Vite origin, whose studio is the
 * `/__lunora` route on it.
 */
const resolveStudioUrl = (cwd: string): string => {
    const state = readLiveDevServerState(cwd);

    if (state === undefined) {
        return DEFAULT_STUDIO_URL;
    }

    if (state.studioUrl !== undefined) {
        return state.studioUrl;
    }

    return state.mode === "vite" ? `${state.url.replace(TRAILING_SLASH, "")}${VITE_STUDIO_PATH}` : DEFAULT_STUDIO_URL;
};

const runViewCommand = async (options: ViewCommandOptions): Promise<ViewCommandResult> => {
    const url = resolveStudioUrl(options.cwd ?? process.cwd());
    const { logger } = options;

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

/** `lunora view` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<Record<string, never>> = defineHandler<Record<string, never>>(({ cwd, logger }) => runViewCommand({ cwd, logger }));

export { execute };
export type { ViewCommandOptions, ViewCommandResult };
export { runViewCommand };
