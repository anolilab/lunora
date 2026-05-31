import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ExecutionContextLike, HttpActionContext, HttpRouterLike } from "../src/create-worker.js";
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
        // Confirms the stub returned by getByName received the forwarded RPC,
        // i.e. dispatch went through getByName rather than the idFromName + get fallback.
        expect(stub.fetch).toHaveBeenCalledWith(expect.any(Request));
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
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateMigration: fanOut as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
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

    test("denies fan-out by default when authorizeShard is set without authorizeFanOut", async () => {
        const fanOut = vi.fn();
        const worker = createWorker({
            shardDO: shard.namespace,
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            authorizeShard: () => true,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, fanOut: { table: "messages", merge: { kind: "concat" } } }),
            }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_FANOUT" } });
        expect(fanOut).not.toHaveBeenCalled();
    });

    test("invokes authorizeFanOut with identity, table, and functionPath", async () => {
        const fanOut = vi.fn(async () => ({ data: [], errors: [], failed: 0, ok: 0 }));
        const authorizeFanOut = vi.fn(() => true);
        const worker = createWorker({
            shardDO: shard.namespace,
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            authorizeFanOut,
            resolveIdentity: () => ({ userId: "user_42" }),
        });

        await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, fanOut: { table: "messages", merge: { kind: "concat" } } }),
            }),
            {},
            fakeCtx,
        );

        expect(authorizeFanOut).toHaveBeenCalledTimes(1);
        expect(authorizeFanOut).toHaveBeenCalledWith({ userId: "user_42" }, "messages", "messages:list");
        expect(fanOut).toHaveBeenCalledTimes(1);
    });

    test("rejects fan-out when authorizeFanOut returns false", async () => {
        const fanOut = vi.fn();
        const worker = createWorker({
            shardDO: shard.namespace,
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            authorizeFanOut: () => false,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_cirrus/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {}, fanOut: { table: "messages", merge: { kind: "concat" } } }),
            }),
            {},
            fakeCtx,
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

    test("drives orchestrateMigration with the table, args and forwarded bearer", async () => {
        const orchestrateMigration = vi.fn(
            async (_namespace: unknown, _request: { args: Record<string, unknown>; functionPath: string; headers: Record<string, string>; table: string }) => ({
                changed: 3,
                failed: 0,
                ok: 2,
                processed: 3,
                shards: [],
                status: "completed",
            }),
        );

        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateMigration: orchestrateMigration as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
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
            fakeCtx,
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ changed: 3, ok: 2, status: "completed" });
        expect(orchestrateMigration).toHaveBeenCalledTimes(1);

        const request = orchestrateMigration.mock.calls[0]![1];

        expect(request).toMatchObject({ args: { direction: "up", id: "backfill" }, functionPath: "__cirrus_admin__:runMigration", table: "messages" });
        expect(request.headers.authorization).toBe("Bearer s3cret");
    });

    test("400s when no queryCoordinator is configured", async () => {
        const worker = createWorker({ adminToken: "s3cret", shardDO: shard.namespace });

        const res = await worker.fetch(
            migrateRequest({ functionPath: "__cirrus_admin__:runMigration", table: "messages" }, { authorization: "Bearer s3cret" }),
            {},
            fakeCtx,
        );

        expect(res.status).toBe(400);
    });

    test("rejects a non-migration functionPath with 400", async () => {
        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(migrateRequest({ functionPath: "messages:list", table: "messages" }, { authorization: "Bearer s3cret" }), {}, fakeCtx);

        expect(res.status).toBe(400);
    });

    test("rejects a missing table with 400", async () => {
        const worker = createWorker({
            adminToken: "s3cret",
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(migrateRequest({ functionPath: "__cirrus_admin__:runMigration" }, { authorization: "Bearer s3cret" }), {}, fakeCtx);

        expect(res.status).toBe(400);
    });

    test("rejects non-POST with 405", async () => {
        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/_cirrus/migrate"), {}, fakeCtx);

        expect(res.status).toBe(405);
    });
});

/**
 * Bindings the runtime injects on the env when dispatching to the HTTP router.
 * Mirrors `@cirrus/server`'s `CirrusHttpEnv` without importing the server
 * package — the runtime stays structurally hono-free.
 */
interface CtxEnv {
    Bindings: { __cirrusCtx?: HttpActionContext };
    Variables: { cirrus: HttpActionContext };
}

/**
 * Build a real hono app pre-wired with the same `__cirrusCtx` → `c.var.cirrus`
 * lift that `@cirrus/server`'s `httpRouter()` installs, then let the test
 * register routes on it. Returned as an {@link HttpRouterLike} (`{ fetch }`).
 */
const honoApp = (register: (app: Hono<CtxEnv>) => void): HttpRouterLike => {
    const app = new Hono<CtxEnv>();

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

    test("dispatches a matched request to the action handler and returns its Response", async () => {
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/ping", () => new Response("pong", { status: 201 }))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/ping"), {}, fakeCtx);

        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe("pong");
        expect(shard.calls).toHaveLength(0);
    });

    test("c.var.cirrus.runMutation forwards an RPC envelope to the default shard and unwraps `{ result }`", async () => {
        shard.response = Response.json({ result: { id: "m1" } });

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/webhook", async (c) => {
                    const body = (await c.req.json()) as Record<string, unknown>;
                    const created = await c.var.cirrus.runMutation({ __cirrusRef: "messages:send" }, { body });

                    return Response.json({ created });
                }),
            ),
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

    test("exposes resolveIdentity on c.var.cirrus.auth", async () => {
        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.get("/me", async (c) => Response.json({ claims: await c.var.cirrus.auth.getIdentity(), userId: c.var.cirrus.auth.userId })),
            ),
            resolveIdentity: () => ({ email: "u@example.com", userId: "user_7" }),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/me"), {}, fakeCtx);

        await expect(res.json()).resolves.toEqual({ claims: { email: "u@example.com" }, userId: "user_7" });
    });

    test("a path-match with the wrong verb yields hono's 404", async () => {
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/thing", () => new Response("ok"))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/thing", { method: "POST" }), {}, fakeCtx);

        expect(res.status).toBe(404);
    });

    test("falls through to hono's 404 when no route matches", async () => {
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/known", () => new Response("ok"))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/missing"), {}, fakeCtx);

        expect(res.status).toBe(404);
    });

    test("explicit routes win over the HTTP router", async () => {
        const route = vi.fn(async () => new Response("explicit", { status: 200 }));
        const action = vi.fn(() => new Response("action"));

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/x", action)),
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
            httpRouter: honoApp((app) => app.all("*", action)),
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
