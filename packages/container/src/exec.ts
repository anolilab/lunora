/**
 * The `ctx.containers.<name>.exec` contract: a typed POST to a pinned route on
 * the container, bounded in time and memory, with "the command failed" (a
 * `code`) kept distinct from "the command could not be run" (a throw).
 *
 * Split from `client.ts` because it is a self-contained protocol with exactly
 * one dependency on the rest of the client — a handle's `fetch` — which both
 * handle factories hand it so exec inherits their cold-start retry, `.port()`
 * routing and trace propagation for free.
 */
import { LunoraError } from "@lunora/errors";

import type { AbortDeadline } from "../../../shared/abort-deadline";
import { abortDeadline } from "../../../shared/abort-deadline";
import { readCapped } from "./read-capped";

/**
 * The only thing the exec contract needs from a handle: a way to send a
 * path-relative request. Declared structurally rather than as
 * `ContainerHandle["fetch"]` so this module does not import back from
 * `client.ts`; every handle's `fetch` satisfies it.
 */
type ExecFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The `exec` method this module builds — structurally `ContainerHandle["exec"]`. */
type ContainerExec = (command: string, options?: ContainerExecOptions) => Promise<ContainerExecResult>;

/**
 * Per-call options for `ContainerHandle.exec`.
 */
interface ContainerExecOptions {
    /** Arguments passed to `command`, unshelled — the container must not concatenate them into a shell string. */
    args?: ReadonlyArray<string>;
    /** Working directory for the command, relative to the container's own root. */
    cwd?: string;
    /** Extra environment for this command only, merged over the container's env. */
    env?: Readonly<Record<string, string>>;

    /**
     * Cap on the response body, in bytes. The whole `{code,stdout,stderr}`
     * document has to be held in memory to be parsed, and a build box or job
     * runner routinely writes tens of megabytes — a single unbounded `exec`
     * that returns more than the isolate's memory limit kills the isolate and
     * every other in-flight request sharing it, not just this call. So a
     * runner that overruns the cap fails the call loudly rather than taking
     * the shard down with it; raise this (or have the runner cap its own
     * output) when a command legitimately produces more.
     *
     * Default {@link DEFAULT_EXEC_MAX_OUTPUT_BYTES} (1MB).
     */
    maxOutputBytes?: number;

    /**
     * Abort the call. Composed with {@link ContainerExecOptions.timeoutMs} when
     * both are given — whichever fires first wins.
     */
    signal?: AbortSignal;

    /**
     * Give up after this many ms. Covers the whole call — the request *and*
     * reading the response body, since `fetch` resolves on headers and a
     * runner that answers `200` and then stalls mid-body would otherwise sit
     * past the deadline. Sent to the container as well, so a well-behaved
     * runner can kill the process rather than leak it when the caller walks
     * away.
     */
    timeoutMs?: number;
}

/**
 * The outcome of a `ContainerHandle.exec` call.
 *
 * A non-zero `code` is **not** an error: a command that ran and failed is a
 * result, and the caller decides what to do with it. Only a failure to *run*
 * the command — transport, a non-2xx from the runner, an unparseable body —
 * throws.
 */
interface ContainerExecResult {
    /** Process exit code. Non-zero means the command ran and failed. */
    code: number;
    /** Everything the command wrote to stderr. */
    stderr: string;
    /** Everything the command wrote to stdout. */
    stdout: string;
}

/**
 * The route `ContainerHandle.exec` POSTs to. Namespaced under
 * `/__lunora/` so it cannot collide with an application route the container
 * already serves — the previous ad-hoc convention was a bare `/exec`, which an
 * app could plausibly own for its own purposes.
 *
 * Exported because it is a *contract*, not an implementation detail: a
 * container image has to serve exactly this route, and `@lunora/agent`'s
 * human-in-the-loop gate has to recognise it. Both had it hard-coded as a
 * second literal, which drifts silently — and on the gate's side, drift
 * un-gates model-chosen command execution.
 */
const CONTAINER_EXEC_PATH = "/__lunora/exec";

/** How much of a failed exec response body is quoted back in the thrown error. */
const EXEC_ERROR_BODY_LIMIT = 512;

/** Default cap on an exec response body. See {@link ContainerExecOptions.maxOutputBytes}. */
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1_000_000;

/** Replacement for a per-call env value quoted back out of a container's error body. */
const REDACTED_ENV_VALUE = "<redacted>";

/**
 * Strip the per-call `env` values out of text quoted back from the container.
 *
 * `exec` sends `env` — documented as "extra environment for this command only",
 * i.e. where a caller puts a token — in the request body, and a runner whose
 * error handler echoes the payload it received (the default shape of an
 * Express/Fastify 400) puts those values in its response. `toErrorBody` redacts
 * `INTERNAL` before it reaches a client, but `redacted: true` still means the
 * raw message is *logged*, landing in the durable log store and Studio Issues.
 */
const redactEnvValues = (text: string, environment: Readonly<Record<string, string>> | undefined): string => {
    if (environment === undefined) {
        return text;
    }

    let redacted = text;

    for (const value of Object.values(environment)) {
        if (value.length > 0) {
            redacted = redacted.split(value).join(REDACTED_ENV_VALUE);
        }
    }

    return redacted;
};

/**
 * Narrow an unknown parsed body to {@link ContainerExecResult}. `stdout`/`stderr`
 * default to `""` when absent — a command that wrote nothing to a stream is
 * normal, and a runner is entitled to omit the empty string. `code` has no
 * sensible default: a missing exit code means the runner did not report whether
 * the command succeeded, which is exactly the ambiguity this contract exists to
 * remove.
 */
const toExecResult = (parsed: unknown): ContainerExecResult | undefined => {
    if (parsed === null || typeof parsed !== "object") {
        return undefined;
    }

    const { code, stderr, stdout } = parsed as Record<string, unknown>;

    if (typeof code !== "number") {
        return undefined;
    }

    return {
        code,
        stderr: typeof stderr === "string" ? stderr : "",
        stdout: typeof stdout === "string" ? stdout : "",
    };
};

/**
 * Combine a caller's `signal` with a `timeoutMs` deadline. Thin wrapper over
 * `shared/abort-deadline.ts` (which carries the weak-hold rationale for why
 * this is not `AbortSignal.timeout`), supplying the exec-specific abort reason.
 */
const execDeadline = (signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortDeadline =>
    abortDeadline(signal, timeoutMs, () => new LunoraError("INTERNAL", `ctx.containers: exec timed out after ${String(timeoutMs)}ms`));

/**
 * Build `ContainerHandle.exec` over a handle's own `fetch`, so the exec
 * contract inherits every behaviour that `fetch` already has — cold-start
 * retry, `.port()` routing, pool re-picking, trace propagation. Defining it once
 * here is what stops the two handle factories drifting apart.
 */
const execViaFetch =
    (fetchFunction: ExecFetch, label: string): ContainerExec =>
    async (command, options = {}) => {
        if (typeof command !== "string" || command.length === 0) {
            throw new LunoraError("BAD_REQUEST", `${label}: exec requires a non-empty \`command\``);
        }

        const limit = options.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;

        // Checked before the command runs, not after. A cap that isn't a whole
        // positive number isn't a cap: `NaN` — the shape of
        // `Number(env.EXEC_LIMIT)` on a typo — makes every comparison false, so
        // the reader buffers the whole body, which is the isolate-terminating
        // outcome the cap exists to prevent; a negative one overflows on the
        // first byte instead.
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new LunoraError("BAD_REQUEST", `${label}: exec \`maxOutputBytes\` must be a positive whole number of bytes, got ${String(limit)}`);
        }

        const deadline = execDeadline(options.signal, options.timeoutMs);

        // The whole call, not just the fetch: `fetch` resolves on HEADERS, so
        // disposing the deadline around the request alone clears the timer
        // before the body — the half of the call most likely to stall — is even
        // read. A runner that answers `200 application/json` when it *starts*
        // the command (the natural shape for a streaming runner, and what any
        // wedged container degrades into) would then hold the shard DO open
        // indefinitely with `timeoutMs` already expired.
        try {
            const response = await fetchFunction(CONTAINER_EXEC_PATH, {
                body: JSON.stringify({
                    args: options.args ?? [],
                    command,
                    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                    ...(options.env === undefined ? {} : { env: options.env }),
                    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
                ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
            });

            if (!response.ok) {
                const quoted = await readCapped(response.body, EXEC_ERROR_BODY_LIMIT, deadline.signal).then(
                    (body) => redactEnvValues(body.text, options.env),
                    () => "<unreadable body>",
                );

                throw new LunoraError(
                    "INTERNAL",
                    `${label}: exec failed — the container answered ${String(response.status)} for POST ${CONTAINER_EXEC_PATH}. ` +
                        `Does it serve that route? Body: ${quoted}`,
                );
            }

            const body = await readCapped(response.body, limit, deadline.signal);

            if (body.overflowed) {
                throw new LunoraError(
                    "INTERNAL",
                    `${label}: exec response exceeded ${String(limit)} bytes and was abandoned — it is buffered whole to be parsed, ` +
                        `so an unbounded one would exhaust the isolate. Cap the command's output, or raise \`maxOutputBytes\`.`,
                );
            }

            let parsed: unknown;

            try {
                parsed = JSON.parse(body.text);
            } catch {
                throw new LunoraError(
                    "INTERNAL",
                    `${label}: exec response was not JSON — expected {"code","stdout","stderr"} from POST ${CONTAINER_EXEC_PATH}`,
                );
            }

            const result = toExecResult(parsed);

            if (result === undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    `${label}: exec response is missing a numeric \`code\` — expected {"code","stdout","stderr"} from POST ${CONTAINER_EXEC_PATH}`,
                );
            }

            return result;
        } finally {
            deadline.dispose();
        }
    };

export type { ContainerExecOptions, ContainerExecResult };
export { CONTAINER_EXEC_PATH, execViaFetch };
