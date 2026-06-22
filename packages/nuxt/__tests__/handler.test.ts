import { describe, expect, it, vi } from "vitest";

import type { LunoraWorkerLike } from "../src/runtime/handler";
import { delegateToLunora, NOOP_EXECUTION_CONTEXT } from "../src/runtime/handler";

describe("delegateToLunora", () => {
    it("answers a 500 LUNORA_RUNTIME_UNAVAILABLE when the Cloudflare env is missing", async () => {
        const worker: LunoraWorkerLike = { fetch: vi.fn() };

        const response = await delegateToLunora(worker, new Request("https://app.test/_lunora/rpc"), undefined);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "LUNORA_RUNTIME_UNAVAILABLE" } });
        expect(worker.fetch).not.toHaveBeenCalled();
    });

    it("forwards the request, env, and ExecutionContext to the worker", async () => {
        const expected = new Response("ok");
        const fetch = vi.fn(() => expected);
        const request = new Request("https://app.test/_lunora/rpc", { method: "POST" });
        const env = { SHARD: {} };
        const ctx = { waitUntil: vi.fn() };

        const response = await delegateToLunora({ fetch }, request, env, ctx);

        expect(response).toBe(expected);
        expect(fetch).toHaveBeenCalledWith(request, env, ctx);
    });

    it("hands the worker a no-op ExecutionContext when none was resolved", async () => {
        const fetch = vi.fn(() => new Response());

        await delegateToLunora({ fetch }, new Request("https://app.test/_lunora/ws"), { SHARD: {} });

        expect(fetch).toHaveBeenCalledWith(expect.any(Request), { SHARD: {} }, NOOP_EXECUTION_CONTEXT);
    });
});
