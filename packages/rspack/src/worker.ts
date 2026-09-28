import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { connect } from "node:net";

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

/** A running `wrangler dev`, and the handle to stop it. */
interface WorkerProcess {
    /** The port it serves on. */
    port: number;

    /** Terminate it; resolves once it has exited. */
    stop: () => Promise<void>;
}

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
const resolveWorkerPort = (projectRoot: string, explicit?: number): number => {
    if (explicit !== undefined) {
        return explicit;
    }

    const wranglerPath = findWranglerFile(projectRoot);

    if (wranglerPath !== undefined) {
        const { parsed } = readWranglerJsonc<{ dev?: { port?: unknown } }>(wranglerPath);

        if (typeof parsed?.dev?.port === "number") {
            return parsed.dev.port;
        }
    }

    return DEFAULT_WORKER_PORT;
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

/** Wire a child stream to {@link printWorkerLine}, one line at a time. */
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
    const args = ["dev", "--port", String(options.port), "--var", "WORKER_ENV:development", ...(options.wranglerArgs ?? [])];

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `wrangler` resolves from the project's node_modules/.bin via the package manager's PATH; args are fixed
    const child: ChildProcess = spawn("wrangler", args, { cwd: options.projectRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] });

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

    const stop = async (): Promise<void> =>
        new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();

                return;
            }

            child.once("exit", () => {
                resolve();
            });
            child.kill("SIGTERM");
        });

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
