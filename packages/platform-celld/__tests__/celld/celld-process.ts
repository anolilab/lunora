/**
 * Starting and stopping `celld dev` for the `celld` vitest project.
 *
 * The binary is `LUNORA_CELLD_BIN`, or `celld` on `PATH`. celld bundles a
 * worker with the `esbuild` it finds on `PATH`, which is pointed at this
 * package's own devDependency.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".bin");

/** How long a node gets to flush and exit on SIGTERM before it is killed. */
const GRACE_MS = 10_000;

/** A running `celld dev` node. */
type CelldDev = {
    /** The node's accumulated stdout + stderr, for failure messages. */
    readonly output: () => string;
    readonly process: ChildProcess;
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
 * Start `celld dev` on `projectDirectory` from a clean local state, and
 * resolve once its worker answers — a worker built for these tests serves
 * a 404 off its routes, which is all readiness needs.
 * @throws when the node exits first or does not serve within `deadlineMs`.
 */
const startCelldDev = async (projectDirectory: string, deadlineMs = 90_000): Promise<CelldDev> => {
    const port = await freePort();
    const url = `http://127.0.0.1:${String(port)}`;
    const child = spawn(process.env.LUNORA_CELLD_BIN ?? "celld", ["dev", projectDirectory, "--port", String(port), "--clean", "--no-watch"], {
        env: celldEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });

    const deadline = Date.now() + deadlineMs;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`celld exited before serving (code ${String(child.exitCode)}):\n${output}`);
        }

        try {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await fetch(`${url}/ready`);

            return { output: () => output, process: child, url };
        } catch {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await pause(250);
        }
    }

    throw new Error(`celld did not serve within ${String(deadlineMs)} ms:\n${output}`);
};

/**
 * Stop a celld process and resolve once it has exited. Removing its state
 * directory before then races the node's shutdown flush, which is still
 * writing there (`ENOTEMPTY` on CI).
 */
const stopCelld = async (child: ChildProcess | undefined): Promise<void> => {
    if (child?.exitCode !== null || child.signalCode !== null) {
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
    await stopCelld(node?.process);
    await rm(join(projectDirectory, ".celld"), { force: true, recursive: true });
};

export type { CelldDev };
export { celldEnvironment, freePort, pause, startCelldDev, stopCelld, stopCelldDev };
