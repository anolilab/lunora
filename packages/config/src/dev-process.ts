/**
 * A dev server child process a dev tool waits on — `wrangler dev` under
 * `@lunora/rspack/rsbuild`, `celld dev` in the celld dev session: spawn it,
 * forward its output line by line, resolve once it accepts connections on its
 * port, and stop it with a SIGKILL fallback.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as spawnProcess } from "node:child_process";
import { connect } from "node:net";

/** Gap between readiness probes. */
const READY_POLL_MS = 150;

/** How long a stopping process gets before SIGKILL. */
const STOP_ESCALATION_MS = 5000;

/** Spawns the process — injectable so tests run without the binary. */
type DevProcessSpawner = (command: string, args: ReadonlyArray<string>, options: { cwd: string; shell: boolean }) => ChildProcess;

interface DevProcessOptions {
    args: ReadonlyArray<string>;
    command: string;
    cwd: string;
    /** Names the process in errors, e.g. `wrangler dev`. */
    label: string;
    /** The error when `command` is not on PATH, naming the fix. */
    notFound: string;
    /** One line of output; the remainder after the last newline is flushed when the stream ends. */
    onLine: (line: string, stream: "stderr" | "stdout") => void;
    port: number;
    readyTimeoutMs: number;
    /** Windows `.cmd` shims only launch through a shell. */
    shell?: boolean;
    /** Aborting it stops the process while it is still starting; the start then rejects. */
    signal?: AbortSignal;
    spawn?: DevProcessSpawner;
}

interface DevProcess {
    /** Resolves with the exit code when the process exits without {@link DevProcess.stop} asking it to. */
    crashed: Promise<number>;
    /** Terminate it; resolves once it has exited. */
    stop: () => Promise<void>;
}

const defaultSpawn: DevProcessSpawner = (command, args, options) =>
    spawnProcess(command, [...args], { cwd: options.cwd, shell: options.shell, stdio: ["ignore", "pipe", "pipe"] });

/** `true` once something accepts a TCP connection on `port`. */
const acceptsConnection = async (port: number): Promise<boolean> =>
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
 * Forward a child stream one line at a time. The remainder is flushed on `end`:
 * a dev server's last error before it dies often has no trailing newline, and
 * dropping it leaves only "exited with code 1".
 */
const pipeLines = (stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void => {
    let buffered = "";

    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
        buffered += chunk;

        const lines = buffered.split("\n");

        buffered = lines.pop() ?? "";

        for (const line of lines) {
            onLine(line);
        }
    });
    stream?.once("end", () => {
        if (buffered !== "") {
            onLine(buffered);
            buffered = "";
        }
    });
};

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/**
 * Spawn the process and resolve once it accepts connections on `port`; reject,
 * with the process stopped, when it cannot be spawned, exits first, or misses
 * the deadline. The caller checks the port is free beforehand: the probe cannot
 * tell this process from another one already listening there.
 */
const startDevProcess = async (options: DevProcessOptions): Promise<DevProcess> => {
    const child = (options.spawn ?? defaultSpawn)(options.command, options.args, { cwd: options.cwd, shell: options.shell === true });
    let stopping = false;
    let spawnFailure: Error | undefined;
    let exitedEarly: Error | undefined;

    pipeLines(child.stdout, (line) => {
        options.onLine(line, "stdout");
    });
    pipeLines(child.stderr, (line) => {
        options.onLine(line, "stderr");
    });

    // A `ChildProcess` with no `error` listener throws the event, taking the
    // host down with a bare stack trace; the usual cause is a missing binary.
    child.once("error", (error: NodeJS.ErrnoException) => {
        spawnFailure = error.code === "ENOENT" ? new Error(options.notFound) : error;
    });
    child.once("exit", (code) => {
        exitedEarly ??= new Error(`${options.label} exited with code ${String(code)} before it was ready`);
    });

    const crashed = new Promise<number>((resolve) => {
        child.once("exit", (code) => {
            if (!stopping) {
                resolve(code ?? 1);
            }
        });
    });

    // Kills the child if the host exits without reaching `stop()` — an orphan
    // would hold the port and fail the next run's port check. `exit` handlers
    // are synchronous, so this signals rather than awaits.
    const reapOnExit = (): void => {
        child.kill("SIGKILL");
    };

    process.once("exit", reapOnExit);

    const stop = async (): Promise<void> => {
        stopping = true;
        process.removeListener("exit", reapOnExit);

        if (hasExited(child)) {
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

    const deadline = Date.now() + options.readyTimeoutMs;

    while (Date.now() < deadline) {
        // `error` and `exit` both fire for an unspawnable binary; the spawn failure is the more specific.
        const failure = spawnFailure ?? exitedEarly;

        if (failure !== undefined) {
            process.removeListener("exit", reapOnExit);

            throw failure;
        }

        if (options.signal?.aborted === true) {
            // eslint-disable-next-line no-await-in-loop -- terminal path; the loop exits on the next line
            await stop();

            throw new Error(`${options.label} was stopped before it was ready`);
        }

        // eslint-disable-next-line no-await-in-loop -- a readiness poll is sequential by definition
        if (await acceptsConnection(options.port)) {
            // Something listens — confirm it is this child, not one that bound the port after the caller's check.
            if (hasExited(child)) {
                // eslint-disable-next-line no-await-in-loop -- terminal path; the loop exits on the next line
                await stop();

                throw new Error(
                    `the server on port ${String(options.port)} is not the ${options.label} started here — it exited while something else took the port`,
                );
            }

            return { crashed, stop };
        }

        // eslint-disable-next-line no-await-in-loop -- ditto
        await new Promise((resolve) => {
            setTimeout(resolve, READY_POLL_MS);
        });
    }

    await stop();

    throw new Error(`${options.label} did not accept connections on port ${String(options.port)} within ${String(options.readyTimeoutMs / 1000)}s`);
};

export type { DevProcess, DevProcessOptions, DevProcessSpawner };
export { acceptsConnection, startDevProcess };
