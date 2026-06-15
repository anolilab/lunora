import { describe, expect, it, vi } from "vitest";

import { createWorkflowRunContext, createWorkflowRunner } from "../src/run-context";
import type { FunctionReference, WorkflowEventLike, WorkflowStepLike } from "../src/types";

const ref = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

const okResponse = (body: string): Response => new Response(body, { status: 200 });

describe("createWorkflowRunner", () => {
    it("pOSTs to the scheduler dispatch endpoint with the admin bearer and returns the JSON result", async () => {
        const fetchImpl = vi.fn(async () => okResponse(JSON.stringify({ ok: true })));
        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com/" },
            fetchImpl,
        });

        const result = await run(ref("payments:charge"), { orderId: "o1" }, { shardKey: "tenant-1" });

        expect(result).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example.com/_lunora/scheduler/dispatch");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
        expect(JSON.parse(init.body as string)).toEqual({ args: { orderId: "o1" }, functionPath: "payments:charge", shardKey: "tenant-1" });
    });

    it("returns undefined for an empty body", async () => {
        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            fetchImpl: async () => okResponse(""),
        });

        await expect(run(ref("a:b"))).resolves.toBeUndefined();
    });

    it("throws on a non-ok dispatch", async () => {
        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            fetchImpl: async () => new Response("boom", { status: 500 }),
        });

        await expect(run(ref("a:b"))).rejects.toThrow(/function dispatch failed \(500\): boom/);
    });

    it("requires LUNORA_ORIGIN_URL", async () => {
        const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret" }, fetchImpl: async () => okResponse("") });

        await expect(run(ref("a:b"))).rejects.toThrow(/LUNORA_ORIGIN_URL/);
    });

    it("requires LUNORA_ADMIN_TOKEN", async () => {
        const run = createWorkflowRunner({ env: { LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl: async () => okResponse("") });

        await expect(run(ref("a:b"))).rejects.toThrow(/LUNORA_ADMIN_TOKEN/);
    });
});

describe("createWorkflowRunContext", () => {
    it("assembles the handler context with params, step, env, and a runner", () => {
        const event: WorkflowEventLike<{ orderId: string }> = {
            instanceId: "inst-1",
            payload: { orderId: "o1" },
            timestamp: new Date(0),
            workflowName: "order-pipeline",
        };
        const step = { do: vi.fn(), sleep: vi.fn(), sleepUntil: vi.fn(), waitForEvent: vi.fn() } as unknown as WorkflowStepLike;

        const ctx = createWorkflowRunContext({ env: { LUNORA_ORIGIN_URL: "x" }, event, exportName: "orderPipeline", step });

        expect(ctx.params).toEqual({ orderId: "o1" });
        expect(ctx.event).toBe(event);
        expect(ctx.step).toBe(step);
        expect(ctx.env).toEqual({ LUNORA_ORIGIN_URL: "x" });
        expect(typeof ctx.run).toBe("function");
        expect(typeof ctx.log.info).toBe("function");
    });
});
