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
    const companionFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('{"procedures":[]}', { status: 200 }));

    return { companionFetch, env: { ADVISOR_COMPANION: { fetch: companionFetch } }, worker: createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace }) };
};

describe("createWorker — advisor companion route", () => {
    it("forwards a bare GET to the companion binding, without the caller's credentials", async () => {
        expect.assertions(5);

        const { companionFetch, env, worker } = setup();
        const response = await worker.fetch(request(), env, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('{"procedures":[]}');
        expect(companionFetch).toHaveBeenCalledTimes(1);
        expect(companionFetch.mock.calls[0]![0].headers.get("authorization")).toBeNull();
        expect(new URL(companionFetch.mock.calls[0]![0].url).pathname).toBe("/__lunora/advisor-procedures");
    });

    it("answers a hosted Studio's cross-origin preflight and marks the response for its origin", async () => {
        expect.assertions(3);

        const { env } = setup();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, security: { cors: { allowedOrigins: ["https://studio.example"] } }, shardDO: noopNamespace });
        const preflight = await worker.fetch(
            new Request("https://app.example/__lunora/advisor-procedures", {
                headers: { "access-control-request-headers": "authorization", "access-control-request-method": "GET", origin: "https://studio.example" },
                method: "OPTIONS",
            }),
            env,
            fakeContext,
        );

        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");

        const response = await worker.fetch(
            new Request("https://app.example/__lunora/advisor-procedures", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, origin: "https://studio.example" },
            }),
            env,
            fakeContext,
        );

        expect(response.headers.get("access-control-allow-origin")).toBe("https://studio.example");
    });

    it("refuses an app route registered on the advisor path", () => {
        expect.assertions(1);

        expect(() =>
            createWorker({ adminToken: ADMIN_TOKEN, routes: { "/__lunora/advisor-procedures": () => new Response("app") }, shardDO: noopNamespace }),
        ).toThrow(/advisor endpoint/u);
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

    it("answers 403, not 404, to an unauthenticated caller when the binding is absent", async () => {
        expect.assertions(2);

        const { worker } = setup();

        // A 404 here would tell an unauthenticated caller whether a companion is bound.
        await expect(worker.fetch(request({ token: false }), {}, fakeContext)).resolves.toHaveProperty("status", 403);
        await expect(worker.fetch(request({ method: "POST", token: false }), {}, fakeContext)).resolves.toHaveProperty("status", 405);
    });

    it("forwards for a caller the adminGate admits without the root bearer (Access / named-token path)", async () => {
        expect.assertions(2);

        const companionFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('{"procedures":[]}', { status: 200 }));
        const worker = createWorker({ adminGate: () => true, adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const response = await worker.fetch(request({ token: false }), { ADVISOR_COMPANION: { fetch: companionFetch } }, fakeContext);

        expect(response.status).toBe(200);
        expect(companionFetch).toHaveBeenCalledTimes(1);
    });

    it("marks the forwarded response no-store", async () => {
        expect.assertions(1);

        const { env, worker } = setup();
        const response = await worker.fetch(request(), env, fakeContext);

        expect(response.headers.get("cache-control")).toBe("no-store");
    });
});
