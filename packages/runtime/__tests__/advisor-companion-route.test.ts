import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

const request = (options: { method?: string; token?: boolean } = {}): Request =>
    new Request("https://app.example/__lunora/advisor-procedures", {
        headers: options.token === false ? {} : { authorization: `Bearer ${ADMIN_TOKEN}` },
        method: options.method ?? "GET",
    });

const setup = () => {
    const companionFetch = vi.fn(async (_request: Request) => new Response('{"procedures":[]}', { status: 200 }));

    return { companionFetch, env: { ADVISOR_COMPANION: { fetch: companionFetch } }, worker: createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace }) };
};

describe("createWorker — advisor companion route", () => {
    it("forwards to the companion binding with the caller's Authorization intact", async () => {
        expect.assertions(4);

        const { companionFetch, env, worker } = setup();
        const response = await worker.fetch(request(), env, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('{"procedures":[]}');
        expect(companionFetch).toHaveBeenCalledTimes(1);
        expect(companionFetch.mock.calls[0]![0].headers.get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it("answers 404 when the binding is absent", async () => {
        expect.assertions(1);

        const { worker } = setup();

        await expect(worker.fetch(request(), {}, fakeContext)).resolves.toHaveProperty("status", 404);
    });

    it("rejects a request without the admin token (403) and does not forward", async () => {
        expect.assertions(2);

        const { companionFetch, env, worker } = setup();

        await expect(worker.fetch(request({ token: false }), env, fakeContext)).resolves.toHaveProperty("status", 403);
        expect(companionFetch).not.toHaveBeenCalled();
    });

    it("rejects a non-GET method (405) and does not forward", async () => {
        expect.assertions(2);

        const { companionFetch, env, worker } = setup();

        await expect(worker.fetch(request({ method: "POST" }), env, fakeContext)).resolves.toHaveProperty("status", 405);
        expect(companionFetch).not.toHaveBeenCalled();
    });
});
