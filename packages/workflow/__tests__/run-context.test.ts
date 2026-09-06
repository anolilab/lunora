import { v } from "@lunora/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { defineWorkflowEvent } from "../src/define-event";
import { defineStep } from "../src/define-step";
import { createWorkflowRunContext } from "../src/run-context";
import type { WorkflowEventLike, WorkflowStepContextLike, WorkflowStepLike } from "../src/types";

const okResponse = (body: string): Response => new Response(body, { status: 200 });

const makeStep = (): WorkflowStepLike =>
    ({
        do: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        sleep: vi.fn<(name: string, duration: number | string) => Promise<void>>(),
        sleepUntil: vi.fn<(name: string, timestamp: Date | number) => Promise<void>>(),
        waitForEvent: vi.fn<(name: string, options: { timeout?: number | string; type: string }) => Promise<{ payload: Readonly<unknown>; type: string }>>(),
    }) as unknown as WorkflowStepLike;

const makeEvent = (): WorkflowEventLike<{ orderId: string }> => {
    return {
        instanceId: "inst-1",
        payload: { orderId: "o1" },
        timestamp: new Date(0),
        workflowName: "order-pipeline",
    };
};

// The dispatch runner + logger implementations are owned and tested by
// `@lunora/dispatch`; here we only verify workflow's context assembly and that
// `ctx.run` / `ctx.log` are wired through to the shared primitives.
describe("createWorkflowRunContext", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("assembles the handler context with params, event, step, env, run, and log", () => {
        expect.assertions(6);

        const event = makeEvent();
        const step = makeStep();
        const ctx = createWorkflowRunContext({ env: { LUNORA_ORIGIN_URL: "x" }, event, exportName: "orderPipeline", step });

        expect(ctx.params).toEqual({ orderId: "o1" });
        // Not the same object reference: the payload is `decodeWire`d off the wire
        // form, so the context carries a rebuilt event with the decoded payload.
        expect(ctx.event).toEqual(event);
        expect(ctx.step).toBe(step);
        expect(ctx.env).toEqual({ LUNORA_ORIGIN_URL: "x" });
        expect(typeof ctx.run).toBe("function");
        expect(typeof ctx.log.info).toBe("function");
    });

    it("wires the fan-out primitives (ctx.parallel / ctx.spawn)", () => {
        expect.assertions(2);

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        expect(typeof ctx.parallel).toBe("function");
        expect(typeof ctx.spawn).toBe("function");
    });

    it("wires ctx.waitForEvent onto the native step API", async () => {
        expect.assertions(2);

        const step = makeStep();
        const waitForEvent = step.waitForEvent as unknown as ReturnType<typeof vi.fn>;

        waitForEvent.mockResolvedValue({ payload: { approvedBy: "u1" }, type: "order-approved" });

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step });
        const orderApproved = defineWorkflowEvent("order-approved", v.object({ approvedBy: v.string() }));

        await expect(ctx.waitForEvent(orderApproved)).resolves.toStrictEqual({ approvedBy: "u1" });
        expect(waitForEvent).toHaveBeenCalledWith("event:order-approved", expect.objectContaining({ type: "order-approved" }));
    });

    it("runs one step repeatedly in a loop, as Cloudflare's (name, type, occurrence) step identity allows", async () => {
        expect.assertions(2);

        // A loop over items reusing one step name is a documented Workflows
        // pattern: `step.count` counts the occurrences of a name within a run,
        // and each occurrence caches independently. The context must not get in
        // the way of it.
        const names: string[] = [];
        const step = {
            do: async (name: string, callback: unknown) => {
                names.push(name);

                return (callback as (context: WorkflowStepContextLike) => Promise<unknown>)({
                    attempt: 1,
                    config: {},
                    step: { count: names.filter((seen) => seen === name).length, name },
                });
            },
            sleep: async () => undefined,
            sleepUntil: async () => undefined,
            waitForEvent: async () => {
                return { payload: {}, type: "x" };
            },
        } as unknown as WorkflowStepLike;

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step });
        const processItem = defineStep("processItem", {
            args: { item: v.string() },
            handler: async (_stepContext, { item }) => `done:${item}`,
        });

        const results: string[] = [];

        for (const item of ["a", "b", "c"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: this is the loop-over-items pattern under test
            results.push(await ctx.runStep(processItem, { item }));
        }

        expect(results).toStrictEqual(["done:a", "done:b", "done:c"]);
        expect(names).toStrictEqual(["processItem", "processItem", "processItem"]);
    });

    it("spawning a workflow with no matching WORKFLOW_* binding throws a helpful error", async () => {
        expect.assertions(1);

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        await expect(ctx.spawn("imageTag")).rejects.toThrow('cannot spawn child workflow "imageTag"');
    });

    it("wires ctx.run through the shared dispatch runner (POST + workflow label on error)", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(JSON.stringify({ ok: true })));
        const ctx = createWorkflowRunContext({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            event: makeEvent(),
            exportName: "orderPipeline",
            fetchImpl,
            step: makeStep(),
        });

        await expect(ctx.run({ __lunoraRef: "payments:charge" }, { orderId: "o1" })).resolves.toEqual({ ok: true });
        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://app.example.com/_lunora/scheduler/dispatch");

        const failing = createWorkflowRunContext({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            event: makeEvent(),
            exportName: "orderPipeline",
            fetchImpl: async () => new Response("boom", { status: 500 }),
            step: makeStep(),
        });

        await expect(failing.run({ __lunoraRef: "a:b" })).rejects.toThrow(/@lunora\/workflow: function dispatch failed \(500\): boom/);
    });

    it("prefixes ctx.log with the workflow name", () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        ctx.log.info("hi", 1);

        expect(spy).toHaveBeenCalledWith("[workflow:orderPipeline]", "hi", 1);
    });
});

/**
 * A scheduled workflow's params are the scheduler's `args`: `ctx.scheduler
 * .runAfter(delay, workflows.payout, args)` encodes them (`shared/wire-codec`),
 * they ride through the SchedulerDO and Cloudflare's own durable serialisation
 * of `create({ params })`, and arrive here as `event.payload`. Decoding at the
 * READ is what makes this target symmetric with the function target, which the
 * shard decodes in its dispatch loop.
 */
describe("createWorkflowRunContext params wire codec", () => {
    /**
     * What Cloudflare hands back: the params, JSON round-tripped through durable
     * storage. Deliberately `JSON.stringify` + `JSON.parse` and not
     * `structuredClone` — modelling that hop is the whole point, and
     * `structuredClone` would carry a `Date`/`bigint` through it intact.
     */
    const throughDurableStorage = (params: unknown): Record<string, unknown> => {
        const json = JSON.stringify(encodeWire(params));

        return JSON.parse(json) as Record<string, unknown>;
    };

    const dueAt = new Date("2026-06-01T12:00:00.000Z");

    const contextFor = (payload: Record<string, unknown>): ReturnType<typeof createWorkflowRunContext> =>
        createWorkflowRunContext({
            env: {},
            event: { ...makeEvent(), payload } as unknown as WorkflowEventLike<{ orderId: string }>,
            exportName: "orderPipeline",
            step: makeStep(),
        });

    it("decodes a bigint param into a real bigint", () => {
        expect.assertions(1);

        const ctx = contextFor(throughDurableStorage({ invoiceCents: 9_007_199_254_740_993n }));

        expect(ctx.params).toStrictEqual({ invoiceCents: 9_007_199_254_740_993n });
    });

    it("decodes a Date param into a real Date rather than an ISO string", () => {
        expect.assertions(2);

        const ctx = contextFor(throughDurableStorage({ dueAt }));
        const params = ctx.params as { dueAt: unknown };

        expect(params.dueAt).toBeInstanceOf(Date);
        expect(params.dueAt).toStrictEqual(dueAt);
    });

    it("decodes ctx.event.payload too, so `params` stays a true alias of it", () => {
        expect.assertions(1);

        const ctx = contextFor(throughDurableStorage({ dueAt }));

        expect(ctx.event.payload).toStrictEqual(ctx.params);
    });

    it("leaves plain-JSON params untouched, so nothing changes for existing workflows", () => {
        expect.assertions(1);

        const plain = { attempt: 3, nested: { ok: true, tags: ["a", "b"] }, orderId: "o1" };

        expect(contextFor(plain).params).toStrictEqual(plain);
    });
});

describe("createWorkflowRunContext — undecodable params", () => {
    it("fails the instance without retrying instead of raising a bare codec error", () => {
        expect.assertions(3);

        // The params are already durable, so every retry decodes the identical
        // bytes to the identical failure. A bare `TypeError`/`RangeError` here
        // would burn the whole retry budget re-deriving that answer.
        const event = { ...makeEvent(), payload: ["$lunora.wire$", "bigint", "not-a-number"] as unknown as { orderId: string } };

        let thrown: unknown;

        try {
            createWorkflowRunContext({ env: {}, event, exportName: "orderPipeline", step: makeStep() });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).name).toBe("NonRetryableError");
        expect((thrown as Error).message).toMatch(/orderPipeline/u);
    });
});
