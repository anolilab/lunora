import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ExecutionContextLike, HttpActionContext, HttpActionLike, HttpRouteLookup, HttpRouterLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

interface ShardSpy {
    /** Records the (shardKey, forwarded request) for each forward. */
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
    /** Override the stub response for the next call. */
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];

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

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc", { method: "POST", body: "{not json" }), {}, fakeCtx);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    test("rejects missing functionPath", async () => {
        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc", { method: "POST", body: JSON.stringify({ args: {} }) }), {}, fakeCtx);

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

        expect(route).toHaveBeenCalledTimes(1);
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
        expect(stub.fetch).toHaveBeenCalledWith();
    });

    test("forwards resolveIdentity userId on the x-cirrus-userid header", async () => {
        const worker = createWorker({
            shardDO: shard.namespace,
            resolveIdentity: () => ({ userId: "user_42" }),
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
            }),
            {},
            fakeCtx,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBe("user_42");
        expect(shard.calls[0]!.request.headers.get("x-cirrus-identity")).toBeNull();
    });

    test("omits identity headers when resolveIdentity returns null", async () => {
        const worker = createWorker({
            shardDO: shard.namespace,
            resolveIdentity: () => null,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
            }),
            {},
            fakeCtx,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBeNull();
        expect(shard.calls[0]!.request.headers.get("x-cirrus-identity")).toBeNull();
    });

    test("serialises extra identity claims as JSON on x-cirrus-identity", async () => {
        const worker = createWorker({
            shardDO: shard.namespace,
            resolveIdentity: () => ({ userId: "user_42", email: "u@example.com", roles: ["admin"] }),
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
            }),
            {},
            fakeCtx,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBe("user_42");

        const identityHeader = shard.calls[0]!.request.headers.get("x-cirrus-identity");

        expect(identityHeader).not.toBeNull();
        expect(JSON.parse(identityHeader!)).toEqual({ email: "u@example.com", roles: ["admin"] });
    });

    test("does not invoke resolveIdentity when fanOut request would 400 (no coordinator)", async () => {
        const resolveIdentity = vi.fn(() => ({ userId: "user_42" }));
        const worker = createWorker({
            shardDO: shard.namespace,
            resolveIdentity,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, fanOut: { kind: "all" } }),
            }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(400);
        expect(resolveIdentity).not.toHaveBeenCalled();
    });

    test("propagates resolved identity headers through the fan-out coordinator", async () => {
        const fanOut = vi.fn(async (_namespace, args: { headers: Record<string, string> }) => ({
            received: args.headers,
        }));

        const worker = createWorker({
            shardDO: shard.namespace,
            queryCoordinator: { fanOut: fanOut as never, registry: {} as never },
            resolveIdentity: () => ({ userId: "user_42", email: "u@example.com" }),
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, fanOut: { kind: "all" } }),
            }),
            {},
            fakeCtx,
        );

        expect(fanOut).toHaveBeenCalledTimes(1);

        const { headers } = fanOut.mock.calls[0]![1];

        expect(headers["x-cirrus-userid"]).toBe("user_42");
        expect(JSON.parse(headers["x-cirrus-identity"]!)).toEqual({ email: "u@example.com" });
    });
});

/** Minimal {@link HttpRouterLike} whose `lookup` always returns `result`. */
const fixedRouter = (result: HttpRouteLookup): HttpRouterLike => ({ lookup: () => result });

/** Router that matches `path` for `method`, else 404 — mirrors the real `httpRouter` shape. */
const oneRoute = (path: string, method: string, handler: HttpActionLike["handler"]): HttpRouterLike => ({
    lookup: (pathname, requestMethod) => pathname === path && requestMethod === method ? { action: { handler }, kind: "match" } : { kind: "not_found" },
});

describe("createWorker — HTTP actions", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    test("dispatches a matched request to the action handler and returns its Response", async () => {
        const worker = createWorker({
            httpRouter: oneRoute("/ping", "GET", () => new Response("pong", { status: 201 })),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/ping"), {}, fakeCtx);

        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe("pong");
        expect(shard.calls).toHaveLength(0);
    });

    test("ctx.runMutation forwards an RPC envelope to the default shard and unwraps `{ result }`", async () => {
        shard.response = Response.json({ result: { id: "m1" } });

        const handler = async (ctx: HttpActionContext, request: Request): Promise<Response> => {
            const body = (await request.json()) as Record<string, unknown>;
            const created = await ctx.runMutation({ __cirrusRef: "messages:send" }, { body });

            return Response.json({ created });
        };

        const worker = createWorker({
            httpRouter: oneRoute("/webhook", "POST", handler),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/webhook", { body: JSON.stringify({ text: "hi" }), method: "POST" }), {}, fakeCtx);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ created: { id: "m1" } });
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("__root__");

        const forwarded = (await shard.calls[0]!.request.json()) as { args: unknown; functionPath: string };

        expect(forwarded.functionPath).toBe("messages:send");
        expect(forwarded.args).toEqual({ body: { text: "hi" } });
    });

    test("ctx.run* rejects (→ mapped error response) when the shard returns an error envelope", async () => {
        shard.response = Response.json({ error: { code: "BAD_REQUEST", message: "nope" } }, { status: 400 });

        const handler = async (ctx: HttpActionContext): Promise<Response> => {
            await ctx.runQuery({ __cirrusRef: "messages:list" });

            return new Response("unreachable");
        };

        const worker = createWorker({
            httpRouter: oneRoute("/run", "GET", handler),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/run"), {}, fakeCtx);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: { code: "BAD_REQUEST", message: "nope" } });
    });

    test("exposes resolveIdentity on ctx.auth", async () => {
        const handler = async (ctx: HttpActionContext): Promise<Response> => Response.json({ claims: await ctx.auth.getIdentity(), userId: ctx.auth.userId });

        const worker = createWorker({
            httpRouter: oneRoute("/me", "GET", handler),
            resolveIdentity: () => ({ email: "u@example.com", userId: "user_7" }),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/me"), {}, fakeCtx);

        await expect(res.json()).resolves.toEqual({ claims: { email: "u@example.com" }, userId: "user_7" });
    });

    test("returns 405 with an Allow header on method_not_allowed", async () => {
        const worker = createWorker({
            httpRouter: fixedRouter({ allow: ["GET", "PUT"], kind: "method_not_allowed" }),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/thing", { method: "POST" }), {}, fakeCtx);

        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, PUT");
    });

    test("falls through to 404 when the router reports not_found", async () => {
        const worker = createWorker({
            httpRouter: fixedRouter({ kind: "not_found" }),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/missing"), {}, fakeCtx);

        expect(res.status).toBe(404);
    });

    test("explicit routes win over the HTTP router", async () => {
        const route = vi.fn(async () => new Response("explicit", { status: 200 }));
        const action = vi.fn(() => new Response("action"));

        const worker = createWorker({
            httpRouter: oneRoute("/x", "GET", action),
            routes: { "/x": route },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/x"), {}, fakeCtx);

        await expect(res.text()).resolves.toBe("explicit");
        expect(action).not.toHaveBeenCalled();
    });

    test("the internal RPC path is never shadowed by a catch-all router", async () => {
        const action = vi.fn(() => new Response("action"));

        const worker = createWorker({
            httpRouter: fixedRouter({ action: { handler: action }, kind: "match" }),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(200);
        expect(action).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });
});
