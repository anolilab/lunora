/**
 * The exec contract answered through the runtime's native `ctx.container.exec()`
 * rather than by the image serving `/__lunora/exec`. Pure over its inputs (the
 * bound `exec`, the request, the start env) so `LunoraContainer` only decides
 * WHEN to run it and keeps the container counted in flight while it does.
 */
import type { Container } from "@cloudflare/containers";

import { DEFAULT_EXEC_MAX_OUTPUT_BYTES } from "../exec";

/** The runtime's `ctx.container.exec`. */
type ContainerExec = NonNullable<ConstructorParameters<typeof Container>[0]["container"]>["exec"];

/** The `{ args, command, cwd, env, maxOutputBytes, timeoutMs }` body `execViaFetch` POSTs. */
interface ExecRequestBody {
    args?: string[];
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    maxOutputBytes?: number;
    timeoutMs?: number;
}

/**
 * Start the process and read both streams under the output cap. Native exec
 * processes do not inherit the container's startup env (only `PATH`), so the
 * start env is passed explicitly, with the per-call `env` over it — what the
 * contract promises. Neither an `AbortSignal` nor `kill()` may reach a process
 * that has already exited (the runtime raises an uncaught error), so the timeout
 * and the overflow both go through one guarded kill instead. stdout and stderr
 * share one `maxOutputBytes` budget, and the first chunk past it stops both.
 */
const collect = async (exec: ContainerExec, body: ExecRequestBody, startEnv: Readonly<Record<string, string>>, label: string): Promise<Response> => {
    const limit = body.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
    const process = await exec([body.command, ...(body.args ?? [])], {
        ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
        env: { ...startEnv, ...body.env },
        stderr: "pipe",
        stdout: "pipe",
    });
    const readers = new AbortController();
    let exited = false;
    // An object, not two `let`s: the flags are set from the timer and the
    // readers, which control-flow narrowing cannot see.
    const outcome = { overflowed: false, timedOut: false };
    const hasTimedOut = (): boolean => outcome.timedOut;
    const exitCode = process.exitCode.finally(() => {
        exited = true;
    });
    const stop = (): void => {
        readers.abort();

        if (!exited) {
            exited = true;
            process.kill();
        }
    };
    const timer =
        body.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  outcome.timedOut = true;
                  stop();
              }, body.timeoutMs);
    // stdout and stderr share ONE budget — the cap is on the reply, which
    // carries both — so the first chunk past it stops both and the process.
    let used = 0;
    const read = async (stream: ReadableStream | null): Promise<string> => {
        if (stream === null) {
            return "";
        }

        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        const onAbort = (): void => {
            reader.cancel().catch(() => undefined);
        };
        let text = "";

        readers.signal.addEventListener("abort", onAbort);

        try {
            while (!readers.signal.aborted) {
                // eslint-disable-next-line no-await-in-loop -- chunks are read in order
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                used += value.byteLength;

                if (used > limit) {
                    outcome.overflowed = true;
                    stop();
                    break;
                }

                text += decoder.decode(value, { stream: true });
            }

            return text + decoder.decode();
        } finally {
            readers.signal.removeEventListener("abort", onAbort);
            reader.cancel().catch(() => undefined);
        }
    };

    try {
        const [stdout, stderr] = await Promise.allSettled([read(process.stdout), read(process.stderr)]);

        if (outcome.overflowed) {
            return new Response(`container "${label}": exec output exceeded ${String(limit)} bytes; the process was killed`, { status: 413 });
        }

        if (outcome.timedOut) {
            return new Response(`container "${label}": exec timed out after ${String(body.timeoutMs)}ms`, { status: 504 });
        }

        if (stdout.status === "rejected") {
            throw stdout.reason;
        }

        if (stderr.status === "rejected") {
            throw stderr.reason;
        }

        const code = await exitCode;

        // Both streams can close before the process exits, so the timer may have
        // fired (and killed it) while the exit code was pending. Re-read through a
        // call: narrowing from the check above does not see the timer's write.
        if (hasTimedOut()) {
            return new Response(`container "${label}": exec timed out after ${String(body.timeoutMs)}ms`, { status: 504 });
        }

        const document = JSON.stringify({ code, stderr: stderr.value, stdout: stdout.value });

        // JSON escaping can grow the text past the cap the client reads under.
        if (new TextEncoder().encode(document).byteLength > limit) {
            return new Response(`container "${label}": exec output exceeded ${String(limit)} bytes once encoded`, { status: 413 });
        }

        return new Response(document, { headers: { "content-type": "application/json" } });
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Answer one exec request natively: parse the contract body, run the command
 * unshelled, and reply with `{ code, stdout, stderr }` — or a 400 / 413 / 504
 * the client surfaces as a failure to run.
 */
const runNativeExec = async (exec: ContainerExec, request: Request, startEnv: Readonly<Record<string, string>>, label: string): Promise<Response> => {
    let body: ExecRequestBody;

    try {
        body = await request.json();
    } catch {
        return new Response(`container "${label}": exec body must be JSON`, { status: 400 });
    }

    if (typeof body.command !== "string" || body.command.length === 0) {
        return new Response(`container "${label}": exec requires a non-empty \`command\``, { status: 400 });
    }

    return collect(exec, body, startEnv, label);
};

export default runNativeExec;
