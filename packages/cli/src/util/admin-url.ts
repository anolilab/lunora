import { readLiveDevServerState } from "@lunora/config";
import { LunoraError } from "@lunora/errors";

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
 * (the same record `lunora dev status`/`lunora dev stop` and the MCP server read, and the same
 * one that makes a second `lunora dev` idempotent), so read it instead of
 * guessing — a live record beats a hardcoded port every time.
 *
 * The record is only consulted when it is LIVE: `readLiveDevServerState` drops
 * it when the recorded pid is gone. That check is liveness-only on macOS —
 * only Linux additionally compares the process start time — so a recycled pid
 * can still make a dead record look current there. Local-only, and the worst
 * case is a confusing connection error rather than a leaked secret, since the
 * `.dev.vars` fallback is gated on the resolved target being loopback.
 */
const resolveDefaultAdminUrl = (cwd: string | undefined): string => {
    if (cwd === undefined) {
        return WRANGLER_DEV_URL;
    }

    return readLiveDevServerState(cwd)?.url ?? WRANGLER_DEV_URL;
};

/**
 * The base-URL normalization every admin command shares: drop the trailing
 * slash so `https://worker/` and `https://worker` name one target. Exported
 * because callers that COMPARE two `--url` values (the `d1-to-hyperdrive`
 * self-migration guard) have to use the same rule the request path uses, or the
 * guard and the work disagree.
 */
const normalizeAdminBaseUrl = (url: string): string => url.replace(TRAILING_SLASH, "");

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

    return normalizeAdminBaseUrl(candidate);
};

/**
 * `globalThis.fetch` for the admin commands, with a refused or dropped
 * connection named. Node reports those as a bare "fetch failed" `TypeError` and
 * keeps the real reason (`ECONNREFUSED …`) on `cause`, so a stopped dev server
 * otherwise surfaces as a message that says neither where nor why. Anything else
 * (an abort, a timeout) is rethrown as it is.
 *
 * `init` is the narrow shape every admin command sends, so the one widening to
 * `RequestInit` lives here: a `Uint8Array` body is `BodyInit` at runtime but not
 * to TypeScript.
 */
const adminFetch = async (input: string, init?: { body?: string | Uint8Array; headers?: Record<string, string>; method?: string }): Promise<Response> => {
    try {
        return await fetch(input, init as RequestInit);
    } catch (error: unknown) {
        if (!(error instanceof TypeError)) {
            throw error;
        }

        const reason = error.cause instanceof Error ? error.cause.message : error.message;
        const hint = LOOPBACK_HOSTS.has(new URL(input).hostname) ? " — is the dev server running? Start it, or pass --url to point at the worker" : "";

        throw new LunoraError("INTERNAL", `could not reach ${input} (${reason})${hint}`, { cause: error });
    }
};

export { adminFetch, normalizeAdminBaseUrl, resolveAdminBaseUrl, resolveDefaultAdminUrl };
