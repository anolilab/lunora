import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkflowContext, defineWorkflow } from "@lunora/workflow";
import type { WorkflowStore } from "@visulima/workflow";
import { MemoryStore } from "@visulima/workflow";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { createNodeWorkflowHost } from "../src/node-workflow-host";
import { createNodeWorkflowStore } from "../src/node-workflow-store";

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const temporaryDirectories: string[] = [];

/**
 * Every behavioural test runs against BOTH stores.
 *
 * `MemoryStore` round-trips snapshots with `structuredClone`; the SQLite store
 * — the durable one, and the one a real deployment uses — round-trips them as
 * JSON, which is what the engine's contract actually promises. Running the
 * suite only on the in-memory store is how a `Date`, `Map` or `undefined` in a
 * workflow's params or output passes in CI and flattens in production.
 */
const STORES: { make: () => WorkflowStore; name: string }[] = [
    { make: () => new MemoryStore(), name: "MemoryStore" },
    {
        make: () => {
            const directory = mkdtempSync(join(tmpdir(), "lunora-wf-suite-"));

            temporaryDirectories.push(directory);

            return createNodeWorkflowStore(new Database(join(directory, "workflows.sqlite3")));
        },
        name: "createNodeWorkflowStore",
    },
];

describe.each(STORES)("createNodeWorkflowHost — $name", ({ make: freshStore }) => {
    afterAll(() => {
        for (const directory of temporaryDirectories) {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("runs a workflow synchronously to completion and exposes the output", async () => {
        expect.hasAssertions();

        const greet = defineWorkflow<{ name: string }, string>({
            handler: async (ctx) => {
                const prefix = await ctx.step.do("prefix", async () => "hello");

                return `${prefix} ${ctx.params.name}`;
            },
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { greet } });
        const instance = await host.bindings.greet.create({ params: { name: "world" } });
        const status = await instance.status();

        expect(status.status).toBe("complete");
        expect(status.output).toBe("hello world");
        expect(status.error).toBeUndefined();
        expect(typeof instance.id).toBe("string");
        await expect(host.bindings.greet.get(instance.id)).resolves.toMatchObject({ id: instance.id });
    });

    it("memoizes step results across a sleep-and-resume replay", async () => {
        expect.hasAssertions();

        let loadCount = 0;
        const replayed = defineWorkflow<Record<string, never>, number>({
            handler: async (ctx) => {
                const doubled = await ctx.step.do("load", async () => {
                    loadCount += 1;

                    return 21 * 2;
                });
                await ctx.step.sleep("wait", 5);

                return doubled;
            },
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { replayed } });
        const instance = await host.bindings.replayed.create({});

        const status1 = await instance.status();

        expect(status1.status).toBe("waiting");
        expect(loadCount).toBe(1);

        await sleep(15);
        await instance.resume();

        const status2 = await instance.status();

        expect(status2.status).toBe("complete");
        // The sleep suspended the run, then the engine replayed the body — the
        // recorded step result is returned without re-running the side effect.
        expect(loadCount).toBe(1);
    });

    it("supports waitForEvent + sendEvent and rejects a mismatched event", async () => {
        expect.hasAssertions();

        const poked = defineWorkflow<Record<string, unknown>, { payload: unknown; type: string }>({
            handler: async (ctx) => ctx.step.waitForEvent("ping", { type: "poke" }),
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { poked } });
        const instance = await host.bindings.poked.create({});

        const status1 = await instance.status();

        expect(status1.status).toBe("waiting");

        await expect(instance.sendEvent({ payload: "nope", type: "wrong" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        await instance.sendEvent({ payload: { n: 42 }, type: "poke" });

        const status2 = await instance.status();

        expect(status2.status).toBe("complete");
        expect(status2.output).toStrictEqual({ payload: { n: 42 }, type: "poke" });

        // A completed instance is no longer waiting — further events are rejected.
        await expect(instance.sendEvent({ payload: 1, type: "poke" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("times out a waitForEvent via resume once the timeout elapses", async () => {
        expect.hasAssertions();

        const timed = defineWorkflow<Record<string, unknown>, { payload: unknown; type: string }>({
            handler: async (ctx) => ctx.step.waitForEvent("ping", { timeout: 5, type: "poke" }),
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { timed } });
        const instance = await host.bindings.timed.create({});

        const status1 = await instance.status();

        expect(status1.status).toBe("waiting");

        await sleep(15);
        await instance.resume();

        const status2 = await instance.status();

        expect(status2.status).toBe("complete");
        // Asserted on the observable, not on key presence: a timed-out wait
        // resolves `payload` to `undefined`, and a JSON-backed store drops the
        // key entirely where `structuredClone` keeps it. Both read the same to a
        // consumer, and JSON is what the engine's contract (and Cloudflare's own
        // Workflows) actually persist.
        expect(status2.output).toMatchObject({ type: "poke" });
        expect((status2.output as { payload?: unknown }).payload).toBeUndefined();
    });

    it("maps a failed run to errored with the error message", async () => {
        expect.hasAssertions();

        const crashing = defineWorkflow<Record<string, never>, never>({
            handler: async () => {
                throw new Error("boom");
            },
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { crashing } });
        const instance = await host.bindings.crashing.create({});
        const status = await instance.status();

        expect(status.status).toBe("errored");
        expect(status.error?.name).toBe("Error");
        expect(status.error?.message).toBe("boom");
    });

    it("createBatch starts every instance", async () => {
        expect.hasAssertions();

        const double = defineWorkflow<{ value: number }, number>({
            handler: async (ctx) => ctx.params.value * 2,
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { double } });
        const instances = await host.bindings.double.createBatch([{ params: { value: 2 } }, { params: { value: 3 } }]);

        expect(instances).toHaveLength(2);
        await expect(
            Promise.all(
                instances.map(async (instance) => {
                    const status = await instance.status();

                    return status.output;
                }),
            ),
        ).resolves.toStrictEqual([4, 6]);
    });

    it("get on an unknown id reports unknown status", async () => {
        expect.hasAssertions();

        const trivial = defineWorkflow<Record<string, never>, string>({
            handler: async () => "done",
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { trivial } });
        const instance = await host.bindings.trivial.get("missing-run");

        const status = await instance.status();

        expect(status.status).toBe("unknown");
    });

    it("pause and restart are not implemented; terminate reports terminated, not unknown", async () => {
        expect.hasAssertions();

        const trivial = defineWorkflow<Record<string, never>, string>({
            handler: async () => "done",
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { trivial } });
        const instance = await host.bindings.trivial.create({});

        await expect(instance.pause()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
        await expect(instance.restart()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });

        await instance.terminate();

        const status = await instance.status();

        expect(status.status).toBe("terminated");

        // The distinction the tombstone exists for: an id that was never a run
        // still reads back as unknown.
        await expect(host.bindings.trivial.get("never-existed").then(async (missing) => missing.status())).resolves.toStrictEqual({ status: "unknown" });
    });

    it("terminate holds against an activation already in flight", async () => {
        expect.hasAssertions();

        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const slow = defineWorkflow<Record<string, never>, string>({
            handler: async (ctx) => {
                await ctx.step.waitForEvent("go", { type: "go" });

                return ctx.step.do("slow", async () => {
                    await gate;

                    return "COMPLETED-AFTER-TERMINATE";
                });
            },
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { slow } });
        const instance = await host.bindings.slow.create({});

        await expect(instance.status()).resolves.toMatchObject({ status: "waiting" });

        // Starts an activation and leaves it parked inside the step.
        const sending = instance.sendEvent({ payload: {}, type: "go" });

        await instance.terminate();

        await expect(instance.status()).resolves.toStrictEqual({ status: "terminated" });

        // Let the in-flight activation finish. Its `save` used to land after the
        // tombstone and un-terminate the run, output and all. It now finds the
        // run gone, so whether it settles or rejects is the engine's business —
        // what matters is that the terminal state holds.
        release();
        await sending.catch(() => undefined);

        await expect(instance.status()).resolves.toStrictEqual({ status: "terminated" });
    });

    it("terminating an id that was never a run writes nothing", async () => {
        expect.hasAssertions();

        const trivial = defineWorkflow<Record<string, never>, string>({
            handler: async () => "done",
        });

        const store = freshStore();
        const host = createNodeWorkflowHost({ store, workflows: { trivial } });
        const ghost = await host.bindings.trivial.get("never-existed");

        await ghost.terminate();

        // An unconditional tombstone would both misreport this as terminated and
        // leave a row behind for every id anyone ever passed to `get()`.
        await expect(ghost.status()).resolves.toStrictEqual({ status: "unknown" });
        await expect(store.load("never-existed")).resolves.toBeUndefined();
    });

    it("honours a caller-supplied instance id: one run, findable by that id", async () => {
        expect.hasAssertions();

        let runs = 0;
        const counted = defineWorkflow<Record<string, never>, number>({
            handler: async (ctx) =>
                ctx.step.do("count", async () => {
                    runs += 1;

                    return runs;
                }),
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { counted } });
        const first = await host.bindings.counted.create({ id: "my-own-id" });

        // `get` by the caller's id resolves the alias — this is the pair
        // `ctx.spawn` relies on (create({ id }), then get(id)).
        const fetched = await host.bindings.counted.get("my-own-id");

        expect(fetched.id).toBe(first.id);
        await expect(fetched.status()).resolves.toMatchObject({ output: 1, status: "complete" });

        // A retried create with the same id is the same run, not a second one.
        const retried = await host.bindings.counted.create({ id: "my-own-id" });

        expect(retried.id).toBe(first.id);
        expect(runs).toBe(1);
    });

    it("drives ctx.spawn end to end", async () => {
        expect.hasAssertions();

        const child = defineWorkflow<{ n: number }, number>({
            handler: async (ctx) => ctx.params.n * 2,
        });
        const parent = defineWorkflow<Record<string, never>, string>({
            handler: async (ctx) => {
                const handle = await ctx.spawn("child", { n: 21 });

                return handle.id;
            },
        });

        const host = createNodeWorkflowHost({ store: freshStore(), workflows: { child, parent } });
        const instance = await host.bindings.parent.create({});
        const status = await instance.status();

        // `ctx.spawn` mints its own child id and calls create({ id }) — refusing
        // the option instead of resolving it takes fan-out out entirely.
        expect(status.status).toBe("complete");

        const childInstance = await host.bindings.child.get(status.output as string);

        await expect(childInstance.status()).resolves.toMatchObject({ output: 42, status: "complete" });
    });

    it("rejects non-finite sleep durations rather than passing them to the engine", async () => {
        expect.hasAssertions();

        const durations: (number | string)[] = [Number.NaN, Number.POSITIVE_INFINITY, "1e400 ms"];
        // Without the guard these reach `context.sleep` as a wake-at of `NaN`,
        // and the run parks in `waiting` forever with nothing to explain it.
        const statuses = await Promise.all(
            durations.map(async (duration) => {
                const sleeper = defineWorkflow<Record<string, never>, string>({
                    handler: async (ctx) => {
                        await ctx.step.sleep("wait", duration);

                        return "done";
                    },
                });

                const host = createNodeWorkflowHost({ store: freshStore(), workflows: { sleeper } });
                const instance = await host.bindings.sleeper.create({});
                const status = await instance.status();

                return status.status;
            }),
        );

        expect(statuses).toStrictEqual(["errored", "errored", "errored"]);

        const untilWorkflow = defineWorkflow<Record<string, never>, string>({
            handler: async (ctx) => {
                await ctx.step.sleepUntil("wait", new Date("not a date"));

                return "done";
            },
        });

        const untilHost = createNodeWorkflowHost({ store: freshStore(), workflows: { untilWorkflow } });
        const untilInstance = await untilHost.bindings.untilWorkflow.create({});

        await expect(untilInstance.status()).resolves.toMatchObject({ status: "errored" });
    });

    it("survives a process restart when backed by the SQLite store", async () => {
        expect.hasAssertions();

        const directory = mkdtempSync(join(tmpdir(), "lunora-platform-node-workflow-"));
        const path = join(directory, "workflows.sqlite3");

        const waiter = defineWorkflow<Record<string, never>, string>({
            handler: async (ctx) => {
                const event = await ctx.step.waitForEvent<{ ok: boolean }>("await-approval", { type: "approved" });

                return event.payload.ok ? "approved" : "rejected";
            },
        });

        try {
            const firstDatabase = new Database(path);
            const first = createNodeWorkflowHost({ store: createNodeWorkflowStore(firstDatabase), workflows: { waiter } });
            const instance = await first.bindings.waiter.create({});

            await expect(instance.status()).resolves.toMatchObject({ status: "waiting" });

            firstDatabase.close();

            // A second host over the same file — the restart the MemoryStore
            // default could never survive.
            const secondDatabase = new Database(path);
            const second = createNodeWorkflowHost({ store: createNodeWorkflowStore(secondDatabase), workflows: { waiter } });
            const restored = await second.bindings.waiter.get(instance.id);

            await expect(restored.status()).resolves.toMatchObject({ status: "waiting" });

            await restored.sendEvent({ payload: { ok: true }, type: "approved" });

            await expect(restored.status()).resolves.toMatchObject({ output: "approved", status: "complete" });

            secondDatabase.close();
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("derives the WORKFLOW_* env so createWorkflowContext resolves the seam", async () => {
        expect.hasAssertions();

        const orderPipeline = defineWorkflow<{ orderId: string }, string>({
            handler: async (ctx) => `order-${ctx.params.orderId}`,
        });

        const host = createNodeWorkflowHost({ store: freshStore(), env: { EXTRA: "kept" }, workflows: { orderPipeline } });

        expect(host.env.EXTRA).toBe("kept");
        expect(host.env.WORKFLOW_ORDER_PIPELINE).toBe(host.bindings.orderPipeline);

        const workflows = createWorkflowContext(host.env, [{ binding: "WORKFLOW_ORDER_PIPELINE", exportName: "orderPipeline" }]);
        const instance = await workflows.get("orderPipeline").create({ params: { orderId: "123" } });

        const status2 = await instance.status();

        expect(status2.output).toBe("order-123");
    });

    it("rejects a value that is not a defineWorkflow result", () => {
        expect.hasAssertions();

        expect(() => createNodeWorkflowHost({ store: freshStore(), workflows: { notAWorkflow: { handler: async () => 1 } as never } })).toThrow(
            /is not a defineWorkflow result/,
        );
    });
});
