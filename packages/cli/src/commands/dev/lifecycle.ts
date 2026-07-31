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
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DevServerState } from "@lunora/config";
import {
    claimDevServerState,
    clearDevServerState,
    detectFramework,
    DEV_DAEMON_ENV,
    DEV_HANDOFF_ENV,
    DEV_LOG_FILE,
    DEV_LOG_FILE_ENV,
    isRecordedProcessCurrent,
    readDevServerState,
    readLiveDevServerState,
    readProjectDependencyNames,
    updateDevServerState,
} from "@lunora/config";

import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { printJson } from "../../util/output-format";
import { spawnShellCompat } from "../../util/spawn";
import type { DevOptions } from "./index";

/** How long `--background` waits for the server to accept requests before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** Poll cadence for readiness / process-death checks. */
const POLL_INTERVAL_MS = 250;
/** Grace period `dev stop` allows for a clean SIGTERM shutdown before SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** Trailing log lines `dev logs` prints by default (0 = all, within {@link LOG_TAIL_MAX_BYTES}). */
const DEFAULT_LOG_LINES = 100;
/** Log lines surfaced when a background start fails before becoming ready. */
const FAILURE_LOG_TAIL_LINES = 40;
/** Upper bound on how much of the capture log is read back — a long-lived run's log can grow unbounded. */
const LOG_TAIL_MAX_BYTES = 256 * 1024;

/** Env overriding {@link DEFAULT_READY_TIMEOUT_MS}. */
const READY_TIMEOUT_ENV = "LUNORA_DEV_READY_TIMEOUT_MS";

/**
 * How the dev child runs. `wrangler` is the classic `lunora dev` stack (wrangler
 * worker + embedded studio + codegen watch) for a standalone class-C project.
 * `vite` is a project on `@lunora/vite`: the plugin already runs the worker,
 * studio, and codegen inside the Vite dev server, so `lunora dev` runs the
 * project's own dev script and gets out of the way — this also covers class-B
 * frameworks whose own dev server runs the worker in `workerd` (Astro 6 +
 * `@astrojs/cloudflare`, which embeds `@cloudflare/vite-plugin` in `astro dev`:
 * SSR + `/_lunora/*` + `ShardDO` in one process, HMR intact). `framework-worker`
 * is a class-B framework whose dev server CANNOT host the `ShardDO` Durable
 * Object (SvelteKit / Nuxt: their adapters use wrangler's `getPlatformProxy()`,
 * which runs an empty-script Miniflare and does not emulate internal DOs); there
 * `lunora dev` runs the framework's own dev server (front door, HMR, and — via
 * its `@lunora/vite` plugin — studio + codegen) AND a second `wrangler dev`
 * sidecar that owns the real `ShardDO` in `workerd`, wired via the committed
 * `wrangler.dev.jsonc`.
 */
type DevFlavor = "framework-worker" | "vite" | "wrangler";

/**
 * The class-B frameworks whose dev server cannot host the `ShardDO` Durable
 * Object (Node-based SSR + `getPlatformProxy` bindings), so `lunora dev` must
 * run a `wrangler dev` sidecar alongside the framework dev server. Astro is
 * deliberately excluded: Astro 6's `@astrojs/cloudflare` runs the whole app
 * (incl. DOs) in `workerd` inside `astro dev`, so it needs no sidecar.
 */
const SIDECAR_FRAMEWORKS = new Set(["nuxt", "sveltekit"]);

/**
 * Detect the dev flavor.
 *
 * A SvelteKit / Nuxt project needs the two-process `framework-worker` stack even
 * though it also declares `@lunora/vite` (which its framework dev server uses for
 * codegen/studio) — so the framework check comes FIRST. Everything else on
 * `@lunora/vite` (class-A frameworks + Astro + standalone Vite) delegates to the
 * project's own dev server (`vite`); a project without `@lunora/vite` is the
 * classic standalone `wrangler` stack.
 */
const detectDevFlavor = (cwd: string): DevFlavor => {
    if (SIDECAR_FRAMEWORKS.has(detectFramework(cwd).framework)) {
        return "framework-worker";
    }

    return readProjectDependencyNames(cwd).has("@lunora/vite") ? "vite" : "wrangler";
};

/**
 * The dev-server exec for the vite flavor — shared by the foreground plan and
 * the background detach so the two spawn sites can't drift. The project's own
 * `dev` script is the source of truth: for a meta-framework the dev server is
 * the framework CLI (`astro dev`, `nuxt dev`, …), not bare `vite dev`, and
 * every scaffolded template wires the right one into `scripts.dev`. Falls back
 * to `vite dev` when there is no usable script, or when the script mentions
 * `lunora` (it would re-enter this CLI and spawn itself forever).
 */
const viteDevCommand = (cwd: string): { args: ReadonlyArray<string>; command: string } => {
    const manager = detectPackageManager(cwd);
    let script: string | undefined;

    try {
        const raw = readFileSync(join(cwd, "package.json"), "utf8");

        script = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts?.dev;
    } catch {
        // Missing / malformed package.json — fall through to the vite default.
    }

    if (script === undefined || script.trim() === "" || script.includes("lunora")) {
        const exec = execArgsFor(manager, "vite", ["dev"]);

        return { args: exec.args, command: exec.command };
    }

    // `<manager> run dev` is valid for npm, pnpm, yarn, and bun alike.
    return { args: ["run", "dev"], command: manager };
};

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
type DetachedSpawner = (descriptor: {
    args: ReadonlyArray<string>;
    command: string;
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    logPath: string;
}) => DetachedChild;

/**
 * Real detached spawner: routes the child's stdout+stderr into the capture log
 * (truncating any previous run's log), detaches it into its own process group,
 * and unrefs so the parent can exit while the child lives on. The log is
 * created owner-only (0600): dev output routinely echoes `.dev.vars` secrets,
 * tokens, and connection strings, which must not be world-readable on a
 * multi-user machine.
 */
const defaultDetachedSpawner: DetachedSpawner = (descriptor) => {
    mkdirSync(dirname(descriptor.logPath), { recursive: true });

    const logFd = openSync(descriptor.logPath, "w", 0o600);

    let child: ChildProcess;

    // Windows can't spawn the package-manager .cmd shims without a shell — see
    // spawnShellCompat. windowsHide keeps the detached child from flashing a
    // console window; both are no-ops on POSIX.
    const exec = spawnShellCompat(descriptor.command, descriptor.args);

    try {
        child = nodeSpawn(exec.command, exec.args, {
            cwd: descriptor.cwd,
            detached: true,
            env: descriptor.env,
            shell: exec.shell,
            stdio: ["ignore", logFd, logFd],
            windowsHide: true,
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

/**
 * Read the trailing window of a log file as text, capped at
 * {@link LOG_TAIL_MAX_BYTES} so a giant long-running capture log is never
 * slurped whole; `undefined` when unreadable. When capped, the first
 * (likely partial) line of the window is dropped.
 */
const readLogWindow = (path: string): string | undefined => {
    try {
        const { size } = statSync(path);

        if (size <= LOG_TAIL_MAX_BYTES) {
            return readFileSync(path, "utf8");
        }

        const fd = openSync(path, "r");

        try {
            const buffer = Buffer.alloc(LOG_TAIL_MAX_BYTES);
            const read = readSync(fd, buffer, 0, LOG_TAIL_MAX_BYTES, size - LOG_TAIL_MAX_BYTES);
            const text = buffer.toString("utf8", 0, read);

            return text.slice(text.indexOf("\n") + 1);
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }
};

/** Read the last `count` lines of a log file (all lines when `count` &lt;= 0, bounded by {@link LOG_TAIL_MAX_BYTES}); `[]` when unreadable. */
const readLogTail = (path: string, count: number): string[] => {
    const text = readLogWindow(path);

    if (text === undefined) {
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

/** Print the `stop` / `status` / `logs` hint triple shown after every start-adjacent report. */
const printLifecycleHints = (logger: Logger): void => {
    logger.info("  Stop:   lunora dev stop");
    logger.info("  Status: lunora dev status");
    logger.info("  Logs:   lunora dev logs");
};

/** Report an already-running dev server + the lifecycle hints (the idempotent-start path). */
const reportExistingServer = (logger: Logger, existing: { pid: number; url: string }): void => {
    logger.warn(`Dev server already running at ${existing.url} (pid ${String(existing.pid)})`);
    printLifecycleHints(logger);
};

/** Print the ready banner both humans and agents read after a background start. */
const printBackgroundBanner = (logger: Logger, state: DevServerState): void => {
    logger.success(`Dev server running at ${state.url} (pid ${String(state.pid)})`);

    if (state.studioUrl !== undefined) {
        logger.info(`  Studio: ${state.studioUrl}`);
    }

    printLifecycleHints(logger);
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
const waitUntilReady = async (parameters: {
    child: DetachedChild;
    cwd: string;
    deadline: number;
    pollIntervalMs: number;
    probe: ReadinessProbe;
}): Promise<ReadyOutcome> => {
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
 *
 * On the ready-timeout path the child may still be alive and compiling — it
 * hasn't been killed, just not waited for any longer — so the still-provisional
 * parent record is re-pointed at the child's PID (see the timeout branch below)
 * rather than left to be deleted by the caller's `finally`. That keeps `dev
 * status`/`stop`/`logs` able to find the orphan instead of reporting "No dev
 * server running" for a process that is, in fact, running.
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

        // Guard with `?? process.pid`: a spawn failure can yield `pid:
        // undefined` before the child ever claimed anything, in which case the
        // record (if any) is still this parent's own provisional claim — or,
        // worse, a pre-existing record some OTHER server owns. An unguarded
        // clear would delete that unrelated record.
        clearDevServerState(cwd, child.pid ?? process.pid);

        return { code: outcome.exitCode === 0 ? 1 : outcome.exitCode };
    }

    if (child.pid !== undefined) {
        // Keep the record alive past the parent: point it at the detached
        // child so `dev status`/`stop` can still see and signal it. Only
        // re-point while the record is still OUR provisional claim — if the
        // child already wrote its own authoritative record (superseding
        // ours), leave it untouched rather than clobber it.
        const current = readDevServerState(cwd);

        if (current?.pid === process.pid) {
            updateDevServerState(cwd, { logFile: logPath, pid: child.pid });
        }
    }

    const pidHint = child.pid === undefined ? "" : ` (pid ${String(child.pid)})`;

    logger.warn(
        `dev server did not confirm ready within ${String(Math.round(timeout / 1000))}s — it may still be compiling${pidHint}. ` +
            "Check `lunora dev status` and `lunora dev logs`; `lunora dev stop` shuts it down.",
    );

    return { code: 1 };
};

/**
 * Rebuild the argv a detached daemon `lunora dev` re-invocation needs, from the
 * already-parsed options. `--background`/`--json` are deliberately NOT
 * forwarded: the daemon must run the foreground path (its detachment marker is
 * {@link DEV_DAEMON_ENV}), and JSON logging travels as `LUNORA_LOG_JSON=1` env.
 *
 * KEEP IN SYNC with the `dev` option table in `./index.ts`: any new flag that
 * must reach the detached daemon has to be forwarded here explicitly, or a
 * background start will silently drop it.
 */
const daemonArguments = (options: DevOptions, remote: boolean): string[] => {
    const args = ["dev"];

    if (options.apiSpec !== undefined) {
        args.push("--api-spec", options.apiSpec);
    }

    if (options.port !== undefined) {
        args.push("--port", String(options.port));
    }

    if (options.workerPort !== undefined) {
        args.push("--worker-port", String(options.workerPort));
    }

    if (options.codegen === false) {
        args.push("--no-codegen");
    }

    if (options.studio === false) {
        args.push("--no-studio");
    }

    if (options.worker === false) {
        args.push("--no-worker");
    }

    // Forwarded explicitly, like every other flag here: the daemon is a fresh
    // process that re-parses argv, so an unforwarded flag is silently dropped.
    // `lunora.json`'s target still reaches it (the daemon re-reads the config),
    // which is what makes a missing `--target` look accepted and do nothing.
    if (options.target !== undefined) {
        args.push("--target", options.target);
    }

    if (remote) {
        args.push("--remote");
    }

    return args;
};

/**
 * Detach the dev server as a managed background process and block until it is
 * ready: the project's dev script directly for a Vite project (its dev-state
 * plugin writes the record), else this same CLI re-invoked as the daemon.
 *
 * Before spawning, this parent atomically claims `.lunora/dev.json` as a
 * provisional record under its own PID — closing the race where two
 * simultaneous starts both pass the read-based lock check and spawn separate
 * servers — and hands its PID down via {@link DEV_HANDOFF_ENV} so exactly one
 * child (the vite dev-state plugin, or the wrangler daemon) supersedes the
 * record with the authoritative URL + PID. The provisional record is cleared
 * (PID-guarded) once the wait resolves; after a successful handoff the clear
 * is a no-op because the record already carries the child's PID.
 */
const startBackground = async (context: {
    cwd: string;
    jsonLogs: boolean;
    logger: Logger;
    options: DevOptions;
    remote: boolean;
    /** Injection seam for tests — defaults to the real {@link runDevBackground}. */
    run?: (options: BackgroundCommandOptions) => Promise<{ code: number }>;
}): Promise<{ code: number }> => {
    const { cwd, jsonLogs, logger, options, remote } = context;
    const run = context.run ?? runDevBackground;
    const flavor = detectDevFlavor(cwd);
    // Pre-listen default URL — cosmetic (shown only if a concurrent starter
    // loses to this claim); the child's superseding record carries the real one.
    // For `vite`/`framework-worker` the front door is the framework's own dev
    // server; only the standalone `wrangler` flavor opens the worker port here.
    const url = flavor === "wrangler" ? `http://localhost:${String(options.workerPort ?? 8787)}` : "http://localhost:5173";

    const claim = claimDevServerState(cwd, {
        background: true,
        mode: "cli",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        url,
    });

    if (!claim.ok) {
        if (claim.existing !== undefined) {
            reportExistingServer(logger, claim.existing);
        }

        return { code: 0 };
    }

    const handoff = { [DEV_HANDOFF_ENV]: String(process.pid) };

    try {
        if (flavor === "vite") {
            return await run({
                command: viteDevCommand(cwd),
                cwd,
                env: { ...(remote ? { LUNORA_REMOTE: "1" } : {}), ...handoff },
                json: jsonLogs,
                logger,
            });
        }

        // Re-invoke this same CLI entry as the detached daemon.
        return await run({
            command: { args: [process.argv[1] ?? "lunora", ...daemonArguments(options, remote)], command: process.execPath },
            cwd,
            env: handoff,
            json: jsonLogs,
            logger,
        });
    } finally {
        // Drop the provisional record unless a child already superseded it.
        clearDevServerState(cwd, process.pid);
    }
};

/**
 * Process-group id of `pid` via `ps` (POSIX only), or `undefined`. The
 * recorded PID is not necessarily a group leader — a Vite background record
 * holds Vite's PID while the detached group is led by the package-manager
 * wrapper — so the group must be looked up, never assumed to equal the PID.
 */
const processGroupId = (pid: number): number | undefined => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `ps` must resolve from PATH (POSIX standard tool); args are fixed and no shell is involved
        const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
        const pgid = Number.parseInt(result.stdout.trim(), 10);

        return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
    } catch {
        return undefined;
    }
};

/** The signal seam `dev stop` drives — `process.kill` in production, recorded in tests. */
type SignalFunction = (pid: number, signal: NodeJS.Signals) => void;

/** The `spawnSync` seam the win32 `taskkill` escalation drives — the real `spawnSync` in production, recorded in tests. */
type SpawnSyncFunction = (command: string, args: ReadonlyArray<string>, options: { stdio: "ignore" }) => unknown;

/**
 * Force-kill escalation after a stalled graceful shutdown, scoped by platform
 * and by how the server was started.
 *
 * Windows has no POSIX process groups, so `taskkill /T /F` fells the whole
 * child tree (wrangler/workerd/vite children would otherwise be orphaned
 * holding the port). On POSIX, a BACKGROUND record was detached into its own
 * process group containing only our children, so the group is killed
 * (resolved via {@link processGroupId} — the recorded PID may not be its
 * leader). A FOREGROUND record gets a single-PID kill only: the foreground
 * CLI may share a process group with the user's shell job (no job control
 * under `sh -c`), so a group kill could fell innocent processes.
 *
 * `platform` and `spawnSyncImpl` are injection seams (defaulting to the real
 * `process.platform` / `spawnSync`), following the same convention as the
 * `signal` parameter — they let tests drive the win32 `taskkill` branch
 * without a Windows host.
 */
const forceKillRecordedServer = (
    state: DevServerState,
    signal: SignalFunction,
    platform: NodeJS.Platform = process.platform,
    spawnSyncImpl: SpawnSyncFunction = spawnSync,
): void => {
    if (platform === "win32") {
        try {
            spawnSyncImpl("taskkill", ["/pid", String(state.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
            /* already gone */
        }

        return;
    }

    if (state.background === true) {
        try {
            signal(-(processGroupId(state.pid) ?? state.pid), "SIGKILL");

            return;
        } catch {
            /* group gone or unkillable — fall through to the single PID */
        }
    }

    try {
        signal(state.pid, "SIGKILL");
    } catch {
        /* already gone */
    }
};

interface StopCommandOptions {
    /** Injection seam for tests — defaults to {@link isRecordedProcessCurrent} against the record. */
    alive?: (pid: number) => boolean;
    cwd: string;
    json: boolean;
    logger: Logger;
    /** Injection seam for tests — defaults to `process.platform`. */
    platform?: NodeJS.Platform;
    /** Injection seam for tests — defaults to {@link POLL_INTERVAL_MS} / {@link STOP_GRACE_MS}. */
    pollIntervalMs?: number;
    /** Injection seam for tests — defaults to `process.kill`. */
    signal?: SignalFunction;
    /** Injection seam for tests — defaults to the real `spawnSync` (used by the win32 `taskkill` escalation). */
    spawnSyncImpl?: SpawnSyncFunction;
    stopGraceMs?: number;
}

/**
 * Report a force-kill that did not land (e.g. win32 `taskkill` exiting
 * non-zero, or an EPERM'd SIGKILL): the stop must not read as success — keep
 * the record so a retry can still target the server, and fail the command.
 */
const reportSurvivedForceKill = (state: DevServerState, options: StopCommandOptions): { code: number } => {
    if (options.json) {
        printJson({ pid: state.pid, stopped: false });
    } else {
        options.logger.error(
            `dev server (pid ${String(state.pid)}) survived the force-kill — record kept; retry \`lunora dev stop\` or kill the process manually.`,
        );
    }

    return { code: 1 };
};

/**
 * `lunora dev stop` — SIGTERM the recorded dev server, escalate after a grace
 * period (see {@link forceKillRecordedServer}), verify the kill landed, and
 * clear the state record. Idempotent: stopping when nothing runs succeeds
 * silently. The record's PID is verified to still be the process that wrote it
 * (PID-reuse guard) before anything is signalled.
 */
const runDevStop = async (options: StopCommandOptions): Promise<{ code: number }> => {
    const { cwd, logger } = options;
    const state = readDevServerState(cwd);
    const alive = options.alive ?? ((pid: number): boolean => pid === state?.pid && isRecordedProcessCurrent(state));
    const signal =
        options.signal ??
        ((pid: number, sig: NodeJS.Signals): void => {
            process.kill(pid, sig);
        });
    const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const grace = options.stopGraceMs ?? STOP_GRACE_MS;
    const platform = options.platform ?? process.platform;
    const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;

    if (state === undefined || !alive(state.pid)) {
        // Drop the stale record — but only if it is still the one we read.
        // Unguarded, this would race a concurrent `lunora dev` that claimed a
        // fresh record between our read and this clear, orphaning that server
        // from `stop`/`status`/`logs`.
        if (state !== undefined) {
            clearDevServerState(cwd, state.pid);
        }

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
        forceKillRecordedServer(state, signal, platform, spawnSyncImpl);
        await sleep(pollInterval);

        if (alive(state.pid)) {
            return reportSurvivedForceKill(state, options);
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
    /** Trailing lines to print; 0 or negative = the whole log (bounded by {@link LOG_TAIL_MAX_BYTES}). */
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

/**
 * Route a `lunora dev &lt;subcommand>` positional to its lifecycle command.
 * Returns `undefined` when no subcommand was given (→ the caller runs the
 * start path), a `{ code: 1 }` error for an unknown one.
 */
const runLifecycleSubcommand = (parameters: {
    cwd: string;
    json: boolean;
    lines?: number;
    logger: Logger;
    subcommand: string | undefined;
}): Promise<{ code: number }> | { code: number } | undefined => {
    const { cwd, json, lines, logger, subcommand } = parameters;

    if (subcommand === "stop") {
        return runDevStop({ cwd, json, logger });
    }

    if (subcommand === "status") {
        return runDevStatus({ cwd, json, logger });
    }

    if (subcommand === "logs") {
        return runDevLogs({ cwd, lines, logger });
    }

    if (subcommand !== undefined) {
        logger.error(`dev: unknown subcommand "${subcommand}" — expected stop | status | logs (or no subcommand to start the dev server)`);

        return { code: 1 };
    }

    return undefined;
};

export type {
    BackgroundCommandOptions,
    DetachedChild,
    DetachedSpawner,
    DevFlavor,
    LogsCommandOptions,
    ReadinessProbe,
    StatusCommandOptions,
    StopCommandOptions,
};
export {
    detectDevFlavor,
    printLifecycleHints,
    reportExistingServer,
    runDevBackground,
    runDevLogs,
    runDevStatus,
    runDevStop,
    runLifecycleSubcommand,
    startBackground,
    viteDevCommand,
};
