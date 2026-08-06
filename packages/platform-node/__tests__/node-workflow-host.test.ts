import { createWorkflowContext, defineWorkflow } from "@lunora/workflow";
import { describe, expect, it } from "vitest";

import { createNodeWorkflowHost } from "../src/node-workflow-host";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("createNodeWorkflowHost", () => {
    it("runs a workflow synchronously to completion and exposes the output", async () => {

        const greet = defineWorkflow<{ name: string }, string>({
            handler: async (ctx) => {
                const prefix = await ctx.step.do("prefix", async () => "hello");

                return `${prefix} ${ctx.params.name}`;
            },
        });

        const host = createNodeWorkflowHost({ workflows: { greet } });
        const instance = await host.bindings.greet.create({ params: { name: "world" } });
        const status = await instance.status();

        expect(status.status).toBe("complete");
        expect(status.output).toBe("hello world");
        expect(status.error).toBeUndefined();
        expect(typeof instance.id).toBe("string");
        await expect(host.bindings.greet.get(instance.id)).resolves.toMatchObject({ id: instance.id });
    });

    it("memoizes step results across a sleep-and-resume replay", async () => {

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

        const host = createNodeWorkflowHost({ workflows: { replayed } });
        const instance = await host.bindings.replayed.create({});

        expect((await instance.status()).status).toBe("waiting");
        expect(loadCount).toBe(1);

        await sleep(15);
        await instance.resume();

        expect((await instance.status()).status).toBe("complete");
        // The sleep suspended the run, then the engine replayed the body — the
        // recorded step result is returned without re-running the side effect.
        expect(loadCount).toBe(1);
    });

    it("supports waitForEvent + sendEvent and rejects a mismatched event", async () => {

        const poked = defineWorkflow<Record<string, unknown>, { payload: unknown; type: string }>({
            handler: async (ctx) => ctx.step.waitForEvent("ping", { type: "poke" }),
        });

        const host = createNodeWorkflowHost({ workflows: { poked } });
        const instance = await host.bindings.poked.create({});

        expect((await instance.status()).status).toBe("waiting");

        await expect(instance.sendEvent({ payload: "nope", type: "wrong" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

        await instance.sendEvent({ payload: { n: 42 }, type: "poke" });

        const status = await instance.status();

        expect(status.status).toBe("complete");
        expect(status.output).toStrictEqual({ payload: { n: 42 }, type: "poke" });

        // A completed instance is no longer waiting — further events are rejected.
        await expect(instance.sendEvent({ payload: 1, type: "poke" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("times out a waitForEvent via resume once the timeout elapses", async () => {

        const timed = defineWorkflow<Record<string, unknown>, { payload: unknown; type: string }>({
            handler: async (ctx) => ctx.step.waitForEvent("ping", { timeout: 5, type: "poke" }),
        });

        const host = createNodeWorkflowHost({ workflows: { timed } });
        const instance = await host.bindings.timed.create({});

        expect((await instance.status()).status).toBe("waiting");

        await sleep(15);
        await instance.resume();

        const status = await instance.status();

        expect(status.status).toBe("complete");
        expect(status.output).toStrictEqual({ payload: undefined, type: "poke" });
    });

    it("maps a failed run to errored with the error message", async () => {

        const crashing = defineWorkflow<Record<string, never>, never>({
            handler: async () => {
                throw new Error("boom");
            },
        });

        const host = createNodeWorkflowHost({ workflows: { crashing } });
        const instance = await host.bindings.crashing.create({});
        const status = await instance.status();

        expect(status.status).toBe("errored");
        expect(status.error?.name).toBe("Error");
        expect(status.error?.message).toBe("boom");
    });

    it("createBatch starts every instance", async () => {

        const double = defineWorkflow<{ value: number }, number>({
            handler: async (ctx) => ctx.params.value * 2,
        });

        const host = createNodeWorkflowHost({ workflows: { double } });
        const instances = await host.bindings.double.createBatch([{ params: { value: 2 } }, { params: { value: 3 } }]);

        expect(instances).toHaveLength(2);
        await expect(Promise.all(instances.map(async (instance) => (await instance.status()).output))).resolves.toStrictEqual([4, 6]);
    });

    it("get on an unknown id reports unknown status", async () => {

        const trivial = defineWorkflow<Record<string, never>, string>({
            handler: async () => "done",
        });

        const host = createNodeWorkflowHost({ workflows: { trivial } });
        const instance = await host.bindings.trivial.get("missing-run");

        expect((await instance.status()).status).toBe("unknown");
    });

    it("pause and restart are not implemented; terminate ends the run", async () => {

        const trivial = defineWorkflow<Record<string, never>, string>({
            handler: async () => "done",
        });

        const host = createNodeWorkflowHost({ workflows: { trivial } });
        const instance = await host.bindings.trivial.create({});

        await expect(instance.pause()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
        await expect(instance.restart()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });

        await instance.terminate();

        // Terminate is emulated as a store delete, so the run becomes unknown
        // rather than reporting the terminated status the Cloudflare host uses.
        expect((await instance.status()).status).toBe("unknown");
    });

    it("derives the WORKFLOW_* env so createWorkflowContext resolves the seam", async () => {

        const orderPipeline = defineWorkflow<{ orderId: string }, string>({
            handler: async (ctx) => `order-${ctx.params.orderId}`,
        });

        const host = createNodeWorkflowHost({ env: { EXTRA: "kept" }, workflows: { orderPipeline } });

        expect(host.env.EXTRA).toBe("kept");
        expect(host.env.WORKFLOW_ORDER_PIPELINE).toBe(host.bindings.orderPipeline);

        const workflows = createWorkflowContext(host.env, [{ binding: "WORKFLOW_ORDER_PIPELINE", exportName: "orderPipeline" }]);
        const instance = await workflows.get("orderPipeline").create({ params: { orderId: "123" } });

        expect((await instance.status()).output).toBe("order-123");
    });

    it("rejects a value that is not a defineWorkflow result", () => {

        expect(() => createNodeWorkflowHost({ workflows: { notAWorkflow: { handler: async () => 1 } as never } })).toThrow(
            /is not a defineWorkflow result/,
        );
    });
});
