/**
 * The `handle.spawn()` contract: start a process in a named container
 * instance and stream it, rather than buffer it the way `exec` does.
 *
 * Node-safe (no runtime imports): the Durable Object half lives in
 * `do/spawn.ts`. This module owns the request shape both halves agree on and
 * turns the RPC result into a {@link ContainerProcess}.
 */

/** Per-call options for `handle.spawn()`. */
interface ContainerSpawnOptions {
    /** Arguments passed to `command`, unshelled. */
    args?: ReadonlyArray<string>;
    /** Working directory for the process. */
    cwd?: string;
    /** Extra environment for this process, merged over the container's start env. */
    env?: Readonly<Record<string, string>>;

    /**
     * Run the process on a pseudo-terminal of this size (defaults `80×24`).
     * Under a PTY, stderr is merged into `stdout` and `resize()` works — what an
     * interactive shell or a browser terminal needs.
     */
    pty?: { cols?: number; rows?: number };

    /** Kill the process when this signal aborts. */
    signal?: AbortSignal;

    /**
     * Give the process a stdin: `true` returns a writable `stdin` stream, a
     * `ReadableStream` is piped in as the process's whole input. Omitted or
     * `false` leaves stdin closed.
     */
    stdin?: ReadableStream<Uint8Array> | boolean;

    /**
     * Kill the process after this many ms. Unlike `exec`, a spawned process has
     * no default deadline: it runs until it exits, is killed, or the container
     * stops.
     */
    timeoutMs?: number;
}

/** The request `lunoraSpawn` takes over RPC. An `AbortSignal` cannot cross RPC, so it stays on the caller's side. */
interface ContainerSpawnRequest extends Omit<ContainerSpawnOptions, "args" | "env" | "signal"> {
    args?: string[];
    command: string;
    env?: Record<string, string>;
}

/** The control stub `lunoraSpawn` returns, as the caller sees it over RPC. */
interface ContainerProcessControlStub {
    exitCode: () => Promise<number>;
    kill: (signal?: number) => Promise<void> | void;
    resize: (cols: number, rows: number) => Promise<void> | void;
}

/** `lunoraSpawn`'s RPC result. */
interface SpawnResult {
    control: ContainerProcessControlStub;
    isPty: boolean;
    pid: number;
    stderr: ReadableStream<Uint8Array> | null;
    stdin: WritableStream<Uint8Array> | null;
    stdout: ReadableStream<Uint8Array> | null;
}

/**
 * A running process in a container instance, returned by `handle.spawn()`.
 *
 * The container finishes a process's output, and settles `exitCode`, only
 * while its output is being drained. Lunora drains `stdout` and `stderr` into
 * a 1 MiB buffer each, so they can be read in either order, or after awaiting
 * `exitCode`, while the stream you are not reading stays under 1 MiB. Past
 * that the process stalls until you read it: for a process that may write more
 * to one stream, read both concurrently, or cancel the one you do not need.
 */
interface ContainerProcess {
    /** Resolves with the exit code once the process ends. */
    exitCode: Promise<number>;
    /** Whether the process runs on a PTY (`spawn({ pty })`). */
    isPty: boolean;
    /** Send `signal` (default `SIGTERM`). Resolves once the signal is sent, not when the process exits. */
    kill: (signal?: number) => Promise<void>;
    /** The process id inside the container, or `-1` when the runtime does not report one. */
    pid: number;
    /** Resize the PTY. Rejects for a process spawned without `pty`. */
    resize: (cols: number, rows: number) => Promise<void>;
    /** The process's stderr, or `null` under `pty` (merged into `stdout`). */
    stderr: ReadableStream<Uint8Array> | null;
    /** The process's stdin when spawned with `stdin: true`, else `null`. */
    stdin: WritableStream<Uint8Array> | null;
    /** The process's stdout (and, under `pty`, its stderr too). */
    stdout: ReadableStream<Uint8Array> | null;
}

/** The RPC-safe request for `command` and `options`. */
const toSpawnRequest = (command: string, options: ContainerSpawnOptions): ContainerSpawnRequest => {
    if (command.length === 0) {
        throw new TypeError("spawn: `command` must be a non-empty string");
    }

    return {
        command,
        ...(options.args === undefined ? {} : { args: [...options.args] }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.pty === undefined ? {} : { pty: { ...options.pty } }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
};

/** Wrap `lunoraSpawn`'s RPC result as a {@link ContainerProcess}, wiring `signal` to `kill()`. */
const toContainerProcess = (result: SpawnResult, signal: AbortSignal | undefined): ContainerProcess => {
    const { control } = result;
    const exitCode = control.exitCode();

    if (signal !== undefined) {
        const onAbort = (): void => {
            Promise.resolve(control.kill()).catch(() => undefined);
        };

        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
            exitCode
                .finally(() => {
                    signal.removeEventListener("abort", onAbort);
                })
                .catch(() => undefined);
        }
    }

    return {
        exitCode,
        isPty: result.isPty,
        kill: async (killSignal) => {
            await control.kill(killSignal);
        },
        pid: result.pid,
        resize: async (cols, rows) => {
            await control.resize(cols, rows);
        },
        stderr: result.stderr,
        stdin: result.stdin,
        stdout: result.stdout,
    };
};

export type { ContainerProcess, ContainerProcessControlStub, ContainerSpawnOptions, ContainerSpawnRequest, SpawnResult };
export { toContainerProcess, toSpawnRequest };
