import { readLiveDevServerState } from "@lunora/config";

import type { Logger } from "./logger";

/** Hosts we treat as local — the admin bearer may transit cleartext to these. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

const TRAILING_SLASH = /\/$/u;

/** Wrangler's port — the last-resort default when nothing else says where the worker is. */
const WRANGLER_DEV_URL = "http://localhost:8787";

/**
 * Where an admin command should send its request when the user passed no
 * `--url`.
 *
 * The historical default was wrangler's `localhost:8787`, which is wrong for
 * every Vite-based project: those listen on 5173 and *bump to the next free
 * port* when it is taken, so the right port is not knowable in advance. The
 * running dev server already records its resolved URL in `.lunora/dev.json`
 * (the same record `lunora status`/`stop` and the MCP server read, and the same
 * one that makes a second `lunora dev` idempotent), so read it instead of
 * guessing — a live record beats a hardcoded port every time.
 *
 * The record is only consulted when it is LIVE: `readLiveDevServerState` drops
 * it when the recorded pid is gone, so a `kill -9`'d server cannot redirect a
 * later command at a port something else now owns.
 */
const resolveDefaultAdminUrl = (cwd: string | undefined): string => {
    if (cwd === undefined) {
        return WRANGLER_DEV_URL;
    }

    return readLiveDevServerState(cwd)?.url ?? WRANGLER_DEV_URL;
};

/**
 * Normalize a `--url` value to a base URL and refuse to send the full-access
 * admin bearer in cleartext to a non-loopback host (a network MITM would gain
 * full admin access). Returns `undefined` (after logging) when the URL is
 * unusable so the caller can exit non-zero.
 *
 * With no `--url`, falls back to the running dev server's recorded URL (see
 * {@link resolveDefaultAdminUrl}) and only then to wrangler's default port.
 */
const resolveAdminBaseUrl = (rawUrl: string | undefined, logger: Logger, cwd?: string): string | undefined => {
    const candidate = rawUrl ?? resolveDefaultAdminUrl(cwd);

    let parsed: URL;

    try {
        parsed = new URL(candidate);
    } catch {
        logger.error(`invalid --url: ${candidate}`);

        return undefined;
    }

    if (!LOOPBACK_HOSTS.has(parsed.hostname) && parsed.protocol !== "https:") {
        logger.error(`refusing to send the admin bearer over ${parsed.protocol}// to ${parsed.hostname} — use https for non-localhost targets`);

        return undefined;
    }

    return candidate.replace(TRAILING_SLASH, "");
};

export { resolveDefaultAdminUrl, WRANGLER_DEV_URL };
export default resolveAdminBaseUrl;
