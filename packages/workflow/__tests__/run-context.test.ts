import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkflowLogger, createWorkflowRunContext, createWorkflowRunner } from "../src/run-context";
import type { FunctionReference, WorkflowEventLike, WorkflowStepLike } from "../src/types";

const ref = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

const okResponse = (body: string): Response => new Response(body, { status: 200 });

describe("createWorkflowRunner", () => {
    it("pOSTs to the scheduler dispatch endpoint with the admin bearer and returns the JSON result", async () => {
        expect.assertions(6);

        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(JSON.stringify({ ok: true })));
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
        expect.assertions(1);

        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            fetchImpl: async () => okResponse(""),
        });

        await expect(run(ref("a:b"))).resolves.toBeUndefined();
    });

    it("throws on a non-ok dispatch", async () => {
        expect.assertions(1);

        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            fetchImpl: async () => new Response("boom", { status: 500 }),
        });

        await expect(run(ref("a:b"))).rejects.toThrow(/function dispatch failed \(500\): boom/);
    });

    it("requires LUNORA_ORIGIN_URL", async () => {
        expect.assertions(1);

        const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret" }, fetchImpl: async () => okResponse("") });

        await expect(run(ref("a:b"))).rejects.toThrow(/LUNORA_ORIGIN_URL/);
    });

    it("requires LUNORA_ADMIN_TOKEN", async () => {
        expect.assertions(1);

        const run = createWorkflowRunner({ env: { LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl: async () => okResponse("") });

        await expect(run(ref("a:b"))).rejects.toThrow(/LUNORA_ADMIN_TOKEN/);
    });

    it("throws when no fetch implementation is available", async () => {
        expect.assertions(1);

        // No injected fetchImpl and no global fetch → the explicit guard fires.
        // The runner captures `globalThis.fetch` at construction, so it must be
        // absent *before* `createWorkflowRunner` is called.
        const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;

        delete (globalThis as { fetch?: typeof fetch }).fetch;

        try {
            const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl: undefined });

            await expect(run(ref("a:b"))).rejects.toThrow(/no fetch implementation available/);
        } finally {
            (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
        }
    });

    it("calls the global fetch bound to globalThis (no `this`-strict 'Illegal invocation')", async () => {
        // A receiver-strict `fetch` throws unless invoked with the global as its
        // receiver. The runner captures `globalThis.fetch` at construction, so it
        // must bind it; otherwise the captured reference would call with the wrong
        // `this`. No injected fetchImpl → the bound global path is exercised.
        expect.assertions(2);

        const original = (globalThis as { fetch?: typeof fetch }).fetch;
        let boundToGlobal = false;

        const strictFetch = function strictFetch(this: unknown): Promise<Response> {
            // The strict guard rejects any receiver that is not the global; a
            // success proves the runner invoked `fetch` bound to `globalThis`.
            if (this !== globalThis) {
                throw new TypeError("Illegal invocation");
            }

            boundToGlobal = true;

            return Promise.resolve(okResponse(JSON.stringify({ ok: true })));
        } as unknown as typeof fetch;

        (globalThis as { fetch?: typeof fetch }).fetch = strictFetch;

        try {
            const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" } });

            await expect(run(ref("a:b"))).resolves.toEqual({ ok: true });
            expect(boundToGlobal).toBe(true);
        } finally {
            (globalThis as { fetch?: typeof fetch }).fetch = original;
        }
    });

    it("returns the raw text when a 200 body is not valid JSON", async () => {
        expect.assertions(1);

        const run = createWorkflowRunner({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            fetchImpl: async () => okResponse("not-json"),
        });

        await expect(run(ref("a:b"))).resolves.toBe("not-json");
    });

    it("omits an undefined shardKey from the dispatch body", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(""));
        const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl });

        await run(ref("a:b"), { x: 1 });

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(JSON.parse(init.body as string)).toStrictEqual({ args: { x: 1 }, functionPath: "a:b" });
    });

    it("defaults args to an empty object when omitted", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(""));
        const run = createWorkflowRunner({ env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" }, fetchImpl });

        await run(ref("a:b"));

        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(JSON.parse(init.body as string)).toStrictEqual({ args: {}, functionPath: "a:b" });
    });
});

describe("createWorkflowLogger", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prefixes each level with the workflow name and forwards rest args", () => {
        expect.assertions(8);

        const spies = {
            debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
            error: vi.spyOn(console, "error").mockImplementation(() => {}),
            info: vi.spyOn(console, "info").mockImplementation(() => {}),
            warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        };
        const log = createWorkflowLogger("orderPipeline");

        log.debug("d", 1);
        log.info("i", 2);
        log.warn("w", 3);
        log.error("e", 4);

        const prefix = "[workflow:orderPipeline]";

        expect(spies.debug).toHaveBeenCalledWith(prefix, "d", 1);
        expect(spies.info).toHaveBeenCalledWith(prefix, "i", 2);
        expect(spies.warn).toHaveBeenCalledWith(prefix, "w", 3);
        expect(spies.error).toHaveBeenCalledWith(prefix, "e", 4);
        expect(spies.debug).toHaveBeenCalledTimes(1);
        expect(spies.info).toHaveBeenCalledTimes(1);
        expect(spies.warn).toHaveBeenCalledTimes(1);
        expect(spies.error).toHaveBeenCalledTimes(1);
    });
});

describe("createWorkflowRunContext", () => {
    it("assembles the handler context with params, step, env, and a runner", () => {
        expect.assertions(6);

        const event: WorkflowEventLike<{ orderId: string }> = {
            instanceId: "inst-1",
            payload: { orderId: "o1" },
            timestamp: new Date(0),
            workflowName: "order-pipeline",
        };
        const step = {
            do: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
            sleep: vi.fn<(name: string, duration: number | string) => Promise<void>>(),
            sleepUntil: vi.fn<(name: string, timestamp: Date | number) => Promise<void>>(),
            waitForEvent:
                vi.fn<(name: string, options: { timeout?: number | string; type: string }) => Promise<{ payload: Readonly<unknown>; type: string }>>(),
        } as unknown as WorkflowStepLike;

        const ctx = createWorkflowRunContext({ env: { LUNORA_ORIGIN_URL: "x" }, event, exportName: "orderPipeline", step });

        expect(ctx.params).toEqual({ orderId: "o1" });
        expect(ctx.event).toBe(event);
        expect(ctx.step).toBe(step);
        expect(ctx.env).toEqual({ LUNORA_ORIGIN_URL: "x" });
        expect(typeof ctx.run).toBe("function");
        expect(typeof ctx.log.info).toBe("function");
    });
});
