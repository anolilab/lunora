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
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

import type { ServiceBindingIR } from "@lunora/codegen";
import { readServiceBindings } from "@lunora/codegen";

import type { DevProcess, DevProcessSpawner } from "../dev-process";
import { acceptsConnection, startDevProcess } from "../dev-process";
import { planCelldConfig, planCelldServiceConfig } from "./celld-config";

/** How long one `celld dev` gets to accept connections. */
const READY_TIMEOUT_MS = 60_000;

/** Quiet period after the last service file change before the restart. */
const RESTART_DEBOUNCE_MS = 200;

/** Paths under a service folder whose changes are celld's own state or build output, not source. */
const IGNORED_SEGMENTS = new Set([".celld", ".wrangler", "node_modules"]);

const PATH_SEPARATOR = /[/\\]/u;

/**
 * Where a line came from: `celld` (the app, and the session's own notices) or
 * `celld:<worker>`, and `stderr` for a session notice that reports a failure.
 */
interface CelldLineOrigin {
    stream: "stderr" | "stdout";
    tag: string;
}

interface CelldDevSessionOptions {
    /** Prints one non-empty line of the session's output. */
    log: (line: string, origin: CelldLineOrigin) => void;
    /** Port the app serves on. */
    port: number;
    projectRoot: string;
    spawn?: DevProcessSpawner;
}

interface CelldDevSession {
    /**
     * Resolves with an exit code once the app is gone without {@link CelldDevSession.stop}
     * asking: its `celld dev` crashed, or did not come back after a restart.
     */
    exited: Promise<number>;
    /** Stop watching, cut short a restart in flight, then stop the app. */
    stop: () => Promise<void>;
}

/** A free TCP port on the loopback, released before it is handed back. */
const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            server.close(() => {
                resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
        });
    });

/** Whether a changed path (relative to the watched folder) is state or output rather than source. */
const isIgnoredChange = (file: string | null): boolean => file?.split(PATH_SEPARATOR).some((segment) => IGNORED_SEGMENTS.has(segment)) === true;

/** Watch `directory`, calling `onChange` once per burst of source changes. */
const watchSourceChanges = (directory: string, onChange: () => void, onError: (error: Error) => void): { close: () => void } => {
    let timer: NodeJS.Timeout | undefined;
    const watcher: FSWatcher = watch(directory, { recursive: true }, (_event, file) => {
        if (isIgnoredChange(file)) {
            return;
        }

        clearTimeout(timer);
        timer = setTimeout(onChange, RESTART_DEBOUNCE_MS);
    });
    const close = (): void => {
        clearTimeout(timer);
        watcher.close();
    };

    // Unhandled, a watcher error (the folder removed, EMFILE) would take the host down.
    watcher.once("error", (error) => {
        close();
        onError(error);
    });

    return { close };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Start the session: register every service, run the app, then watch the
 * service folders. Resolves once the app accepts connections; rejects, with
 * nothing left running, when a service or the app cannot start — including an
 * app `celld dev` cannot run at all (a Vite virtual `main`).
 */
const startCelldDevSession = async (options: CelldDevSessionOptions): Promise<CelldDevSession> => {
    const { log, port, projectRoot } = options;
    const notice = (line: string, stream: CelldLineOrigin["stream"] = "stdout"): void => {
        log(line, { stream, tag: "celld" });
    };

    if (await acceptsConnection(port)) {
        throw new Error(`port ${String(port)} is already in use — stop whatever is serving there (another dev server?), or pick another worker port`);
    }

    const bindings = readServiceBindings(projectRoot);

    // Started without them, every `ctx.services` call would fail with no reason given.
    if (bindings.error !== undefined) {
        throw new Error(`could not read the lunora.config services: ${bindings.error}`);
    }

    const app = planCelldConfig(projectRoot, "dev");

    app.write();

    const root = dirname(app.configPath);
    // Two keys may bind two entrypoints of one Worker: it registers once.
    const services = [...new Map(bindings.services.map((service) => [service.wranglerPath, service])).values()];
    const lifetime = new AbortController();
    // A call, not a property read: it changes across every `await` in a restart.
    const stopping = (): boolean => lifetime.signal.aborted;

    const run = async (configPath: string, tag: string, onPort: number): Promise<DevProcess> =>
        startDevProcess({
            args: ["dev", configPath, "--port", String(onPort)],
            command: "celld",
            cwd: projectRoot,
            label: "celld dev",
            notFound: "`celld` was not found on PATH — install it (https://celld.dev) to run the celld target",
            // celld writes its banner and progress to stderr: its stream says
            // nothing about severity, so its lines go out as plain output.
            onLine: (line) => {
                if (line.trim() !== "") {
                    log(line, { stream: "stdout", tag });
                }
            },
            port: onPort,
            readyTimeoutMs: READY_TIMEOUT_MS,
            signal: lifetime.signal,
            spawn: options.spawn,
        });

    // On a port of its own: booting it only records the deployment, and on the
    // app's port it would answer the app's traffic while the app is down.
    const register = async (service: ServiceBindingIR): Promise<void> => {
        const projected = planCelldServiceConfig(root, service.wranglerPath);

        projected.write();
        notice(`registering service ${service.worker} in the local dev state`);

        const registration = await run(projected.configPath, `celld:${service.worker}`, await freePort());

        await registration.stop();
    };

    for (const service of services) {
        // eslint-disable-next-line no-await-in-loop -- one at a time: each writes the shared local state
        await register(service);
    }

    let settleExited: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        settleExited = resolve;
    });

    const runApp = async (): Promise<DevProcess> => {
        const started = await run(app.configPath, "celld", port);

        started.crashed.then(settleExited).catch(() => undefined);

        return started;
    };

    let running = await runApp();

    const restartNow = async (service: ServiceBindingIR): Promise<void> => {
        await running.stop();

        let registrationFailure: Error | undefined;

        try {
            await register(service);
        } catch (error: unknown) {
            registrationFailure = error instanceof Error ? error : new Error(String(error));
        }

        if (stopping()) {
            return;
        }

        // The app comes back even when the service did not; when it does not, the session is over.
        try {
            running = await runApp();
        } catch (error: unknown) {
            if (!stopping()) {
                settleExited(1);
            }

            throw error;
        }

        if (registrationFailure !== undefined) {
            throw registrationFailure;
        }
    };

    // Serialised: a burst of saves restarts one at a time, never two at once.
    let queue: Promise<void> = Promise.resolve();

    const restart = (service: ServiceBindingIR): void => {
        notice(`service ${service.worker} changed — restarting`);

        queue = queue
            .then(async () => restartNow(service))
            .catch((error: unknown) => {
                if (!stopping()) {
                    notice(`service ${service.worker} failed to restart: ${errorText(error)}`, "stderr");
                }
            });
    };

    const watchers: { close: () => void }[] = [];
    const closeWatchers = (): void => {
        for (const watcher of watchers) {
            watcher.close();
        }
    };

    try {
        for (const service of services) {
            watchers.push(
                watchSourceChanges(
                    dirname(service.wranglerPath),
                    () => {
                        restart(service);
                    },
                    (error) => {
                        notice(`stopped watching service ${service.worker}: ${error.message} — restart the dev server to pick up its edits`, "stderr");
                    },
                ),
            );
        }
    } catch (error: unknown) {
        closeWatchers();
        await running.stop();

        throw error;
    }

    // A crashed app leaves nothing to restart, and open watchers would keep the process alive.
    exited.then(closeWatchers).catch(() => undefined);

    return {
        exited,
        stop: async () => {
            lifetime.abort();
            closeWatchers();
            await queue;
            await running.stop();
        },
    };
};

export type { CelldDevSession, CelldDevSessionOptions, CelldLineOrigin };
export { startCelldDevSession };
