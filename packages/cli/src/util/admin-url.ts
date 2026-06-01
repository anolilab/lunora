import type { Logger } from "./logger.js";

/** Hosts we treat as local — the admin bearer may transit cleartext to these. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

const TRAILING_SLASH = /\/$/u;

/**
 * Normalize a `--url` value to a base URL and refuse to send the full-access
 * admin bearer in cleartext to a non-loopback host (a network MITM would gain
 * full admin access). Returns `undefined` (after logging) when the URL is
 * unusable so the caller can exit non-zero.
 */
const resolveAdminBaseUrl = (rawUrl: string | undefined, logger: Logger): string | undefined => {
    const candidate = rawUrl ?? "http://localhost:8787";

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

export default resolveAdminBaseUrl;
