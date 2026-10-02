/**
 * Running the plan's children: spawning with prefixed output, supervising them
 * until they exit or the user interrupts, container log streaming, and
 * teardown.
 */
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

import type { ContainerLogStreamHandle } from "@lunora/config";
import { discoverContainerInfo, formatLunoraEvent, streamContainerLogs } from "@lunora/config";

import type { CodegenWatcherHandle } from "../../util/codegen-watch";
import type { Logger } from "../../util/logger";
import { spawnShellCompat } from "../../util/spawn";
import type { StudioServerHandle } from "../../util/studio-server";
import type { WorkerProcess, WorkerSpawner } from "./types";

/** Grace period after the first SIGINT before we force-kill the worker. */
const SIGINT_GRACE_MS = 5000;

/**
 * Emit one already-split output line. A Lunora structured event
 * (`source: "lunora"`) is rewritten as a tagged, attributed `[lunora]` line at
 * its own severity; everything else passes through tagged with the child's name
 * (`[wrangler]`), stderr at warn level.
 */
const emitChildLine = (line: string, tag: string, kind: "stderr" | "stdout", logger: Logger): void => {
    if (line.length === 0) {
        return;
    }

    const formatted = formatLunoraEvent(line);

    if (formatted) {
        // `formatted.level` is exactly the `error | info | warn` union of the
        // logger's channels, so index straight into it — no branch ladder.
        logger[formatted.level](`[lunora] ${formatted.text}`);

        return;
    }

    const prefixed = `[${tag}] ${line}`;

    if (kind === "stderr") {
        logger.warn(prefixed);
    } else {
        logger.info(prefixed);
    }
};

/**
 * Pipe a child's stdout/stderr through the logger, tagged by name, recognising
 * and reformatting Lunora structured log events along the way. Output is
 * line-buffered per stream so a structured event split across two `data` chunks
 * is still parsed as one line; the trailing partial is flushed on stream end.
 */
const pipeChildOutput = (child: ChildProcess, tag: string, logger: Logger): void => {
    const pumpStream = (stream: NodeJS.ReadableStream | null, kind: "stderr" | "stdout"): void => {
        if (!stream) {
            return;
        }

        let buffer = "";

        stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");

            const lines = buffer.split("\n");

            // Keep the last element as the (possibly incomplete) pending line.
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                emitChildLine(line.trimEnd(), tag, kind, logger);
            }
        });

        stream.on("end", () => {
            emitChildLine(buffer.trimEnd(), tag, kind, logger);
            buffer = "";
        });
    };

    pumpStream(child.stdout, "stdout");
    pumpStream(child.stderr, "stderr");
};

/** Real worker spawner: runs the descriptor as a child and pipes its output through the logger. */
const defaultWorkerSpawner: WorkerSpawner = (descriptor, logger) => {
    // Windows can't spawn the package-manager .cmd shims without a shell — see
    // spawnShellCompat. POSIX passes through untouched.
    const exec = spawnShellCompat(descriptor.command, descriptor.args);
    const child = nodeSpawn(exec.command, exec.args, {
        cwd: descriptor.cwd ?? process.cwd(),
        env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
        shell: exec.shell,
        stdio: ["inherit", "pipe", "pipe"],
    });

    pipeChildOutput(child, descriptor.tag, logger);

    return {
        exited: new Promise<number>((resolve) => {
            child.on("error", (error) => {
                logger.error(`[${descriptor.tag}] failed to start: ${error.message}`);
                resolve(1);
            });
            child.on("exit", (code, signal) => {
                // A signal-killed child reports `code === null`; treat that as a
                // failure rather than a clean exit, matching `util/spawn.ts` and
                // `lifecycle.ts`. An OOM-SIGKILLed or segfaulting `wrangler dev`
                // used to make `lunora dev` exit 0, so a task runner supervising
                // it saw a crashed worker as a successful run.
                resolve(code ?? (signal ? 1 : 0));
            });
        }),
        kill: (signal) => {
            try {
                child.kill(signal);
            } catch {
                /* already gone */
            }
        },
    };
};

interface Teardown {
    codegen?: CodegenWatcherHandle;
    /** Disposer for the dev container log stream (stops polling Docker + detaches). */
    containerLogs?: ContainerLogStreamHandle;
    /** Cancels the worker readiness probe, so it stops with the server instead of on its own timeout. */
    readyProbe?: AbortController;
    /** Disposer for the materialized remote wrangler temp config (idempotent, never throws). */
    remoteCleanup?: () => void;
    studio?: StudioServerHandle;
}

/**
 * Follow the local Docker logs of every declared container and surface each
 * output line on the dev logger, tagged `[container:<name>]`. Returns a disposer
 * (or `undefined` when there are no containers, so no Docker work ever starts).
 *
 * wrangler builds + runs each declared container locally but only forwards the
 * worker's console; the container process's own stdout/stderr would otherwise be
 * invisible. Set `LUNORA_CONTAINER_LOGS=0` to opt out.
 */
const startContainerLogStreaming = (cwd: string, logger: Logger): ContainerLogStreamHandle | undefined => {
    if (process.env.LUNORA_CONTAINER_LOGS === "0") {
        return undefined;
    }

    const discovery = discoverContainerInfo(cwd, "lunora");
    const containers = discovery.containers.map((container) => {
        return { className: container.className, exportName: container.exportName };
    });

    if (containers.length === 0) {
        return undefined;
    }

    return streamContainerLogs({
        containers,
        onLine: (line) => {
            const tagged = `[container:${line.name}] ${line.text}`;

            if (line.level === "error") {
                logger.warn(tagged);
            } else {
                logger.info(tagged);
            }
        },
        onUnavailable: (message) => {
            logger.warn(`[container] Docker engine unreachable — container logs unavailable (${message})`);
        },
    });
};

/** Best-effort shutdown of the studio server, codegen watcher, container logs, and remote temp config. */
const teardown = async (handles: Teardown): Promise<void> => {
    // Idempotent second call: `runDevCommand`'s `finally` aborts before clearing
    // the state record, and this covers the paths that tear down without going
    // through it. `AbortController.abort()` on an already-aborted controller is a
    // no-op.
    handles.readyProbe?.abort();

    // Awaited: `close()` stops the watch loop immediately but resolves only once
    // a regeneration already in flight is done, and that run may have spawned
    // the project's `postcodegen`. `defineHandler` calls `process.exit` right
    // after this, so not awaiting leaves that child running, mid-write, against
    // a shell that already has its prompt back — the terminal Ctrl-C case is
    // covered by the signal reaching the whole process group, but a worker crash
    // or a SIGTERM to the daemon PID is not.
    await handles.codegen?.close().catch(() => undefined);
    handles.containerLogs?.close();
    await handles.studio?.close().catch(() => undefined);
    // Unlink the generated remote wrangler config last; the disposer is itself
    // idempotent + swallows errors, but guard the call site too for safety.
    try {
        handles.remoteCleanup?.();
    } catch {
        /* already gone */
    }
};

/**
 * Block until SIGINT/SIGTERM, then resolve 0.
 *
 * The `--no-worker` counterpart to {@link superviseWorkers}: with no child to
 * await, the process would otherwise fall out of `runDevCommand` immediately
 * and take codegen-watch and Studio down with it.
 */
const waitForInterrupt = async (logger: Logger): Promise<number> =>
    await new Promise<number>((resolve) => {
        // Held in a record so `stop` can detach both handlers without a forward
        // reference to bindings declared after it.
        const handlers: { sigint?: () => void; sigterm?: () => void } = {};

        const stop = (signal: NodeJS.Signals): void => {
            logger.info(`received ${signal} — shutting down`);

            if (handlers.sigint) {
                process.off("SIGINT", handlers.sigint);
            }

            if (handlers.sigterm) {
                process.off("SIGTERM", handlers.sigterm);
            }

            resolve(0);
        };

        const onSigint = (): void => {
            stop("SIGINT");
        };
        const onSigterm = (): void => {
            stop("SIGTERM");
        };

        handlers.sigint = onSigint;
        handlers.sigterm = onSigterm;
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
    });

/**
 * Supervise the spawned dev children until dev ends. Wires SIGINT/SIGTERM to
 * signal BOTH the framework dev server and the sidecar together (Ctrl-C once →
 * SIGTERM, again → SIGKILL; a grace timer escalates the first SIGINT), then
 * resolves when the FIRST child exits — a stopped framework dev server and a
 * crashed sidecar both mean "dev is over" — tearing the other down and awaiting
 * it so neither is orphaned holding a port. Returns that first child's exit
 * code. With no sidecar (single-process flavors) this collapses to plain
 * single-child supervision. Extracted from `runDevCommand` to keep its
 * orchestration legible (and under the cognitive-complexity budget).
 */
const superviseWorkers = async (worker: WorkerProcess, sidecar: WorkerProcess | undefined, logger: Logger): Promise<number> => {
    let sigintCount = 0;
    let escalationTimer: NodeJS.Timeout | undefined;

    const killChildren = (signal: NodeJS.Signals): void => {
        worker.kill(signal);
        sidecar?.kill(signal);
    };
    const onSigint = (): void => {
        sigintCount += 1;

        if (sigintCount === 1) {
            logger.info("received SIGINT — shutting down (press Ctrl-C again to force-kill)");
            killChildren("SIGTERM");
            escalationTimer = setTimeout(() => {
                killChildren("SIGKILL");
            }, SIGINT_GRACE_MS);
            escalationTimer.unref();
        } else {
            killChildren("SIGKILL");
        }
    };
    const onSigterm = (): void => {
        killChildren("SIGTERM");
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const first = await Promise.race([
        worker.exited.then((code) => {
            return { code, who: "worker" as const };
        }),
        ...(sidecar === undefined
            ? []
            : [
                  sidecar.exited.then((code) => {
                      return { code, who: "sidecar" as const };
                  }),
              ]),
    ]);

    if (sidecar !== undefined) {
        if (first.who === "sidecar") {
            logger.warn("[worker] the Lunora sidecar (wrangler dev) exited — shutting down the framework dev server");
            worker.kill("SIGTERM");
        } else {
            sidecar.kill("SIGTERM");
        }

        await Promise.allSettled([worker.exited, sidecar.exited]);
    }

    if (escalationTimer) {
        clearTimeout(escalationTimer);
    }

    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    return first.code;
};

export type { Teardown };
export { defaultWorkerSpawner, emitChildLine, startContainerLogStreaming, superviseWorkers, teardown, waitForInterrupt };
