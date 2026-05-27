import { beforeEach, describe, expect, test, vi } from "vitest";

import { createWorker } from "../src/create-worker.js";
import type { ExecutionContextLike } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

interface ShardSpy {
    namespace: ShardNamespaceLike;
    /** Records the (shardKey, forwarded request) for each forward. */
    calls: { shardKey: string; request: Request }[];
    /** Override the stub response for the next call. */
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { shardKey: string; request: Request }[] = [];

    const stubFor = (shardKey: string) => ({
        fetch: async (request: Request) => {
            calls.push({ shardKey, request });

            return spy.response;
        },
    });

    const namespace: ShardNamespaceLike = {
        idFromName: (name) => ({ __name: name }),
        get: (id) => stubFor((id as { __name: string }).__name),
    };

    const spy: ShardSpy = { namespace, calls, response };

    return spy;
};

const fakeCtx: ExecutionContextLike = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
};

describe("createWorker", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    test("returns 404 for unknown paths", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/missing"), {}, fakeCtx);

        expect(res.status).toBe(404);
    });

    test("forwards POST /_cirrus/rpc to the default __root__ shard", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: { limit: 5 } }),
            }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("__root__");
        const body = await shard.calls[0]!.request.json();

        expect(body).toEqual({ functionPath: "messages:list", args: { limit: 5 } });
    });

    test("uses the envelope shardKey when provided", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, shardKey: "channel-42" }),
            }),
            {},
            fakeCtx,
        );

        expect(shard.calls[0]!.shardKey).toBe("channel-42");
    });

    test("honors defaultShardKey override", async () => {
        const worker = createWorker({ shardDO: shard.namespace, defaultShardKey: "tenant-1" });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "x:y", args: {} }),
            }),
            {},
            fakeCtx,
        );

        expect(shard.calls[0]!.shardKey).toBe("tenant-1");
    });

    test("rejects non-POST RPC requests with 405", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc"), {}, fakeCtx);

        expect(res.status).toBe(405);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    });

    test("maps malformed RPC JSON to 400", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { method: "POST", body: "{not json" }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    test("rejects missing functionPath", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { method: "POST", body: JSON.stringify({ args: {} }) }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(400);
    });

    test("forwards /_cirrus/ws upgrades to the correct shard", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const upgrade = new Request("https://app.example/_cirrus/ws?shard=channel-7", {
            headers: { Upgrade: "websocket" },
        });

        await worker.fetch(upgrade, {}, fakeCtx);

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("channel-7");
    });

    test("rejects /_cirrus/ws without upgrade header", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/ws?shard=x"), {}, fakeCtx);

        expect(res.status).toBe(426);
    });

    test("invokes custom routes before default handlers", async () => {
        const route = vi.fn(async () => new Response("hi", { status: 200 }));
        const worker = createWorker({ shardDO: shard.namespace, routes: { "/auth/callback": route } });

        const res = await worker.fetch(new Request("https://app.example/auth/callback"), {}, fakeCtx);

        expect(route).toHaveBeenCalledOnce();
        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(0);
    });

    test("prefers getByName when the namespace exposes it", async () => {
        const stub = { fetch: vi.fn(async () => new Response("via-getByName")) };
        const namespace: ShardNamespaceLike = {
            idFromName: vi.fn(),
            get: vi.fn(),
            getByName: vi.fn(() => stub),
        };

        const worker = createWorker({ shardDO: namespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "x:y", shardKey: "a" }),
            }),
            {},
            fakeCtx,
        );

        expect(namespace.getByName).toHaveBeenCalledWith("a");
        expect(namespace.idFromName).not.toHaveBeenCalled();
        expect(stub.fetch).toHaveBeenCalled();
    });
});
