/**
 * A `celld dev` session for every dev server with the celld target —
 * `lunora dev`, `@lunora/vite` and `@lunora/rspack/rsbuild`.
 *
 * celld resolves a service binding (plan 457) from the target Worker's
 * deployment record in the local state, which `celld dev` keeps beside the
 * config it runs. So the session first boots each `lunora.config` service once
 * from a projection beside the app's — that records it — and only then runs the
 * app. celld rebuilds the app on its own when an app file changes; a service is
 * only ever deployed by booting it, so a change under a service's folder
 * re-registers that service and restarts the app.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

import { readServiceBindings } from "@lunora/codegen";

import { planCelldConfig, planCelldServiceConfig } from "./celld-config";

/** How long one `celld dev` gets to accept connections. */
const READY_TIMEOUT_MS = 60_000;

const READY_POLL_MS = 150;

/** How long a stopping `celld dev` gets before SIGKILL. */
const STOP_ESCALATION_MS = 5000;

/** Quiet period after the last service file change before the restart. */
const RESTART_DEBOUNCE_MS = 200;

/** Paths under a service folder whose changes are celld's own state or build output, not source. */
const IGNORED_SEGMENTS = new Set([".celld", ".wrangler", "node_modules"]);

const PATH_SEPARATOR = /[/\\]/u;

/** Spawns `celld` — injectable so tests drive the session without the binary. */
type CelldSpawner = (args: ReadonlyArray<string>, cwd: string) => ChildProcess;

interface CelldDevSessionOptions {
    /** Prints one line of the session's output; `source` is `app` or the service's Worker name. */
    log: (line: string, source: string) => void;
    /** Port every `celld dev` of the session serves on, one at a time. */
    port: number;
    projectRoot: string;
    spawn?: CelldSpawner;
}

interface CelldDevSession {
    /** Resolves with the exit code when the app's `celld dev` exits on its own — a crash, not a stop or restart. */
    exited: Promise<number>;
    /** Re-register the service whose Worker is `worker`, then restart the app. */
    restartService: (worker: string) => Promise<void>;
    /** Stop watching, then stop the app. */
    stop: () => Promise<void>;
}

/** A running `celld dev` and the handle that stops it. */
interface Running {
    /** Resolves when the process exits without {@link Running.stop} asking it to. */
    crashed: Promise<number>;
    stop: () => Promise<void>;
}

const defaultSpawn: CelldSpawner = (args, cwd) =>
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `celld` is a standalone binary resolved from PATH (its install location varies); args are fixed and no shell is involved
    spawnProcess("celld", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });

/** `true` once something accepts a TCP connection on `port`. */
const accepts = async (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const settle = (ready: boolean): void => {
            socket.destroy();
            resolve(ready);
        };

        socket.once("connect", () => {
            settle(true);
        });
        socket.once("error", () => {
            settle(false);
        });
    });

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** Forward a child stream to `log`, one non-empty line at a time. */
const pipeLines = (stream: NodeJS.ReadableStream | null, log: (line: string) => void): void => {
    let buffered = "";

    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
        buffered += chunk;

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        for (const line of lines.filter((entry) => entry.trim() !== "")) {
            log(line);
        }
    });
};

/** Whether a changed path (relative to the watched folder) is state or output rather than source. */
const isIgnoredChange = (file: string | null): boolean => file?.split(PATH_SEPARATOR).some((segment) => IGNORED_SEGMENTS.has(segment)) === true;

/** Watch `directory`, calling `onChange` once per burst of source changes. */
const watchSourceChanges = (directory: string, onChange: () => void): { close: () => void } => {
    let timer: NodeJS.Timeout | undefined;
    const watcher: FSWatcher = watch(directory, { recursive: true }, (_event, file) => {
        if (isIgnoredChange(file)) {
            return;
        }

        clearTimeout(timer);
        timer = setTimeout(onChange, RESTART_DEBOUNCE_MS);
    });

    return {
        close: () => {
            clearTimeout(timer);
            watcher.close();
        },
    };
};

/** Spawn `celld dev <configPath>` and resolve once it accepts connections on `port`. */
const startCelldDev = async (options: {
    configPath: string;
    cwd: string;
    log: (line: string) => void;
    port: number;
    spawn: CelldSpawner;
}): Promise<Running> => {
    const child = options.spawn(["dev", options.configPath, "--port", String(options.port)], options.cwd);
    let failure: Error | undefined;
    let stopping = false;

    pipeLines(child.stdout, options.log);
    pipeLines(child.stderr, options.log);
    child.once("error", (error: NodeJS.ErrnoException) => {
        failure = error.code === "ENOENT" ? new Error("`celld` was not found on PATH — install it (https://celld.dev) to run the celld target") : error;
    });
    child.once("exit", (code) => {
        failure ??= new Error(`celld dev exited with code ${String(code)} before it was ready`);
    });

    const crashed = new Promise<number>((resolve) => {
        child.once("exit", (code) => {
            if (!stopping) {
                resolve(code ?? 1);
            }
        });
    });

    const stop = async (): Promise<void> => {
        stopping = true;

        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }

        await new Promise<void>((resolve) => {
            const escalation = setTimeout(() => {
                child.kill("SIGKILL");
            }, STOP_ESCALATION_MS);

            child.once("exit", () => {
                clearTimeout(escalation);
                resolve();
            });
            child.kill("SIGTERM");
        });
    };

    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (failure !== undefined) {
            throw failure;
        }

        // eslint-disable-next-line no-await-in-loop -- a readiness poll is sequential by definition
        if (await accepts(options.port)) {
            return { crashed, stop };
        }

        // eslint-disable-next-line no-await-in-loop -- a readiness poll is sequential by definition
        await pause(READY_POLL_MS);
    }

    await stop();

    throw new Error(`celld dev did not accept connections on port ${String(options.port)} within ${String(READY_TIMEOUT_MS / 1000)}s`);
};

/**
 * Start the session: register every service, run the app, then watch the
 * service folders. Resolves once the app accepts connections; rejects, with
 * nothing left running, when a service or the app cannot start — including an
 * app `celld dev` cannot run at all (a Vite virtual `main`).
 */
const startCelldDevSession = async (options: CelldDevSessionOptions): Promise<CelldDevSession> => {
    const { log, port, projectRoot } = options;
    const spawn = options.spawn ?? defaultSpawn;

    if (await accepts(port)) {
        throw new Error(`port ${String(port)} is already in use — stop whatever is serving there (another dev server?), or pick another worker port`);
    }

    const app = planCelldConfig(projectRoot, "dev");

    app.write();

    const root = dirname(app.configPath);
    // Two keys may bind two entrypoints of one Worker: it registers once.
    const services = [...new Map(readServiceBindings(projectRoot).services.map((service) => [service.wranglerPath, service])).values()];

    const run = async (configPath: string, source: string): Promise<Running> =>
        startCelldDev({
            configPath,
            cwd: projectRoot,
            log: (line) => {
                log(line, source);
            },
            port,
            spawn,
        });

    const register = async (worker: string): Promise<void> => {
        const service = services.find((candidate) => candidate.worker === worker);

        if (service === undefined) {
            return;
        }

        const projected = planCelldServiceConfig(root, service.wranglerPath);

        projected.write();
        log(`registering service ${service.worker} in the local dev state`, "app");

        const registration = await run(projected.configPath, service.worker);

        await registration.stop();
    };

    for (const service of services) {
        // eslint-disable-next-line no-await-in-loop -- one registration at a time, on one port
        await register(service.worker);
    }

    let settleExited: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        settleExited = resolve;
    });

    const runApp = async (): Promise<Running> => {
        const started = await run(app.configPath, "app");

        started.crashed.then(settleExited).catch(() => undefined);

        return started;
    };

    let running = await runApp();

    const restartNow = async (worker: string): Promise<void> => {
        await running.stop();

        try {
            await register(worker);
        } finally {
            // The app comes back even when the service did not, so only the service's error surfaces.
            running = await runApp();
        }
    };

    // Serialised: a burst of saves restarts one at a time, never two at once.
    let queue: Promise<void> = Promise.resolve();

    const restartService = async (worker: string): Promise<void> => {
        const restart = queue.then(async () => restartNow(worker));

        queue = restart.catch(() => undefined);

        await restart;
    };

    const watchers = services.map((service) =>
        watchSourceChanges(dirname(service.wranglerPath), () => {
            log(`service ${service.worker} changed — restarting`, "app");
            restartService(service.worker).catch((error: unknown) => {
                log(`service ${service.worker} failed to restart: ${error instanceof Error ? error.message : String(error)}`, "app");
            });
        }),
    );

    const closeWatchers = (): void => {
        for (const watcher of watchers) {
            watcher.close();
        }
    };

    // A crashed app leaves nothing to restart, and open watchers would keep the process alive.
    exited.then(closeWatchers).catch(() => undefined);

    return {
        exited,
        restartService,
        stop: async () => {
            closeWatchers();

            await queue;
            await running.stop();
        },
    };
};

export type { CelldDevSession, CelldDevSessionOptions, CelldSpawner };
export { startCelldDevSession };
