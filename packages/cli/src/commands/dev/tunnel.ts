/**
 * `lunora dev --tunnel`: share the local Worker through a Cloudflare Quick
 * Tunnel (`cloudflared tunnel --url …`, a random `*.trycloudflare.com` URL, no
 * account), optionally protected with `--allow-mail` — passed through as
 * cloudflared's `--allowed-mail`, so a visitor must prove an allowed email
 * address with a one-time PIN before the request reaches the dev server.
 *
 * Protection is the user's call, not a default: without `--allow-mail` the
 * tunnel is public and dev says so loudly. Best-effort throughout — a missing or
 * outdated `cloudflared`, or one that exits early, is reported and dev carries
 * on without a tunnel.
 *
 * Only the Worker's origin is ever tunneled, never the CLI's Studio port; where
 * Studio shares the origin (the Vite flavors mount it at `/__lunora`) its
 * transport guard refuses the forwarded requests a tunnel produces, and nothing
 * here relaxes that.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { updateDevServerState } from "@lunora/config";
import { coerce, gte } from "semver";

import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import pollDevServerState from "./dev-state-poll";
import { spawnLongLivedChild } from "./supervise";
import type { DevCommandPlan, DevTunnelRequest, LongLivedSpawner } from "./types";

/** First release with protected quick tunnels (`--allowed-mail`), per Cloudflare's announcement. */
const CLOUDFLARED_MIN_VERSION = "2026.9.3";

const CLOUDFLARED_INSTALL_URL = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";

/** `cloudflared --version` prints `cloudflared version 2026.9.3 (built …)`; a source build prints `DEV`. */
const VERSION_PATTERN = /version (\S+)/u;

/** The URL a quick tunnel is assigned. */
const QUICK_TUNNEL_URL = /https:\/\/[\da-z-]+\.trycloudflare\.com/u;

/** cloudflared waits this long (default 30s) for in-flight requests on SIGTERM; dev should stop promptly. */
const GRACE_PERIOD = "1s";

/** How long `close()` waits for cloudflared to exit before letting dev finish anyway. */
const CLOSE_TIMEOUT_MS = 5000;

/** How long the Vite flavors wait for `@lunora/vite` to record the URL Vite listens on. */
const VITE_ORIGIN_TIMEOUT_MS = 60_000;

const VITE_ALLOWED_HOSTS_HINT =
    'Vite answers 403 for hosts it does not know — add `server: { allowedHosts: [".trycloudflare.com"] }` to vite.config if the URL is blocked.';

type CloudflaredCheck = { message: string; ok: false } | { ok: true; version: string | undefined };

/**
 * Probe the installed `cloudflared` with `--version`. Missing or older than
 * {@link CLOUDFLARED_MIN_VERSION} is a failure with an install link; a version
 * string that does not parse (a source build prints `DEV`) is let through, since
 * the tunnel itself will say whether it understands the flags.
 */
const checkCloudflared = async (spawner: Spawner): Promise<CloudflaredCheck> => {
    const install = `Install or update it: ${CLOUDFLARED_INSTALL_URL} (macOS: \`brew install cloudflared\`).`;
    let output: string;

    try {
        const result = await spawner({ args: ["--version"], captureStdoutSilently: true, command: "cloudflared" });

        if (result.code !== 0) {
            return { message: `\`cloudflared --version\` exited ${String(result.code)}. ${install}`, ok: false };
        }

        output = result.stdout ?? "";
    } catch {
        return { message: `--tunnel needs \`cloudflared\` ${CLOUDFLARED_MIN_VERSION} or newer, and it is not on your PATH. ${install}`, ok: false };
    }

    const version = coerce(VERSION_PATTERN.exec(output)?.[1])?.version;

    if (version === undefined) {
        return { ok: true, version: undefined };
    }

    if (!gte(version, CLOUDFLARED_MIN_VERSION)) {
        return {
            message: `--tunnel needs \`cloudflared\` ${CLOUDFLARED_MIN_VERSION} or newer (protected quick tunnels); found ${version}. ${install}`,
            ok: false,
        };
    }

    return { ok: true, version };
};

/**
 * Normalize `--allow-mail` values: each value may be a comma-separated list, so
 * its parts are trimmed and empty ones dropped, and a value left with no parts
 * is dropped entirely — `--allow-mail ""` must not count as protection. Parts
 * without an `@` are returned in `invalid` for the caller to refuse.
 */
const normalizeAllowMail = (values: ReadonlyArray<string> | undefined): { entries: string[]; invalid: string[] } => {
    const entries: string[] = [];
    const invalid: string[] = [];

    for (const value of values ?? []) {
        const parts = value
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);

        if (parts.length > 0) {
            invalid.push(...parts.filter((part) => !part.includes("@")));
            entries.push(parts.join(","));
        }
    }

    return { entries, invalid };
};

/** The `cloudflared` arguments for a quick tunnel to `origin`, each `--allow-mail` entry passed through as `--allowed-mail`. */
const buildCloudflaredArgs = (origin: string, allowMail: ReadonlyArray<string>): string[] => [
    "tunnel",
    "--url",
    origin,
    "--output",
    "json",
    "--grace-period",
    GRACE_PERIOD,
    ...allowMail.flatMap((entry) => ["--allowed-mail", entry]),
];

interface CloudflaredLine {
    /** zerolog's level (`info`, `warn`, `error`, `fatal`, …); `undefined` for a non-JSON line. */
    level: string | undefined;
    text: string;
    /** The quick tunnel URL when this line carries it. */
    url: string | undefined;
}

/**
 * Read one output line of `cloudflared --output json`. Every log line is a
 * zerolog object (`{"level":"info","time":…,"message":…}`) and the assigned URL
 * arrives as the `message` of one of them — a row of the ASCII box cloudflared
 * draws around it. A line that is not JSON (an older binary, or a panic) is
 * scraped as plain text instead.
 */
const parseCloudflaredLine = (line: string): CloudflaredLine => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(line);
    } catch {
        parsed = undefined;
    }

    if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const text = typeof record["message"] === "string" ? record["message"] : "";
        const level = typeof record["level"] === "string" ? record["level"] : undefined;

        return { level, text, url: QUICK_TUNNEL_URL.exec(text)?.[0] };
    }

    return { level: undefined, text: line, url: QUICK_TUNNEL_URL.exec(line)?.[0] };
};

/** The banner for a tunnel without `--allow-mail`: anyone with the URL reaches the dev server. */
const printPublicWarning = (logger: Logger): void => {
    logger.warn("  ⚠  PUBLIC TUNNEL: anyone with the tunnel URL can reach this dev server — there is no sign-in in front of it.");
    logger.warn("     Protect it with a one-time-PIN email allow-list: lunora dev --tunnel --allow-mail you@example.com");
    logger.warn("     (repeat --allow-mail, pass a comma-separated list, or allow a whole domain with '*@example.com')");
};

/** Where the tunnel points: an origin the CLI owns, or the one `@lunora/vite` records once Vite listens. */
type TunnelOrigin = { kind: "fixed"; origin: string } | { kind: "vite" };

/** A resolved origin plus the PID whose `.lunora/dev.json` record the tunnel URL is written into. */
interface ResolvedOrigin {
    origin: string;
    ownerPid: number;
}

/**
 * Wait for `@lunora/vite` to record the URL Vite actually listens on — on the
 * Vite flavors the CLI's own origin is only a pre-listen guess, and tunneling a
 * guessed port would point the public URL at nothing. Gives up after
 * `timeoutMs` (logging why) or when `signal` aborts.
 */
const waitForViteOrigin = async (
    cwd: string,
    logger: Logger,
    signal: AbortSignal,
    { intervalMs, timeoutMs = VITE_ORIGIN_TIMEOUT_MS }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<ResolvedOrigin | undefined> => {
    const resolved = await pollDevServerState(cwd, (state) => (state?.mode === "vite" ? { origin: state.url, ownerPid: state.pid } : undefined), {
        intervalMs,
        signal,
        timeoutMs,
    });

    if (resolved === undefined && !signal.aborted) {
        logger.warn(`--tunnel: the Vite dev server did not report its URL within ${String(timeoutMs / 1000)}s — continuing without a tunnel.`);
    }

    return resolved;
};

interface DevTunnelOptions {
    /** Normalized `--allow-mail` entries; empty opens a public tunnel. */
    allowMail: ReadonlyArray<string>;
    /** Project root: where the tunnel URL is recorded, and where the Vite flavors' record is read. */
    cwd: string;
    logger: Logger;
    origin: TunnelOrigin;
    /** Injection seam for tests — the one-shot spawner for the `--version` probe. */
    spawner?: Spawner;
    /** Injection seam for tests — starts the long-lived `cloudflared tunnel` child. */
    startChild?: LongLivedSpawner;
}

interface DevTunnelHandle {
    /** Stop `cloudflared` and wait (bounded) for it to exit. Idempotent. */
    close: () => Promise<void>;
}

/**
 * Start the tunnel in the background and return immediately — dev's banner and
 * supervision do not wait on it. The URL is printed when cloudflared reports it,
 * and written to `.lunora/dev.json` as `tunnelUrl` for `dev status` and a
 * `--background` start.
 */
const startDevTunnel = (options: DevTunnelOptions): DevTunnelHandle => {
    const { allowMail, cwd, logger } = options;
    const isPublic = allowMail.length === 0;
    const controller = new AbortController();
    const { signal } = controller;
    // A function, not `signal.aborted` inline: the abort happens while `run`
    // awaits the child, which flow analysis cannot see.
    const isShuttingDown = (): boolean => signal.aborted;

    // Ctrl-C reaches cloudflared directly (same process group) and it exits on
    // its own, before teardown calls `close()` — marking the shutdown here keeps
    // that exit from being reported as a tunnel that died under a running server.
    const onShutdownSignal = (): void => {
        controller.abort();
    };

    process.once("SIGINT", onShutdownSignal);
    process.once("SIGTERM", onShutdownSignal);

    const run = async (): Promise<void> => {
        const check = await checkCloudflared(options.spawner ?? defaultSpawner);

        if (!check.ok) {
            logger.error(check.message);
            logger.warn("continuing without a tunnel.");

            return;
        }

        if (check.version === undefined) {
            logger.warn(`could not read the cloudflared version — --tunnel needs ${CLOUDFLARED_MIN_VERSION} or newer; trying anyway.`);
        }

        const target =
            options.origin.kind === "fixed" ? { origin: options.origin.origin, ownerPid: process.pid } : await waitForViteOrigin(cwd, logger, signal);

        if (target === undefined || signal.aborted) {
            return;
        }

        if (isPublic) {
            printPublicWarning(logger);
        }

        logger.info(`starting a Cloudflare quick tunnel to ${target.origin}${isPublic ? "" : " (email one-time-PIN protected)"}…`);

        let assigned: string | undefined;
        // Written from the child's error callback, read after it exits.
        const outcome = { failedToStart: false };

        const onLine = (line: string): void => {
            if (line.length === 0) {
                return;
            }

            const parsed = parseCloudflaredLine(line);

            if (parsed.url !== undefined && assigned === undefined) {
                assigned = parsed.url;
                logger.success(`  ➜  Tunnel:     ${parsed.url}${isPublic ? "  (PUBLIC)" : ""}`);

                if (!isPublic) {
                    logger.info(`     Allowed:    ${allowMail.join(", ")} — visitors confirm with a one-time PIN; a session lasts up to 4 hours`);
                }

                if (options.origin.kind === "vite") {
                    logger.info(`     ${VITE_ALLOWED_HOSTS_HINT}`);
                }

                updateDevServerState(cwd, { tunnelUrl: parsed.url }, { expectedPid: target.ownerPid });

                return;
            }

            if (parsed.level === "error" || parsed.level === "fatal") {
                logger.warn(`[cloudflared] ${parsed.text}`);
            } else {
                logger.debug?.(`[cloudflared] ${parsed.text}`);
            }
        };

        const child = (options.startChild ?? spawnLongLivedChild)(
            // A real executable: no shell wrapper, so `kill` reaches cloudflared itself on Windows too.
            { args: buildCloudflaredArgs(target.origin, allowMail), command: "cloudflared", direct: true },
            onLine,
            (error) => {
                outcome.failedToStart = true;
                logger.error(`could not start cloudflared (${error.message}) — continuing without a tunnel.`);
            },
        );
        const stop = (): void => {
            child.kill("SIGTERM");
        };

        signal.addEventListener("abort", stop, { once: true });

        const code = await child.exited;

        signal.removeEventListener("abort", stop);

        if (assigned !== undefined) {
            updateDevServerState(cwd, { tunnelUrl: undefined }, { expectedPid: target.ownerPid });
        }

        if (isShuttingDown() || outcome.failedToStart) {
            return;
        }

        logger.warn(
            assigned === undefined
                ? `cloudflared exited (${String(code)}) before a tunnel URL was assigned — continuing without a tunnel.`
                : `cloudflared exited (${String(code)}) — the tunnel is closed; the dev server keeps running.`,
        );
    };

    const finished = run().catch((error: unknown) => {
        logger.error(`--tunnel failed (${error instanceof Error ? error.message : String(error)}) — continuing without a tunnel.`);
    });

    return {
        close: async () => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
            controller.abort();
            await Promise.race([finished, sleep(CLOSE_TIMEOUT_MS, undefined, { ref: false })]);
        },
    };
};

/**
 * `--tunnel` for a planned dev run. Where the CLI owns the worker's port — the
 * wrangler flavor, which also covers the celld target and `--no-worker` — the
 * planned origin is the real one. On the Vite flavors (where `--no-worker`
 * does not apply) it is a pre-listen guess, so the tunnel waits for the URL
 * `@lunora/vite` records once Vite listens.
 */
const startTunnelForPlan = (parameters: {
    cwd: string;
    logger: Logger;
    plan: Pick<DevCommandPlan, "flavor" | "workerOrigin">;
    tunnel: DevTunnelRequest | undefined;
}): DevTunnelHandle | undefined => {
    const { cwd, logger, plan, tunnel } = parameters;

    if (tunnel === undefined) {
        return undefined;
    }

    return startDevTunnel({
        allowMail: tunnel.allowMail,
        cwd,
        logger,
        origin: plan.flavor === "wrangler" ? { kind: "fixed", origin: plan.workerOrigin } : { kind: "vite" },
        spawner: tunnel.spawner,
        startChild: tunnel.startChild,
    });
};

export type { CloudflaredCheck, CloudflaredLine, DevTunnelHandle, DevTunnelOptions, TunnelOrigin };
export {
    buildCloudflaredArgs,
    checkCloudflared,
    CLOUDFLARED_INSTALL_URL,
    CLOUDFLARED_MIN_VERSION,
    normalizeAllowMail,
    parseCloudflaredLine,
    printPublicWarning,
    startDevTunnel,
    startTunnelForPlan,
    waitForViteOrigin,
};
