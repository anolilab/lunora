import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, HttpActionContext, HttpRouterLike, Route } from "../src/create-worker.js";
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

    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ request, shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

describe("createWorker", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("returns 404 for unknown paths", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/missing"), {}, fakeContext);

        expect(res.status).toBe(404);
    });

    it("forwards POST /_cirrus/rpc to the default __root__ shard", async () => {
        expect.assertions(4);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: { limit: 5 }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("__root__");

        const body = await shard.calls[0]!.request.json();

        expect(body).toEqual({ args: { limit: 5 }, functionPath: "messages:list" });
    });

    it("uses the envelope shardKey when provided", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list", shardKey: "channel-42" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.shardKey).toBe("channel-42");
    });

    it("honors defaultShardKey override", async () => {
        expect.assertions(1);

        const worker = createWorker({ defaultShardKey: "tenant-1", shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "x:y" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.shardKey).toBe("tenant-1");
    });

    it("rejects non-POST RPC requests with 405", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc"), {}, fakeContext);

        expect(res.status).toBe(405);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    });

    it("maps malformed RPC JSON to 400", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc", { body: "{not json", method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("rejects missing functionPath", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/rpc", { body: JSON.stringify({ args: {} }), method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
    });

    it("forwards /_cirrus/ws upgrades to the correct shard", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const upgrade = new Request("https://app.example/_cirrus/ws?shard=channel-7", {
            headers: { Upgrade: "websocket" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("channel-7");
    });

    it("rejects /_cirrus/ws without upgrade header", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/ws?shard=x"), {}, fakeContext);

        expect(res.status).toBe(426);
    });

    it("invokes custom routes before default handlers", async () => {
        expect.assertions(3);

        const route = vi.fn<Route>(async () => new Response("hi", { status: 200 }));
        const worker = createWorker({ routes: { "/auth/callback": route }, shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/auth/callback"), {}, fakeContext);

        expect(route).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(0);
    });

    it("prefers getByName when the namespace exposes it", async () => {
        expect.assertions(3);

        const stub = { fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("via-getByName")) };
        const namespace: ShardNamespaceLike = {
            get: vi.fn<ShardNamespaceLike["get"]>(),
            getByName: vi.fn<NonNullable<ShardNamespaceLike["getByName"]>>(() => stub),
            idFromName: vi.fn<ShardNamespaceLike["idFromName"]>(),
        };

        const worker = createWorker({ shardDO: namespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ functionPath: "x:y", shardKey: "a" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(namespace.getByName).toHaveBeenCalledWith("a");
        expect(namespace.idFromName).not.toHaveBeenCalled();
        // Confirms the stub returned by getByName received the forwarded RPC,
        // i.e. dispatch went through getByName rather than the idFromName + get fallback.
        expect(stub.fetch).toHaveBeenCalledWith(expect.any(Request));
    });

    it("forwards resolveIdentity userId on the x-cirrus-userid header", async () => {
        expect.assertions(2);

        const worker = createWorker({
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBe("user_42");
        expect(shard.calls[0]!.request.headers.get("x-cirrus-identity")).toBeNull();
    });

    it("omits identity headers when resolveIdentity returns null", async () => {
        expect.assertions(2);

        const worker = createWorker({
            resolveIdentity: () => null,
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBeNull();
        expect(shard.calls[0]!.request.headers.get("x-cirrus-identity")).toBeNull();
    });

    it("serialises extra identity claims as JSON on x-cirrus-identity", async () => {
        expect.assertions(3);

        const worker = createWorker({
            resolveIdentity: () => {
                return { email: "u@example.com", roles: ["admin"], userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-cirrus-userid")).toBe("user_42");

        const identityHeader = shard.calls[0]!.request.headers.get("x-cirrus-identity");

        expect(identityHeader).not.toBeNull();
        expect(JSON.parse(identityHeader!)).toEqual({ email: "u@example.com", roles: ["admin"] });
    });

    it("does not invoke resolveIdentity when fanOut request would 400 (no coordinator)", async () => {
        expect.assertions(2);

        const resolveIdentity = vi.fn<() => { userId: string }>(() => {
            return { userId: "user_42" };
        });
        const worker = createWorker({
            resolveIdentity,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { kind: "all" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        expect(resolveIdentity).not.toHaveBeenCalled();
    });

    it("propagates resolved identity headers through the fan-out coordinator", async () => {
        expect.assertions(3);

        const fanOut = vi.fn<(namespace: unknown, args: { headers: Record<string, string> }) => Promise<unknown>>(async (_namespace, args) => {
            return {
                received: args.headers,
            };
        });

        const worker = createWorker({
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: fanOut as never,
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveIdentity: () => {
                return { email: "u@example.com", userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { kind: "all" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(fanOut).toHaveBeenCalledTimes(1);

        const { headers } = fanOut.mock.calls[0]![1];

        expect(headers["x-cirrus-userid"]).toBe("user_42");
        expect(JSON.parse(headers["x-cirrus-identity"]!)).toEqual({ email: "u@example.com" });
    });

    it("denies fan-out by default when authorizeShard is set without authorizeFanOut", async () => {
        expect.assertions(3);

        const fanOut = vi.fn<() => never>();
        const worker = createWorker({
            authorizeShard: () => true,
            queryCoordinator: {
                fanOut,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_FANOUT" } });
        expect(fanOut).not.toHaveBeenCalled();
    });

    it("invokes authorizeFanOut with identity, table, and functionPath", async () => {
        expect.assertions(3);

        const fanOut = vi.fn<() => Promise<unknown>>(async () => {
            return { data: [], errors: [], failed: 0, ok: 0 };
        });
        const authorizeFanOut = vi.fn<() => boolean>(() => true);
        const worker = createWorker({
            authorizeFanOut,
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(authorizeFanOut).toHaveBeenCalledTimes(1);
        expect(authorizeFanOut).toHaveBeenCalledWith({ userId: "user_42" }, "messages", "messages:list");
        expect(fanOut).toHaveBeenCalledTimes(1);
    });

    it("rejects fan-out when authorizeFanOut returns false", async () => {
        expect.assertions(3);

        const fanOut = vi.fn<() => never>();
        const worker = createWorker({
            authorizeFanOut: () => false,
            queryCoordinator: {
                fanOut,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_FANOUT" } });
        expect(fanOut).not.toHaveBeenCalled();
    });
});

describe("createWorker — migration endpoint", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    const migrateRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
        new Request("https://app.example/_cirrus/migrate", { body: JSON.stringify(body), headers, method: "POST" });

    it("drives orchestrateMigration with the table, args and forwarded bearer", async () => {
        expect.assertions(5);

        const orchestrateMigration = vi.fn<
            (
                namespace: unknown,
                request: { args: Record<string, unknown>; functionPath: string; headers: Record<string, string>; table: string },
            ) => Promise<unknown>
        >(async (_namespace, _request) => {
            return {
                changed: 3,
                failed: 0,
                ok: 2,
                processed: 3,
                shards: [],
                status: "completed",
            };
        });

        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: orchestrateMigration as never,
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            migrateRequest(
                { args: { direction: "up", id: "backfill" }, functionPath: "__cirrus_admin__:runMigration", table: "messages" },
                { authorization: "Bearer s3cret" },
            ),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ changed: 3, ok: 2, status: "completed" });
        expect(orchestrateMigration).toHaveBeenCalledTimes(1);

        const request = orchestrateMigration.mock.calls[0]![1];

        expect(request).toMatchObject({ args: { direction: "up", id: "backfill" }, functionPath: "__cirrus_admin__:runMigration", table: "messages" });
        expect(request.headers.authorization).toBe("Bearer s3cret");
    });

    it("400s when no queryCoordinator is configured", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: "s3cret", shardDO: shard.namespace });

        const res = await worker.fetch(
            migrateRequest({ functionPath: "__cirrus_admin__:runMigration", table: "messages" }, { authorization: "Bearer s3cret" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
    });

    it("rejects a non-migration functionPath with 400", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            migrateRequest({ functionPath: "messages:list", table: "messages" }, { authorization: "Bearer s3cret" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
    });

    it("rejects a missing table with 400", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(migrateRequest({ functionPath: "__cirrus_admin__:runMigration" }, { authorization: "Bearer s3cret" }), {}, fakeContext);

        expect(res.status).toBe(400);
    });

    it("rejects non-POST with 405", async () => {
        expect.assertions(1);

        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/migrate"), {}, fakeContext);

        expect(res.status).toBe(405);
    });
});

/**
 * Bindings the runtime injects on the env when dispatching to the HTTP router.
 * Mirrors `@cirrus/server`'s `CirrusHttpEnv` without importing the server
 * package — the runtime stays structurally hono-free.
 */
interface ContextEnv {
    Bindings: { __cirrusCtx?: HttpActionContext };
    Variables: { cirrus: HttpActionContext };
}

/**
 * Build a real hono app pre-wired with the same `__cirrusCtx` → `c.var.cirrus`
 * lift that `@cirrus/server`'s `httpRouter()` installs, then let the test
 * register routes on it. Returned as an {@link HttpRouterLike} (`{ fetch }`).
 */
const honoApp = (register: (app: Hono<ContextEnv>) => void): HttpRouterLike => {
    const app = new Hono<ContextEnv>();

    app.use("*", async (c, next) => {
        const injected = c.env.__cirrusCtx;

        if (injected) {
            c.set("cirrus", injected);
        }

        await next();
    });

    register(app);

    return app;
};

describe("createWorker — HTTP actions", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("dispatches a matched request to the action handler and returns its Response", async () => {
        expect.assertions(3);

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/ping", () => new Response("pong", { status: 201 }))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/ping"), {}, fakeContext);

        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe("pong");
        expect(shard.calls).toHaveLength(0);
    });

    it("c.var.cirrus.runMutation forwards an RPC envelope to the default shard and unwraps `{ result }`", async () => {
        expect.assertions(6);

        shard.response = Response.json({ result: { id: "m1" } });

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/webhook", async (c) => {
                    const body = await c.req.json();
                    const created = await c.var.cirrus.runMutation({ __cirrusRef: "messages:send" }, { body });

                    return Response.json({ created });
                }),
            ),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/webhook", { body: JSON.stringify({ text: "hi" }), method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ created: { id: "m1" } });
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("__root__");

        const forwarded: { args: Record<string, unknown>; functionPath: string } = await shard.calls[0]!.request.json();

        expect(forwarded.functionPath).toBe("messages:send");
        expect(forwarded.args).toEqual({ body: { text: "hi" } });
    });

    it("exposes resolveIdentity on c.var.cirrus.auth", async () => {
        expect.assertions(1);

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.get("/me", async (c) => Response.json({ claims: await c.var.cirrus.auth.getIdentity(), userId: c.var.cirrus.auth.userId })),
            ),
            resolveIdentity: () => {
                return { email: "u@example.com", userId: "user_7" };
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/me"), {}, fakeContext);

        await expect(res.json()).resolves.toEqual({ claims: { email: "u@example.com" }, userId: "user_7" });
    });

    it("a path-match with the wrong verb yields hono's 404", async () => {
        expect.assertions(1);

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/thing", () => new Response("ok"))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/thing", { method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(404);
    });

    it("falls through to hono's 404 when no route matches", async () => {
        expect.assertions(1);

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/known", () => new Response("ok"))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/missing"), {}, fakeContext);

        expect(res.status).toBe(404);
    });

    it("explicit routes win over the HTTP router", async () => {
        expect.assertions(2);

        const route = vi.fn<Route>(async () => new Response("explicit", { status: 200 }));
        const action = vi.fn<() => Response>(() => new Response("action"));

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/x", action)),
            routes: { "/x": route },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/x"), {}, fakeContext);

        await expect(res.text()).resolves.toBe("explicit");
        expect(action).not.toHaveBeenCalled();
    });

    it("the internal RPC path is never shadowed by a catch-all router", async () => {
        expect.assertions(3);

        const action = vi.fn<() => Response>(() => new Response("action"));

        const worker = createWorker({
            httpRouter: honoApp((app) => app.all("*", action)),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(action).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });
});
