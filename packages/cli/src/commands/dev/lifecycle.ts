/**
 * `lunora dev` lifecycle subcommands and background mode.
 *
 * AI agents (and humans juggling terminals) struggle with a process that never
 * exits: they start duplicate servers, lose PIDs, and leave zombies behind. So
 * `lunora dev --background` starts the dev stack as a managed, detached
 * process — it blocks until the server accepts requests, prints the URL + PID,
 * and returns — while `.lunora/dev.json` (see `@lunora/config`'s
 * `dev-server-state`) acts as the lockfile that `stop` / `status` / `logs`
 * resolve the instance from. Every subcommand is idempotent and forgiving:
 * stopping a stopped server succeeds silently, starting over a running one
 * reports the existing instance instead of spawning a conflict.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DevServerState } from "@lunora/config";
import { clearDevServerState, DEV_DAEMON_ENV, DEV_LOG_FILE, DEV_LOG_FILE_ENV, isProcessAlive, readDevServerState, readLiveDevServerState } from "@lunora/config";

import type { Logger } from "../../util/logger";
import { printJson } from "../../util/output-format";

/** How long `--background` waits for the server to accept requests before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** Poll cadence for readiness / process-death checks. */
const POLL_INTERVAL_MS = 250;
/** Grace period `dev stop` allows for a clean SIGTERM shutdown before SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** Trailing log lines `dev logs` prints by default (0 = all). */
const DEFAULT_LOG_LINES = 100;
/** Log lines surfaced when a background start fails before becoming ready. */
const FAILURE_LOG_TAIL_LINES = 40;

/** Env overriding {@link DEFAULT_READY_TIMEOUT_MS}. */
const READY_TIMEOUT_ENV = "LUNORA_DEV_READY_TIMEOUT_MS";

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * True when an HTTP server answers at `origin` — ANY response counts,
 * including a 404. The probe targets `/_lunora/status` (the runtime's public
 * health route), but an older runtime without that route still proves the
 * server is up by answering at all; only a refused/failed connection is "not
 * ready".
 */
const defaultProbe = async (origin: string): Promise<boolean> => {
    try {
        await fetch(new URL("/_lunora/status", origin), { signal: AbortSignal.timeout(1000) });

        return true;
    } catch {
        return false;
    }
};

/** Readiness probe seam — tests swap the real HTTP probe out. */
type ReadinessProbe = (origin: string) => Promise<boolean>;

/** A spawned detached child, narrowed to what the wait loop needs. */
interface DetachedChild {
    exited: Promise<number>;
    pid: number | undefined;
}

/** Spawns the detached daemon process. Injectable so tests drive the orchestration without real processes. */
type DetachedSpawner = (descriptor: { args: ReadonlyArray<string>; command: string; cwd: string; env: Readonly<Record<string, string | undefined>>; logPath: string }) => DetachedChild;

/**
 * Real detached spawner: routes the child's stdout+stderr into the capture log
 * (truncating any previous run's log), detaches it into its own process group,
 * and unrefs so the parent can exit while the child lives on.
 */
const defaultDetachedSpawner: DetachedSpawner = (descriptor) => {
    mkdirSync(dirname(descriptor.logPath), { recursive: true });

    const logFd = openSync(descriptor.logPath, "w");

    let child: ChildProcess;

    try {
        child = nodeSpawn(descriptor.command, [...descriptor.args], {
            cwd: descriptor.cwd,
            detached: true,
            env: descriptor.env,
            stdio: ["ignore", logFd, logFd],
        });
    } finally {
        // The child holds its own copies of the fd; the parent's must not leak.
        closeSync(logFd);
    }

    child.unref();

    return {
        exited: new Promise<number>((resolve) => {
            child.on("error", () => {
                resolve(1);
            });
            child.on("exit", (code, signal) => {
                resolve(code ?? (signal ? 1 : 0));
            });
        }),
        pid: child.pid,
    };
};

/** Read the last `count` lines of a log file (all lines when `count` &lt;= 0); `[]` when unreadable. */
const readLogTail = (path: string, count: number): string[] => {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch {
        return [];
    }

    const lines = text.split("\n");

    // A trailing newline yields one empty final element — not a real line.
    if (lines.at(-1) === "") {
        lines.pop();
    }

    return count > 0 ? lines.slice(-count) : lines;
};

/** The absolute capture-log path for a project, honouring the state record when present. */
const resolveLogPath = (cwd: string, state: DevServerState | undefined): string => state?.logFile ?? join(cwd, DEV_LOG_FILE);

/** Print the ready banner both humans and agents read after a background start. */
const printBackgroundBanner = (logger: Logger, state: DevServerState): void => {
    logger.success(`Dev server running at ${state.url} (pid ${String(state.pid)})`);

    if (state.studioUrl !== undefined) {
        logger.info(`  Studio: ${state.studioUrl}`);
    }

    logger.info("  Stop:   lunora dev stop");
    logger.info("  Status: lunora dev status");
    logger.info("  Logs:   lunora dev logs");
};

interface BackgroundCommandOptions {
    /** The command to run detached (the daemon `lunora dev` or `vite dev`). */
    command: { args: ReadonlyArray<string>; command: string };
    cwd: string;
    /** Extra env for the daemon beyond the detach/log/JSON plumbing. */
    env?: Readonly<Record<string, string>>;
    /** Whether the daemon should emit JSON log lines into the capture log. */
    json: boolean;
    logger: Logger;
    /** Injection seam for tests — defaults to {@link POLL_INTERVAL_MS}. */
    pollIntervalMs?: number;
    /** Injection seam for tests — defaults to the real HTTP readiness probe. */
    probe?: ReadinessProbe;
    /** Injection seam for tests — defaults to env override or {@link DEFAULT_READY_TIMEOUT_MS}. */
    readyTimeoutMs?: number;
    /** Injection seam for tests — defaults to the real detached spawner. */
    spawnDetached?: DetachedSpawner;
}

/** Outcome of the readiness wait: server ready (with its record), child death, or deadline. */
type ReadyOutcome = { exitCode: number; status: "exited" } | { state: DevServerState; status: "ready" } | { status: "timeout" };

/**
 * Poll until the child's state record is live AND the server answers HTTP,
 * the child dies, or the deadline passes. Polling (rather than event wiring)
 * keeps the three racing signals — record file, HTTP socket, process death —
 * in one legible loop.
 */
const waitUntilReady = async (parameters: { child: DetachedChild; cwd: string; deadline: number; pollIntervalMs: number; probe: ReadinessProbe }): Promise<ReadyOutcome> => {
    const { child, cwd, deadline, pollIntervalMs, probe } = parameters;
    const exited = child.exited.then((code): { exitCode: number } => {
        return { exitCode: code };
    });

    while (Date.now() < deadline) {
        const state = readLiveDevServerState(cwd);

        // Wait for the record the child writes, then for the server to answer.
        // Guard against reading a leftover record that predates this spawn: the
        // recorded PID must be alive (readLive guarantees it) and must not be
        // this parent process.
        // eslint-disable-next-line no-await-in-loop -- readiness polling: each tick re-samples record + socket.
        if (state !== undefined && state.pid !== process.pid && (await probe(state.url))) {
            return { state, status: "ready" };
        }

        // Sleep one tick — but wake immediately (with the exit code) if the
        // child dies first: a daemon dead before ready is a failed start.
        // eslint-disable-next-line no-await-in-loop -- readiness polling; the race keeps child-death latency at zero.
        const raced = await Promise.race([exited, sleep(pollIntervalMs)]);

        if (raced !== undefined) {
            return { ...raced, status: "exited" };
        }
    }

    return { status: "timeout" };
};

/**
 * Start the dev server as a managed background process: spawn detached with
 * output captured to `.lunora/dev.log`, block until the server has written its
 * state record AND accepts an HTTP request, print URL + PID, and return.
 *
 * The child — not this parent — writes `.lunora/dev.json` (the daemon `lunora
 * dev` writes it once wrangler spawns; a Vite project's dev-state plugin writes
 * it once Vite listens), so the record always carries the authoritative URL and
 * the PID that `dev stop` must signal. This parent only passes the log path and
 * detach marker down via env.
 */
const runDevBackground = async (options: BackgroundCommandOptions): Promise<{ code: number }> => {
    const { cwd, logger } = options;
    const logPath = resolveLogPath(cwd, undefined);
    const environmentTimeout = Number(process.env[READY_TIMEOUT_ENV] ?? "");
    const timeout = options.readyTimeoutMs ?? (Number.isFinite(environmentTimeout) && environmentTimeout > 0 ? environmentTimeout : DEFAULT_READY_TIMEOUT_MS);

    const child = (options.spawnDetached ?? defaultDetachedSpawner)({
        args: options.command.args,
        command: options.command.command,
        cwd,
        env: {
            ...process.env,
            ...options.env,
            [DEV_DAEMON_ENV]: "1",
            [DEV_LOG_FILE_ENV]: logPath,
            // The capture log is read back by `lunora dev logs` (and often an
            // agent) — ANSI colour codes would only garble it.
            ...(process.env.FORCE_COLOR === undefined ? { NO_COLOR: "1" } : {}),
            ...(options.json ? { LUNORA_LOG_JSON: "1" } : {}),
        },
        logPath,
    });

    const outcome = await waitUntilReady({
        child,
        cwd,
        deadline: Date.now() + timeout,
        pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
        probe: options.probe ?? defaultProbe,
    });

    if (outcome.status === "ready") {
        printBackgroundBanner(logger, outcome.state);

        return { code: 0 };
    }

    if (outcome.status === "exited") {
        // Died before becoming ready — surface the log tail instead of leaving
        // the user (or agent) to hunt for it.
        logger.error(`dev server exited before becoming ready (exit code ${String(outcome.exitCode)}). Last output:`);

        for (const line of readLogTail(logPath, FAILURE_LOG_TAIL_LINES)) {
            logger.error(`  ${line}`);
        }

        clearDevServerState(cwd, child.pid);

        return { code: outcome.exitCode === 0 ? 1 : outcome.exitCode };
    }

    logger.warn(
        `dev server did not confirm ready within ${String(Math.round(timeout / 1000))}s — it may still be compiling. ` +
            "Check `lunora dev status` and `lunora dev logs`; `lunora dev stop` shuts it down.",
    );

    return { code: 1 };
};

interface StopCommandOptions {
    /** Injection seam for tests — defaults to {@link isProcessAlive}. */
    alive?: (pid: number) => boolean;
    cwd: string;
    json: boolean;
    logger: Logger;
    /** Injection seam for tests — defaults to {@link POLL_INTERVAL_MS} / {@link STOP_GRACE_MS}. */
    pollIntervalMs?: number;
    /** Injection seam for tests — defaults to `process.kill`. */
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    stopGraceMs?: number;
}

/**
 * `lunora dev stop` — SIGTERM the recorded dev server, escalate to SIGKILL
 * after a grace period, and clear the state record. Idempotent: stopping when
 * nothing runs succeeds silently.
 */
const runDevStop = async (options: StopCommandOptions): Promise<{ code: number }> => {
    const { cwd, logger } = options;
    const alive = options.alive ?? isProcessAlive;
    const signal = options.signal ?? ((pid: number, sig: NodeJS.Signals): void => {
        process.kill(pid, sig);
    });
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const grace = options.stopGraceMs ?? STOP_GRACE_MS;
    const state = readDevServerState(cwd);

    if (state === undefined || !alive(state.pid)) {
        clearDevServerState(cwd);

        if (options.json) {
            printJson({ running: false, stopped: false });
        } else {
            logger.info("No dev server running.");
        }

        return { code: 0 };
    }

    try {
        signal(state.pid, "SIGTERM");
    } catch {
        /* died between the alive check and the signal — that's a stop */
    }

    const deadline = Date.now() + grace;

    while (alive(state.pid) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- graceful-shutdown polling: re-check liveness each tick.
        await sleep(pollInterval);
    }

    if (alive(state.pid)) {
        // Graceful shutdown stalled — force-kill. Prefer the process GROUP
        // (detached daemons lead their own group, taking wrangler/vite child
        // processes down with them); fall back to the single PID.
        try {
            signal(-state.pid, "SIGKILL");
        } catch {
            try {
                signal(state.pid, "SIGKILL");
            } catch {
                /* already gone */
            }
        }
    }

    // The server clears its own record on clean shutdown; this covers the
    // SIGKILL path (and is a no-op when the record is already gone).
    clearDevServerState(cwd, state.pid);

    if (options.json) {
        printJson({ pid: state.pid, stopped: true });
    } else {
        logger.success(`Stopped dev server (pid ${String(state.pid)}).`);
    }

    return { code: 0 };
};

interface StatusCommandOptions {
    cwd: string;
    json: boolean;
    logger: Logger;
    /** Injection seam for tests — defaults to `Date.now()`. */
    now?: () => number;
}

/**
 * `lunora dev status` — report the recorded dev server (URL, PID, uptime,
 * background/foreground). A stale record (dead PID) reads as "not running" and
 * is cleared. Always exits 0; agents branch on the JSON `running` field.
 */
const runDevStatus = (options: StatusCommandOptions): { code: number } => {
    const { cwd, logger } = options;
    const state = readLiveDevServerState(cwd);

    if (state === undefined) {
        if (options.json) {
            printJson({ running: false });
        } else {
            logger.info("No dev server running.");
        }

        return { code: 0 };
    }

    const now = options.now ?? Date.now;
    const startedAtMs = state.startedAt === undefined ? Number.NaN : Date.parse(state.startedAt);
    const uptimeSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.round((now() - startedAtMs) / 1000)) : undefined;

    if (options.json) {
        printJson({
            background: state.background === true,
            logFile: state.logFile,
            mode: state.mode,
            pid: state.pid,
            running: true,
            startedAt: state.startedAt,
            studioUrl: state.studioUrl,
            uptimeSeconds,
            url: state.url,
        });

        return { code: 0 };
    }

    const details = [
        `pid ${String(state.pid)}`,
        ...(uptimeSeconds === undefined ? [] : [`uptime ${String(uptimeSeconds)}s`]),
        state.background === true ? "background" : "foreground",
    ];

    logger.success(`Dev server running at ${state.url} (${details.join(", ")})`);

    if (state.studioUrl !== undefined) {
        logger.info(`  Studio: ${state.studioUrl}`);
    }

    if (state.logFile !== undefined) {
        logger.info(`  Logs:   lunora dev logs (${state.logFile})`);
    }

    return { code: 0 };
};

interface LogsCommandOptions {
    cwd: string;
    /** Trailing lines to print; 0 or negative = the whole log. */
    lines?: number;
    logger: Logger;
}

/**
 * `lunora dev logs` — print the captured dev-server output (background runs
 * route stdout+stderr into `.lunora/dev.log`). Raw pass-through to stdout so
 * JSON log lines stay parseable. Forgiving: no log yet is not an error.
 */
const runDevLogs = (options: LogsCommandOptions): { code: number } => {
    const { cwd, logger } = options;
    const state = readDevServerState(cwd);
    const logPath = resolveLogPath(cwd, state);

    if (!existsSync(logPath)) {
        logger.info("No dev server logs found — output is captured when the server runs in background mode (`lunora dev --background`).");

        return { code: 0 };
    }

    const tail = readLogTail(logPath, options.lines ?? DEFAULT_LOG_LINES);

    if (tail.length > 0) {
        process.stdout.write(`${tail.join("\n")}\n`);
    }

    return { code: 0 };
};

export type { BackgroundCommandOptions, DetachedChild, DetachedSpawner, LogsCommandOptions, ReadinessProbe, StatusCommandOptions, StopCommandOptions };
export { runDevBackground, runDevLogs, runDevStatus, runDevStop };
