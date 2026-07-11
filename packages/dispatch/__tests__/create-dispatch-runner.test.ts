import { describe, expect, it, vi } from "vitest";

import { createDispatchLogger } from "../src/create-dispatch-logger";
import { createDispatchRunner } from "../src/create-dispatch-runner";

const ENV = { LUNORA_ADMIN_TOKEN: "tok", LUNORA_ORIGIN_URL: "https://app.example.com/" };
const REF = { __lunoraRef: "messages:send" };

describe("createDispatchRunner", () => {
    it("pOSTs to /_lunora/scheduler/dispatch with the bearer + envelope and resolves the JSON body", async () => {
        expect.assertions(5);

        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: 1 }, { status: 200 }));
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });

        await expect(run(REF, { to: "a" }, { shardKey: "s1" })).resolves.toEqual({ ok: 1 });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example.com/_lunora/scheduler/dispatch");
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
        expect(JSON.parse(init.body as string)).toEqual({ args: { to: "a" }, functionPath: "messages:send", shardKey: "s1" });
    });

    it("resolves undefined for an empty body", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("", { status: 200 }), label: "@lunora/queue" });

        await expect(run(REF)).resolves.toBeUndefined();
    });

    it("throws a label-prefixed error on a non-ok response", async () => {
        expect.assertions(1);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("boom", { status: 500 }), label: "@lunora/workflow" });

        await expect(run(REF)).rejects.toThrow(/@lunora\/workflow: function dispatch failed \(500\): boom/);
    });

    it("preserves the dispatch endpoint's structured code/status/data on a non-ok response", async () => {
        expect.assertions(4);

        const fetchImpl = (async () =>
            Response.json({ error: { code: "BAD_REQUEST", data: { field: "to" }, message: "missing `to`" } }, { status: 400 })) as unknown as typeof fetch;
        const run = createDispatchRunner({ env: ENV, fetchImpl, label: "@lunora/queue" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; data?: unknown; message?: unknown; status?: unknown };

        expect(error.code).toBe("BAD_REQUEST");
        expect(error.status).toBe(400);
        expect(error.data).toEqual({ field: "to" });
        expect(error.message).toBe("missing `to`");
    });

    it("falls back to INTERNAL when a non-ok error body is unparseable", async () => {
        expect.assertions(2);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("<html>502</html>", { status: 502 }), label: "@lunora/queue" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; status?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.status).toBe(502);
    });

    it("throws INTERNAL for a non-JSON 200 body instead of resolving the raw text", async () => {
        expect.assertions(2);

        const run = createDispatchRunner({ env: ENV, fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }), label: "@lunora/workflow" });

        const error = (await run(REF).then(
            () => undefined,
            (error_: unknown) => error_,
        )) as { code?: unknown; message?: unknown };

        expect(error.code).toBe("INTERNAL");
        expect(error.message).toMatch(/@lunora\/workflow: function dispatch returned a non-JSON body \(200\):/);
    });

    it("requires LUNORA_ORIGIN_URL and LUNORA_ADMIN_TOKEN", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

        await expect(createDispatchRunner({ env: { LUNORA_ADMIN_TOKEN: "t" }, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow(/LUNORA_ORIGIN_URL/);
        await expect(createDispatchRunner({ env: { LUNORA_ORIGIN_URL: "https://x" }, fetchImpl, label: "@lunora/queue" })(REF)).rejects.toThrow(
            /LUNORA_ADMIN_TOKEN/,
        );
    });
});

describe("createDispatchLogger", () => {
    it("prefixes every level", () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        createDispatchLogger("[queue:email]").info("hello", 1);

        expect(spy).toHaveBeenCalledWith("[queue:email]", "hello", 1);

        spy.mockRestore();
    });
});
