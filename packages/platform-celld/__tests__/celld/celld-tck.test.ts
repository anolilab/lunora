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
 * The binary is `LUNORA_CELLD_BIN`, or `celld` on `PATH` (see `celld-process.ts`).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CelldDev } from "./celld-process";
import { pollUntil, startCelldDev, stopCelldDev } from "./celld-process";
import type { BindingResult } from "./tck-bindings";
import type { Factories, LegResult } from "./tck-legs";
import { collectLegs } from "./tck-legs";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/** Collection never calls a factory; the worker supplies the real ones. */
const unusedFactories = {
    engine: () => {
        throw new Error("collected, not run");
    },
    platform: () => {
        throw new Error("collected, not run");
    },
} as unknown as Factories;

/** One `celld dev` node for the whole file, serving `tck-worker.ts`. */
const fleet = { node: undefined as CelldDev | undefined, origin: "" };

const runLeg = async (suite: "engine" | "platform", index: number): Promise<LegResult> => {
    const response = await fetch(`${fleet.origin}/leg?suite=${suite}&index=${String(index)}`);

    return response.json<LegResult>();
};

describe("celld conformance run", () => {
    beforeAll(async () => {
        fleet.node = await startCelldDev(HARNESS_DIR);
        fleet.origin = fleet.node.url;
    });

    afterAll(async () => {
        await stopCelldDev(fleet.node, HARNESS_DIR);
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

    describe("binding-backed ratings, through Lunora's adapters", () => {
        const binding = async (route: string): Promise<BindingResult> => {
            const response = await fetch(`${fleet.origin}/binding/${route}`);

            return response.json<BindingResult>();
        };

        /** Poll `route` until `done` accepts its result — deliveries and runs are not instant. */
        const settle = async (route: string, done: (result: BindingResult) => boolean, deadlineMs: number): Promise<BindingResult> =>
            pollUntil(async () => binding(route), done, { deadlineMs, intervalMs: 500 });

        const run = Date.now().toString();

        it.for(["d1", "kv", "r2"])("%s runs the calls Lunora's adapter makes", async (name) => {
            expect.assertions(1);

            await expect(binding(name)).resolves.toStrictEqual({ status: "passed" });
        });

        // The consumer is the same worker that exports `fetch` — the topology a
        // Lunora app has, which celld v0.4.0 refused.
        it("redelivers a queue message whose first delivery threw, through dispatchQueueBatch", async () => {
            expect.assertions(2);

            await expect(binding(`queue/start?id=q${run}`)).resolves.toStrictEqual({ status: "passed" });

            const delivered = await settle(`queue/status?id=q${run}`, (result) => result.status !== "pending", 30_000);

            expect(delivered.value).toMatchObject({ attempts: 2 });
        });

        it("runs a workflow through step.do and waitForEvent, and refuses a rollback step at first use", async () => {
            expect.assertions(3);

            await binding(`workflow/start?id=w${run}`);

            const waiting = await settle(
                `workflow/status?id=w${run}`,
                (result) => (result.value as { status?: string } | undefined)?.status === "waiting",
                30_000,
            );

            expect(waiting.value).toMatchObject({ status: "waiting" });

            await binding(`workflow/event?id=w${run}`);

            const finished = await settle(
                `workflow/status?id=w${run}`,
                (result) => ["complete", "errored"].includes(String((result.value as { status?: string } | undefined)?.status)),
                30_000,
            );

            expect(finished.value).toMatchObject({ output: { approved: true, doubled: 42 }, status: "complete" });
            // `defineStep({ rollback })` forwards this option; celld refuses it,
            // which is why the workflows rating names it.
            expect((finished.value as { output: { rollback: string } }).output.rollback).toMatch(/^refused: .*rollback/u);
        });

        // One tick of `* * * * *` — up to a minute away.
        it("fires a cron trigger with the controller fields the scheduled handler reads", async () => {
            expect.assertions(2);

            const ticked = await settle("cron/status", (result) => result.status !== "pending", 75_000);

            expect(ticked.value).toMatchObject({ cron: "* * * * *" });
            expect((ticked.value as { scheduledTime: number }).scheduledTime % 60_000).toBe(0);
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
            await pollUntil(async () => predicate(), Boolean, { deadlineMs: 5000, intervalMs: 25 });
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
