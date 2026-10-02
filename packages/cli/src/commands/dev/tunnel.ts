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
import { readLiveDevServerState } from "@lunora/config";

import type { Logger } from "../../util/logger";
import type { Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";

/** First release with protected quick tunnels (`--allowed-mail`), per Cloudflare's announcement. */
const CLOUDFLARED_MIN_VERSION = "2026.9.3";

const CLOUDFLARED_INSTALL_URL = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";

/** `cloudflared --version` prints `cloudflared version 2026.9.3 (built …)`. */
const VERSION_PATTERN = /version (\d+)\.(\d+)\.(\d+)/u;

/** The URL a quick tunnel is assigned. */
const QUICK_TUNNEL_URL = /https:\/\/[\da-z-]+\.trycloudflare\.com/u;

/** cloudflared waits this long (default 30s) for in-flight requests on SIGTERM; dev should stop promptly. */
const GRACE_PERIOD = "1s";

/** How long `close()` waits for cloudflared to exit before letting dev finish anyway. */
const CLOSE_TIMEOUT_MS = 5000;

type CloudflaredCheck = { message: string; ok: false } | { ok: true; version: string | undefined };

/** Is `found` (`[year, month, patch]`) at least {@link CLOUDFLARED_MIN_VERSION}? */
const meetsMinimumVersion = (found: ReadonlyArray<number>): boolean => {
    const minimum = CLOUDFLARED_MIN_VERSION.split(".").map(Number);

    for (const [index, part] of minimum.entries()) {
        const value = found[index] ?? 0;

        if (value !== part) {
            return value > part;
        }
    }

    return true;
};

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

    const match = VERSION_PATTERN.exec(output);

    if (match === null) {
        return { ok: true, version: undefined };
    }

    const version = `${match[1] ?? ""}.${match[2] ?? ""}.${match[3] ?? ""}`;

    if (!meetsMinimumVersion([Number(match[1]), Number(match[2]), Number(match[3])])) {
        return {
            message: `--tunnel needs \`cloudflared\` ${CLOUDFLARED_MIN_VERSION} or newer (protected quick tunnels); found ${version}. ${install}`,
            ok: false,
        };
    }

    return { ok: true, version };
};

/** The `cloudflared` arguments for a quick tunnel to `origin`, each `--allow-mail` value passed through as `--allowed-mail`. */
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
 * Read one stderr line of `cloudflared --output json`. Every log line is a
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

interface DevTunnelOptions {
    /** `--allow-mail` values; empty opens a public tunnel. */
    allowMail: ReadonlyArray<string>;
    logger: Logger;
    /** Printed once the URL is known — e.g. the Vite `allowedHosts` hint. */
    onUrlHint?: string;

    /**
     * The origin to tunnel, or how to wait for it (the Vite flavors only learn
     * theirs once Vite listens). Resolving `undefined` skips the tunnel; the
     * resolver is responsible for saying why.
     */
    origin: string | ((signal: AbortSignal) => Promise<string | undefined>);
    /** Injection seam for tests — defaults to the real child-process spawner. */
    spawner?: Spawner;
}

interface DevTunnelHandle {
    /** Stop `cloudflared` and wait (bounded) for it to exit. Idempotent. */
    close: () => Promise<void>;
    /** Settles with the public URL as soon as it is assigned, or `undefined` once the tunnel ends without one. */
    url: Promise<string | undefined>;
}

/**
 * Start the tunnel in the background and return immediately — dev's banner and
 * supervision do not wait on it. The URL is printed when cloudflared reports it.
 */
const startDevTunnel = (options: DevTunnelOptions): DevTunnelHandle => {
    const { allowMail, logger } = options;
    const spawner = options.spawner ?? defaultSpawner;
    const controller = new AbortController();
    let closing = false;
    let assigned: string | undefined;
    let settleUrl: (value: string | undefined) => void = () => {};
    const url = new Promise<string | undefined>((resolve) => {
        settleUrl = resolve;
    });

    const run = async (): Promise<void> => {
        const check = await checkCloudflared(spawner);

        if (!check.ok) {
            logger.error(check.message);
            logger.warn("continuing without a tunnel.");

            return;
        }

        if (check.version === undefined) {
            logger.warn(`could not read the cloudflared version — --tunnel needs ${CLOUDFLARED_MIN_VERSION} or newer; trying anyway.`);
        }

        const origin = typeof options.origin === "string" ? options.origin : await options.origin(controller.signal);

        if (origin === undefined || controller.signal.aborted) {
            return;
        }

        if (allowMail.length === 0) {
            printPublicWarning(logger);
        }

        logger.info(`starting a Cloudflare quick tunnel to ${origin}${allowMail.length > 0 ? " (email one-time-PIN protected)" : ""}…`);

        const onLine = (line: string): void => {
            if (line.length === 0) {
                return;
            }

            const parsed = parseCloudflaredLine(line);

            if (parsed.url !== undefined && assigned === undefined) {
                assigned = parsed.url;
                settleUrl(assigned);
                logger.success(`  ➜  Tunnel:     ${parsed.url}${allowMail.length > 0 ? "" : "  (PUBLIC)"}`);

                if (allowMail.length > 0) {
                    logger.info(`     Allowed:    ${allowMail.join(", ")} — visitors confirm with a one-time PIN; a session lasts up to 4 hours`);
                }

                if (options.onUrlHint !== undefined) {
                    logger.info(`     ${options.onUrlHint}`);
                }

                return;
            }

            if (parsed.level === "error" || parsed.level === "fatal") {
                logger.warn(`[cloudflared] ${parsed.text}`);
            } else {
                logger.debug?.(`[cloudflared] ${parsed.text}`);
            }
        };

        try {
            const result = await spawner({
                args: buildCloudflaredArgs(origin, allowMail),
                command: "cloudflared",
                onStderrLine: onLine,
                signal: controller.signal,
                // cloudflared logs to stderr; keep anything on stdout off a `--json` stream.
                stdoutToStderr: true,
            });

            if (!closing) {
                logger.warn(
                    assigned === undefined
                        ? `cloudflared exited (${String(result.code)}) before a tunnel URL was assigned — continuing without a tunnel.`
                        : `cloudflared exited (${String(result.code)}) — the tunnel is closed; the dev server keeps running.`,
                );
            }
        } catch (error: unknown) {
            logger.error(`could not start cloudflared (${error instanceof Error ? error.message : String(error)}) — continuing without a tunnel.`);
        }
    };

    // Resolve-only by construction: every failure above is logged, never thrown.
    // Settling `url` here covers every run that ends without one.
    const finished = run()
        .catch(() => undefined)
        .then(() => {
            settleUrl(assigned);

            return undefined;
        });

    return {
        close: async () => {
            closing = true;
            controller.abort();

            let timer: NodeJS.Timeout | undefined;

            await Promise.race([
                finished,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
                    timer.unref();
                }),
            ]);
            clearTimeout(timer);
        },
        url,
    };
};

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
    { intervalMs = 500, timeoutMs = 60_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs;

    while (!signal.aborted) {
        const state = readLiveDevServerState(cwd);

        if (state?.mode === "vite") {
            return state.url;
        }

        if (Date.now() >= deadline) {
            logger.warn(`--tunnel: the Vite dev server did not report its URL within ${String(timeoutMs / 1000)}s — continuing without a tunnel.`);

            return undefined;
        }

        // eslint-disable-next-line no-await-in-loop -- polling: each wait depends on the previous read
        await new Promise<void>((resolve) => {
            setTimeout(resolve, intervalMs).unref();
        });
    }

    return undefined;
};

export type { CloudflaredCheck, CloudflaredLine, DevTunnelHandle, DevTunnelOptions };
export {
    buildCloudflaredArgs,
    checkCloudflared,
    CLOUDFLARED_INSTALL_URL,
    CLOUDFLARED_MIN_VERSION,
    parseCloudflaredLine,
    printPublicWarning,
    startDevTunnel,
    waitForViteOrigin,
};
