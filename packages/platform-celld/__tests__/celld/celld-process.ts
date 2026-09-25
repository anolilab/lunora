/**
 * Starting, polling and stopping celld processes for the `celld` vitest project.
 *
 * The binary is `LUNORA_CELLD_BIN`, or `celld` on `PATH`. celld bundles a
 * worker with the `esbuild` it finds on `PATH`, which is pointed at this
 * package's own devDependency.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin");

const CELLD = process.env.LUNORA_CELLD_BIN ?? "celld";

/** How long a node gets to flush and exit on SIGTERM before it is killed. */
const GRACE_MS = 10_000;

/** A running celld process and everything it has printed so far. */
type CapturedProcess = {
    readonly child: ChildProcessWithoutNullStreams;
    /** Accumulated stdout + stderr, for failure messages. */
    readonly output: () => string;
};

/** A running `celld dev` node. */
type CelldDev = CapturedProcess & {
    /** `http://127.0.0.1:<port>` */
    readonly url: string;
};

/** The environment every celld process gets: the caller's, plus esbuild on `PATH`. */
const celldEnvironment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    return { ...process.env, PATH: `${PACKAGE_BIN}:${process.env.PATH ?? ""}`, ...extra };
};

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

const pause = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Call `read` until `done` accepts its value or the deadline passes, and
 * return the last value either way — the caller's assertion reports it.
 */
const pollUntil = async <T>(read: () => Promise<T>, done: (value: T) => boolean, options: { deadlineMs: number; intervalMs?: number }): Promise<T> => {
    const deadline = Date.now() + options.deadlineMs;
    let value = await read();

    while (!done(value) && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        await pause(options.intervalMs ?? 250);
        // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
        value = await read();
    }

    return value;
};

/** Spawn celld with `args`, capturing its output. */
const spawnCaptured = (args: ReadonlyArray<string>, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CapturedProcess => {
    const child = spawn(CELLD, args, { cwd: options.cwd, env: options.env ?? celldEnvironment(), stdio: "pipe" });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });

    return { child, output: () => output };
};

/** Run one celld command to completion; resolves its output, rejects on a non-zero exit. */
const runCelld = async (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Promise<string> => {
    const { child, output } = spawnCaptured(args, { env });

    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) {
                resolve(output());
            } else {
                reject(new Error(`celld ${args.join(" ")} exited ${String(code)}:\n${output()}`));
            }
        });
    });
};

/**
 * Resolve once `url` answers — a worker built for these tests serves a 404 off
 * its routes, which is all readiness needs.
 * @throws when the process exits first or nothing answers within `deadlineMs`.
 */
const waitUntilServing = async (url: string, captured: CapturedProcess, deadlineMs: number): Promise<void> => {
    const state = await pollUntil(
        async () => {
            if (captured.child.exitCode !== null) {
                return "exited";
            }

            return fetch(`${url}/ready`).then(
                () => "serving",
                () => "starting",
            );
        },
        (value) => value !== "starting",
        { deadlineMs },
    );

    if (state !== "serving") {
        throw new Error(`celld ${state === "exited" ? "exited before serving" : `did not serve within ${String(deadlineMs)} ms`}:\n${captured.output()}`);
    }
};

/** Start `celld dev` on `projectDirectory` from a clean local state, and resolve once it serves. */
const startCelldDev = async (projectDirectory: string, deadlineMs = 90_000): Promise<CelldDev> => {
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}`;
    const captured = spawnCaptured(["dev", projectDirectory, "--port", String(port), "--clean", "--no-watch"]);

    await waitUntilServing(url, captured, deadlineMs);

    return { ...captured, url };
};

/**
 * Stop a celld process and resolve once it has exited. Removing its state
 * directory before then races the node's shutdown flush, which is still
 * writing there (`ENOTEMPTY` on CI).
 */
const stopCelld = async (child: ChildProcessWithoutNullStreams | undefined): Promise<void> => {
    if (child === undefined) {
        return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
            resolve();
        });
    });
    const timer = setTimeout(() => {
        child.kill("SIGKILL");
    }, GRACE_MS);

    child.kill("SIGTERM");
    await exited;
    clearTimeout(timer);
};

/** Stop a `celld dev` node and delete the local state it kept under `projectDirectory`. */
const stopCelldDev = async (node: CelldDev | undefined, projectDirectory: string): Promise<void> => {
    await stopCelld(node?.child);
    await rm(join(projectDirectory, ".celld"), { force: true, recursive: true });
};

export type { CapturedProcess, CelldDev };
export { celldEnvironment, freePort, pause, pollUntil, runCelld, spawnCaptured, startCelldDev, stopCelld, stopCelldDev, waitUntilServing };
