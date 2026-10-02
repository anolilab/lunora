/**
 * `handle.spawn()` on the container side: start a process through the
 * runtime's native `ctx.container.exec()` and hand its streams back over RPC,
 * unbuffered. The buffered `exec` contract (`native-exec.ts`) stays as it is;
 * this is the streaming counterpart for long builds, interactive shells and
 * anything whose output is too large or too slow to collect first.
 */
import { RpcTarget } from "cloudflare:workers";

import { abortDeadline } from "../../../../shared/abort-deadline";
import type { ContainerSpawnRequest } from "../spawn";

/** The runtime's `ExecProcess`, structurally — only what a spawned process uses. */
interface NativeProcess {
    exitCode: Promise<number>;
    isPty?: boolean;
    kill: (signal?: number) => void;
    pid?: number;
    resize?: (cols: number, rows: number) => void;
    stderr: ReadableStream | null;
    stdin?: WritableStream | null;
    stdout: ReadableStream | null;
}

/** The runtime's `ctx.container.exec`, structurally. */
type NativeExec = (cmd: string[], options?: Record<string, unknown>) => Promise<NativeProcess>;

/**
 * Control half of a spawned process, returned to the caller as an RPC stub.
 * The streams travel next to it in {@link SpawnedProcess}: a stream can cross
 * RPC only once, so it is handed over directly rather than exposed through a
 * property that could be read twice.
 */
class ContainerProcessControl extends RpcTarget {
    readonly #process: NativeProcess;

    readonly #exit: Promise<number>;

    public constructor(process: NativeProcess, exit: Promise<number>) {
        super();
        this.#process = process;
        this.#exit = exit;
    }

    /** Resolves with the exit code once the process ends. */
    public async exitCode(): Promise<number> {
        return this.#exit;
    }

    /** Send `signal` (default `SIGTERM`) to the process. A no-op once it has exited. */
    public kill(signal?: number): void {
        this.#process.kill(signal);
    }

    /** Resize a PTY process's terminal. Throws for a process spawned without `pty`. */
    public resize(cols: number, rows: number): void {
        if (this.#process.isPty !== true || typeof this.#process.resize !== "function") {
            throw new TypeError("resize() needs a process spawned with `pty`");
        }

        this.#process.resize(cols, rows);
    }
}

/** What `lunoraSpawn` returns over RPC. */
interface SpawnedProcess {
    control: ContainerProcessControl;
    isPty: boolean;
    pid: number;
    /** `null` under `pty`, where stderr is merged into the terminal output. */
    stderr: ReadableStream<Uint8Array> | null;
    /** A writable stdin when the request asked for `stdin: true`, else `null`. */
    stdin: WritableStream<Uint8Array> | null;
    stdout: ReadableStream<Uint8Array> | null;
}

/**
 * Start `request.command` and return its streams plus a control stub.
 * `release` is called exactly once, when the process exits: the caller counts
 * the process in flight until then, so `sleepAfter` cannot stop the container
 * under it. A `timeoutMs` kills the process when it elapses.
 */
const spawnNative = async (
    exec: NativeExec,
    request: ContainerSpawnRequest,
    startEnv: Readonly<Record<string, string>>,
    release: () => void,
): Promise<SpawnedProcess> => {
    const pty = request.pty === undefined ? undefined : { cols: request.pty.cols ?? 80, rows: request.pty.rows ?? 24 };
    let process: NativeProcess;

    try {
        process = await exec([request.command, ...(request.args ?? [])], {
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            // A native exec process does not inherit the container's start env.
            env: { ...startEnv, ...request.env },
            ...(pty === undefined ? { stderr: "pipe" } : { pty }),
            ...(request.stdin === undefined || request.stdin === false ? {} : { stdin: request.stdin === true ? "pipe" : request.stdin }),
            stdout: "pipe",
        });
    } catch (error) {
        release();

        throw error;
    }

    const deadline = abortDeadline(
        undefined,
        request.timeoutMs,
        () => new DOMException(`spawn timed out after ${String(request.timeoutMs)}ms`, "TimeoutError"),
    );

    deadline.signal?.addEventListener("abort", () => {
        process.kill();
    });

    const exit = process.exitCode.finally(() => {
        deadline.dispose();
        release();
    });

    // The caller may never ask for the exit code; keep a failed process from
    // surfacing as an unhandled rejection in the Durable Object.
    exit.catch(() => undefined);

    return {
        control: new ContainerProcessControl(process, exit),
        isPty: process.isPty === true,
        pid: process.pid ?? -1,
        stderr: process.stderr as ReadableStream<Uint8Array> | null,
        // `null`, not `undefined`, for "no stream", as the runtime's own `ExecProcess` reports it.
        // eslint-disable-next-line unicorn/no-null -- mirrors the runtime's ExecProcess stream fields
        stdin: request.stdin === true ? ((process.stdin ?? null) as WritableStream<Uint8Array> | null) : null,
        stdout: process.stdout as ReadableStream<Uint8Array> | null,
    };
};

export type { NativeExec, SpawnedProcess };
export { ContainerProcessControl, spawnNative };
