/**
 * The `@lunora/platform` and `@lunora/shard-engine` conformance suites, run
 * against a live single-node celld fleet.
 *
 * `celld dev` boots `tck-worker.ts` with its own local object store. Each leg
 * is one vitest `it` here that asks the worker to run that leg inside a fresh
 * cell (see `tck-worker.ts`), so a red leg reads exactly like a red leg in the
 * workerd run. Legs the suites skip for a host that lacks a hook (recycle
 * simulation, a SchedulerHost, a terminal dispose) are skipped here too, with
 * the suite's own reason.
 *
 * The binary is `LUNORA_CELLD_BIN`, or `celld` on `PATH`. celld bundles the
 * worker with the `esbuild` it finds on `PATH`, which this file points at the
 * package's own devDependency.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Factories } from "./tck-legs";
import { collectLegs } from "./tck-legs";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_BIN = join(HARNESS_DIR, "..", "..", "node_modules", ".bin");

type LegResult = { message?: string; status: "failed" | "passed" | "skipped" };

/** Collection never calls a factory; the worker supplies the real ones. */
const unusedFactories = {
    engine: () => {
        throw new Error("collected, not run");
    },
    platform: () => {
        throw new Error("collected, not run");
    },
} as unknown as Factories;

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

/** One `celld dev` node for the whole file, serving `tck-worker.ts`. */
const fleet = { output: "", origin: "", process: undefined as ChildProcess | undefined };

const waitUntilServing = async (deadline: number): Promise<void> => {
    while (Date.now() < deadline) {
        if (fleet.process?.exitCode !== null) {
            throw new Error(`celld exited before serving (code ${String(fleet.process?.exitCode)}):\n${fleet.output}`);
        }

        try {
            // The worker answers 404 off its two routes, which is all readiness needs.
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await fetch(`${fleet.origin}/ready`);

            return;
        } catch {
            // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
            await new Promise((resolve) => {
                setTimeout(resolve, 250);
            });
        }
    }

    throw new Error(`celld did not serve within the deadline:\n${fleet.output}`);
};

const runLeg = async (suite: "engine" | "platform", index: number): Promise<LegResult> => {
    const response = await fetch(`${fleet.origin}/leg?suite=${suite}&index=${String(index)}`);

    return response.json<LegResult>();
};

describe("celld conformance run", () => {
    beforeAll(async () => {
        const port = await freePort();

        fleet.origin = `http://127.0.0.1:${String(port)}`;
        fleet.process = spawn(process.env.LUNORA_CELLD_BIN ?? "celld", ["dev", HARNESS_DIR, "--port", String(port), "--clean", "--no-watch"], {
            env: { ...process.env, PATH: `${PACKAGE_BIN}:${process.env.PATH ?? ""}` },
            stdio: ["ignore", "pipe", "pipe"],
        });
        fleet.process.stdout?.on("data", (chunk: Buffer) => {
            fleet.output += chunk.toString();
        });
        fleet.process.stderr?.on("data", (chunk: Buffer) => {
            fleet.output += chunk.toString();
        });

        await waitUntilServing(Date.now() + 90_000);
    });

    afterAll(async () => {
        fleet.process?.kill("SIGTERM");
        await rm(join(HARNESS_DIR, ".celld"), { force: true, recursive: true });
    });

    describe.for(["platform", "engine"] as const)("%s contract suite on celld", (suite) => {
        const legs = collectLegs(suite, unusedFactories, expect).map((leg, index) => {
            return { index, name: leg.name };
        });

        it.for(legs)("$name", async ({ index }, context) => {
            expect.assertions(2);

            const result = await runLeg(suite, index);

            // A leg the suite itself skipped (a hook this host does not supply)
            // is reported as skipped here too, with the suite's reason — the
            // same outcome the workerd run shows, not a disabled test.
            context.skip(result.status === "skipped", result.message);

            expect(result.message ?? "", `leg ran inside celld and reported ${result.status}`).toBe("");
            expect(result.status).toBe("passed");
        });
    });

    describe("hibernatable sockets over a real transport", () => {
        /** Open a client on `/transport` and collect every frame it is sent. */
        const connect = async (): Promise<{ frames: string[]; socket: WebSocket }> => {
            const socket = new WebSocket(`${fleet.origin.replace("http", "ws")}/transport`);
            const frames: string[] = [];

            socket.addEventListener("message", (event) => {
                frames.push(String(event.data));
            });

            await new Promise<void>((resolve, reject) => {
                socket.addEventListener("open", () => {
                    resolve();
                });
                socket.addEventListener("error", () => {
                    reject(new Error("the /transport upgrade failed"));
                });
            });

            return { frames, socket };
        };

        const until = async (predicate: () => boolean): Promise<void> => {
            const deadline = Date.now() + 5000;

            while (!predicate() && Date.now() < deadline) {
                // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature
                await new Promise((resolve) => {
                    setTimeout(resolve, 25);
                });
            }
        };

        // The suites cannot run this leg from inside a cell: celld does not deliver
        // a frame sent on an `acceptWebSocket` socket to a peer in the same cell, so
        // the engine harness records at the send boundary instead. This is the
        // check that the frames it recorded really reach a client.
        it("delivers host sends on an accepted socket, across a wake, to every tagged peer", async () => {
            expect.assertions(4);

            const alice = await connect();
            const bob = await connect();

            try {
                await until(() => alice.frames.length > 0 && bob.frames.length > 0);

                const aliceId = alice.frames[0]?.replace("welcome:", "");

                expect(alice.frames[0]).toMatch(/^welcome:.+/u);

                alice.socket.send("hi");
                await until(() => alice.frames.length >= 3 && bob.frames.length >= 2);

                // The echo carries the id the host resolved on the WAKE, not at accept.
                expect(alice.frames).toContain(`echo:${String(aliceId)}:hi`);
                expect(alice.frames).toContain("fanout:hi");
                expect(bob.frames).toContain("fanout:hi");
            } finally {
                alice.socket.close();
                bob.socket.close();
            }
        });
    });
});
