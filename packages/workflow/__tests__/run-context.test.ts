import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkflowRunContext } from "../src/run-context";
import type { WorkflowEventLike, WorkflowStepLike } from "../src/types";

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
        expect(ctx.event).toBe(event);
        expect(ctx.step).toBe(step);
        expect(ctx.env).toEqual({ LUNORA_ORIGIN_URL: "x" });
        expect(typeof ctx.run).toBe("function");
        expect(typeof ctx.log.info).toBe("function");
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
