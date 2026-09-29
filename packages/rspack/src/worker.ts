import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve as resolvePath } from "node:path";

import { formatLunoraEvent, lunoraLine } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

/**
 * Port the Worker serves on when nothing pins one. Wrangler's own default, and
 * what every Lunora scaffold writes into `.dev.vars` origins.
 */
const DEFAULT_WORKER_PORT = 8787;

/** How long to wait for `wrangler dev` to accept connections before giving up. */
const READY_TIMEOUT_MS = 30_000;

/** Gap between readiness probes. */
const READY_POLL_MS = 150;

/** How long a terminating worker gets before SIGKILL. */
const STOP_ESCALATION_MS = 5000;

/** A running `wrangler dev`, and the handle to stop it. */
interface WorkerProcess {
    /** The port it serves on. */
    port: number;

    /** Terminate it; resolves once it has exited. */
    stop: () => Promise<void>;
}

/** The slice of a wrangler config this module reads. */
interface WranglerSlice {
    assets?: { directory?: unknown };
    dev?: { port?: unknown };
    env?: Record<string, { assets?: { directory?: unknown } } | undefined>;
}

/** The value of `--name value`, `--name=value` or `-n value` in `args`, last one winning, as a CLI parser reads it. */
const flagValue = (args: ReadonlyArray<string>, long: string, short: string): string | undefined => {
    let value: string | undefined;

    for (const [index, argument] of args.entries()) {
        if (argument.startsWith(`${long}=`)) {
            value = argument.slice(long.length + 1);
        } else if ((argument === long || argument === short) && index + 1 < args.length) {
            value = args[index + 1];
        }
    }

    return value;
};

/**
 * The wrangler config `wrangler dev` will actually load, given the arguments it
 * is spawned with: `--config`/`-c` picks the file (relative to the project), and
 * `--env`/`-e` the environment block — so what is read here is what wrangler
 * reads, not the default file next to a project that points somewhere else.
 */
const readWranglerTarget = (
    projectRoot: string,
    wranglerArgs: ReadonlyArray<string> = [],
): { config: WranglerSlice; env?: string; path: string } | undefined => {
    const explicit = flagValue(wranglerArgs, "--config", "-c");
    const path = explicit === undefined ? findWranglerFile(projectRoot) : resolvePath(projectRoot, explicit);

    if (path === undefined) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerSlice>(path);

    return parsed === undefined ? undefined : { config: parsed, env: flagValue(wranglerArgs, "--env", "-e"), path };
};

/**
 * The port the Worker should serve on: an explicit option, then the wrangler
 * config's `dev.port`, then {@link DEFAULT_WORKER_PORT}.
 *
 * Deliberately NOT a free-port search. `lunora dev` does search, and needs ~100
 * lines to reconcile the result against `.dev.vars` origins that pin 8787 — a
 * moving port would leave `AUTH_URL` and friends pointing at nothing. A plugin
 * that picks one deterministic port has no such problem, and a port already in
 * use surfaces as wrangler's own clear error rather than a silent relocation.
 */
const resolveWorkerPort = (projectRoot: string, explicit?: number, wranglerArgs?: ReadonlyArray<string>): number => {
    if (explicit !== undefined) {
        return explicit;
    }

    // `dev` is top-level only in wrangler — an `env` block cannot override it.
    const port = readWranglerTarget(projectRoot, wranglerArgs)?.config.dev?.port;

    return typeof port === "number" ? port : DEFAULT_WORKER_PORT;
};

/**
 * Create the wrangler config's `assets.directory` when it does not exist yet.
 *
 * `wrangler dev` refuses to start without it, and under Rsbuild it is normally
 * absent: the dev server serves the client from memory, and the directory is the
 * gitignored build output — so a fresh clone of any app that binds assets would
 * die here before its first `rsbuild build`. An empty directory is exactly what
 * the Worker should see in dev; the dev server, not wrangler, serves the client.
 */
const ensureAssetsDirectory = (projectRoot: string, wranglerArgs?: ReadonlyArray<string>): void => {
    const target = readWranglerTarget(projectRoot, wranglerArgs);

    if (target === undefined) {
        return;
    }

    // An `--env` block's own `assets` replaces the top-level one.
    const envAssets = target.env === undefined ? undefined : target.config.env?.[target.env]?.assets;
    const directory = (envAssets ?? target.config.assets)?.directory;

    if (typeof directory === "string") {
        // Relative to the config file, as wrangler resolves it.
        mkdirSync(resolvePath(dirname(target.path), directory), { recursive: true });
    }
};

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

/**
 * Print a worker output line, routing Lunora's structured events through the
 * shared formatter so `ctx.log.*` calls and RPC dispatch summaries read the same
 * here as under `lunora dev`. Anything else passes through untouched — wrangler's
 * own startup banner and errors are worth seeing verbatim.
 */
const printWorkerLine = (line: string): void => {
    const event = formatLunoraEvent(line);

    if (event === undefined) {
        if (line.trim() !== "") {
            // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
            console.log(line);
        }

        return;
    }

    const text = lunoraLine(event.text);

    if (event.level === "error") {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.error(text);
    } else if (event.level === "warn") {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.warn(text);
    } else {
        // eslint-disable-next-line no-console -- dev-server passthrough of the worker's own output
        console.info(text);
    }
};

/**
 * Wire a child stream to {@link printWorkerLine}, one line at a time.
 *
 * The remainder after the last newline is flushed on `end`. Wrangler's final
 * error before it dies frequently has no trailing newline, and dropping it left
 * the developer with only `wrangler dev exited with code 1 before it was ready`
 * — the opposite of what the actionable-error handling below is for.
 */
const pipeLines = (stream: NodeJS.ReadableStream | null): void => {
    let buffered = "";

    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
        buffered += chunk;

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        for (const line of lines) {
            printWorkerLine(line);
        }
    });
    stream?.once("end", () => {
        if (buffered !== "") {
            printWorkerLine(buffered);
            buffered = "";
        }
    });
};

interface StartWorkerOptions {
    /** Port to serve on. */
    port: number;

    /** Absolute project root; the child's cwd. */
    projectRoot: string;

    /** Extra arguments appended to `wrangler dev`. */
    wranglerArgs?: ReadonlyArray<string>;
}

/**
 * Spawn `wrangler dev` and resolve once it accepts connections.
 *
 * Waiting for readiness is what makes the proxy injected alongside it safe: the
 * dev server starts accepting browser traffic the moment this resolves, and a
 * request proxied to a port nothing listens on fails outright rather than
 * retrying — so the first page load would otherwise race the Worker's boot.
 *
 * `--var WORKER_ENV:development` flags the deployment as development so the
 * runtime streams RPC dispatch summaries and keeps argument/error detail
 * unredacted — the same flag `lunora dev` passes.
 */
const startWorker = async (options: StartWorkerOptions): Promise<WorkerProcess> => {
    // Before spawning, not after. `accepts()` cannot tell OUR worker from anyone
    // else's, so a port already held — an orphaned wrangler, a second
    // `rsbuild dev`, `lunora dev` in another terminal — would satisfy the
    // readiness poll on its first iteration. The dev server would then proxy
    // `/_lunora/*` to a foreign process while the wrangler spawned here quietly
    // died of "port in use", and the session would look perfectly healthy.
    if (await accepts(options.port)) {
        throw new Error(
            `could not start the worker: port ${String(options.port)} is already in use. Stop whatever is serving there (another \`rsbuild dev\` or \`lunora dev\`?), or set \`workerPort\`.`,
        );
    }

    ensureAssetsDirectory(options.projectRoot, options.wranglerArgs);

    const args = ["dev", "--port", String(options.port), "--var", "WORKER_ENV:development", ...(options.wranglerArgs ?? [])];
    // Package managers install `wrangler.cmd` on Windows, and Node will not launch
    // a `.cmd` shim without a shell — the failure surfaces as ENOENT, telling the
    // developer wrangler is not installed when it is. Argv stays fixed either way:
    // the port is a number and `wranglerArgs` is the project's own config.
    const isWindows = process.platform === "win32";

    const child: ChildProcess = spawn(isWindows ? "wrangler.cmd" : "wrangler", args, {
        cwd: options.projectRoot,
        shell: isWindows,
        stdio: ["ignore", "pipe", "pipe"],
    });

    pipeLines(child.stdout);
    pipeLines(child.stderr);

    // A `ChildProcess` with no `error` listener THROWS the event, which takes the
    // whole dev server down with a bare Node stack trace. The common cause is the
    // most boring one — wrangler not installed — so it gets a message that names
    // the fix instead.
    let spawnFailure: Error | undefined;

    child.once("error", (error: NodeJS.ErrnoException) => {
        spawnFailure =
            error.code === "ENOENT"
                ? new Error(
                      "could not start the worker: `wrangler` was not found on PATH. Add it to the project (`npm install -D wrangler`), or pass `worker: false` to run the worker yourself.",
                  )
                : error;
    });

    // Kills the child if this process goes away without `stop()` being reached —
    // a throw anywhere between the spawn and the dev server listening leaves no
    // cleanup path, and an orphaned wrangler holds the port so the NEXT run fails
    // the pre-flight check above. `exit` handlers must be synchronous, so this
    // signals rather than awaiting.
    const reapOnExit = (): void => {
        child.kill("SIGKILL");
    };

    process.once("exit", reapOnExit);

    const stop = async (): Promise<void> => {
        process.removeListener("exit", reapOnExit);

        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }

        await new Promise<void>((resolve) => {
            // Rsbuild awaits every cleanup before exiting, so a wrangler that
            // ignores SIGTERM would hang `rsbuild dev` on shutdown forever.
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

    let exited: Error | undefined;

    child.once("exit", (code) => {
        exited ??= new Error(`wrangler dev exited with code ${String(code)} before it was ready`);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        // The spawn failure is the more specific of the two — `error` and `exit`
        // both fire for an unspawnable binary — so it is reported first.
        if (spawnFailure !== undefined) {
            throw spawnFailure;
        }

        if (exited !== undefined) {
            throw exited;
        }

        // eslint-disable-next-line no-await-in-loop -- a readiness poll is sequential by definition
        if (await accepts(options.port)) {
            // Something is listening — confirm it is OUR child. The pre-flight
            // check above makes a foreign holder unlikely, but one could bind in
            // the window between them.
            if (child.exitCode !== null || child.signalCode !== null) {
                // eslint-disable-next-line no-await-in-loop -- terminal path; the loop exits on the next line
                await stop();

                throw new Error(
                    `the worker on port ${String(options.port)} is not the one this plugin started — it exited while something else took the port.`,
                );
            }

            return { port: options.port, stop };
        }

        // eslint-disable-next-line no-await-in-loop -- ditto
        await new Promise((resolve) => {
            setTimeout(resolve, READY_POLL_MS);
        });
    }

    await stop();

    throw new Error(`wrangler dev did not start listening on port ${String(options.port)} within ${String(READY_TIMEOUT_MS / 1000)}s`);
};

export type { StartWorkerOptions, WorkerProcess };
export { DEFAULT_WORKER_PORT, printWorkerLine, resolveWorkerPort, startWorker };
