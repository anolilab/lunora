import { LunoraError } from "@lunora/errors";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeIdentityHeader } from "../../../shared/identity-header";
import type { ExecutionContextLike, HttpActionContext, HttpRouterLike, Route } from "../src/create-worker";
import { composeWorker, createLunoraHandler, createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

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

    it("answers GET /_lunora/status with an unauthenticated ok probe", async () => {
        expect.assertions(4);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/status"), {}, fakeContext);

        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        // Bare ok — no framework name/version, so production deployments don't
        // hand scanners a fingerprint.
        await expect(res.json()).resolves.toStrictEqual({ ok: true });
        // The probe never touches a shard.
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects non-GET/HEAD on /_lunora/status with 405", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/status", { method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
    });

    it("forwards POST /_lunora/rpc to the default __root__ shard", async () => {
        expect.assertions(4);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
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

    const UPSTREAM_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    /** Dispatch one RPC carrying an upstream trace context, and return what reached the shard. */
    const forwardWithUpstreamTrace = async (workerOptions: Parameters<typeof createWorker>[0]): Promise<Headers> => {
        const worker = createWorker(workerOptions);

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { traceparent: UPSTREAM_TRACEPARENT, tracestate: "congo=t61rcWkgMzE" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        return shard.calls[0]!.request.headers;
    };

    // The inbound header is caller-controlled, and its trace id decides which
    // trace this request's spans and logs land in — so by default we mint our own
    // rather than let a client file entries into someone else's waterfall.
    it("does not adopt an untrusted inbound traceparent", async () => {
        expect.assertions(3);

        const headers = await forwardWithUpstreamTrace({ shardDO: shard.namespace });
        const forwarded = headers.get("traceparent");

        expect(forwarded).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
        expect(forwarded).not.toContain("0af7651916cd43dd8448eb211c80319c");
        // An untrusted `tracestate` is not echoed onward either.
        expect(headers.get("tracestate")).toBeNull();
    });

    // The per-request form is the point of the named signals: one worker serves
    // both a public browser request and a trusted internal caller, and only the
    // latter should be able to choose the trace.
    it("applies a named trust signal per request", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace, trustInboundTraceContext: "mtls" });

        const dispatch = async (cf?: unknown): Promise<null | string> => {
            shard.calls.length = 0;

            const request = new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { traceparent: UPSTREAM_TRACEPARENT },
                method: "POST",
            });

            if (cf !== undefined) {
                Object.defineProperty(request, "cf", { value: cf, writable: false });
            }

            await worker.fetch(request, {}, fakeContext);

            return shard.calls[0]!.request.headers.get("traceparent");
        };

        await expect(dispatch({ tlsClientAuth: { certVerified: "SUCCESS" } })).resolves.toContain("0af7651916cd43dd8448eb211c80319c");
        await expect(dispatch()).resolves.not.toContain("0af7651916cd43dd8448eb211c80319c");
    });

    it("continues the inbound trace when trustInboundTraceContext is set", async () => {
        expect.assertions(3);

        const headers = await forwardWithUpstreamTrace({ shardDO: shard.namespace, trustInboundTraceContext: true });
        const forwarded = headers.get("traceparent");

        expect(forwarded).not.toBe(UPSTREAM_TRACEPARENT);
        // Trace id inherited; span id freshly minted; sampled flag preserved.
        expect(forwarded).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[\da-f]{16}-01$/);
        expect(headers.get("tracestate")).toBe("congo=t61rcWkgMzE");
    });

    it("uses the envelope shardKey when provided", async () => {
        expect.assertions(1);

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
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
            new Request("https://app.example/_lunora/rpc", {
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

        const res = await worker.fetch(new Request("https://app.example/_lunora/rpc"), {}, fakeContext);

        expect(res.status).toBe(405);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    });

    it("maps malformed RPC JSON to 400", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/rpc", { body: "{not json", method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("rejects missing functionPath", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {} }), method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
    });

    it("rejects a non-object `args` at the RPC boundary", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: "nope", functionPath: "messages:list" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        // The malformed envelope is rejected at the edge, never forwarded to a shard.
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects a non-string `shardKey` at the RPC boundary", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list", shardKey: 123 }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        // A non-string shardKey must never reach `idFromName` on the namespace.
        expect(shard.calls).toHaveLength(0);
    });

    it("rejects a relation fan-out whose args.table differs from the authorized fanOut.table (confused-deputy regression)", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({
                    args: { table: "secrets", where: {} },
                    fanOut: { merge: { kind: "concat" }, table: "posts" },
                    functionPath: "__lunora_relation__:read",
                }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        // The mismatched envelope is rejected at the edge — the raw, RLS-blind
        // relation read of `secrets` (authorized only for `posts`) never reaches a shard.
        expect(shard.calls).toHaveLength(0);
    });

    it("forwards /_lunora/ws upgrades to the correct shard", async () => {
        expect.assertions(2);

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        const upgrade = new Request("https://app.example/_lunora/ws?shard=channel-7", {
            headers: { Upgrade: "websocket" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("channel-7");
    });

    it("strips client-supplied identity headers from /_lunora/ws upgrades (anonymous spoof)", async () => {
        expect.assertions(3);

        // No resolveIdentity → every caller is anonymous. A forged x-lunora-userid /
        // x-lunora-identity on the upgrade must NOT reach the shard, else an anonymous
        // attacker could spoof a verified identity on the socket.
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        const upgrade = new Request("https://app.example/_lunora/ws?shard=channel-7", {
            headers: { Upgrade: "websocket", "x-lunora-identity": '{"roles":["admin"]}', "x-lunora-userid": "victim" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBeNull();
        expect(shard.calls[0]!.request.headers.get("x-lunora-identity")).toBeNull();
    });

    it("overrides client-supplied identity headers on /_lunora/ws with the resolved identity", async () => {
        expect.assertions(2);

        // A forged x-lunora-userid must be replaced by the server-resolved one, never honoured.
        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        const upgrade = new Request("https://app.example/_lunora/ws?shard=channel-7", {
            headers: { Upgrade: "websocket", "x-lunora-userid": "victim" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBe("user_42");
        expect(shard.calls[0]!.request.headers.get("x-lunora-identity")).toBeNull();
    });

    it("rejects /_lunora/ws without upgrade header", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/ws?shard=x"), {}, fakeContext);

        expect(res.status).toBe(426);
    });

    it("rejects a cross-origin cookie-bearing WS upgrade (CSWSH guard, H1)", async () => {
        expect.assertions(2);

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: shard.namespace });

        // A browser on evil.com auto-attaches the victim's cookie to the handshake;
        // the cross-origin `Origin` must be rejected before any forwarding.
        const upgrade = new Request("https://app.example/_lunora/ws", {
            headers: { cookie: "session=victim", Origin: "https://evil.com", Upgrade: "websocket" },
        });

        const res = await worker.fetch(upgrade, {}, fakeContext);

        expect(res.status).toBe(403);
        expect(shard.calls).toHaveLength(0);
    });

    it("allows a same-origin cookie-bearing WS upgrade", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const upgrade = new Request("https://app.example/_lunora/ws", {
            headers: { cookie: "session=me", Origin: "https://app.example", Upgrade: "websocket" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
    });

    it("allows a token (no-cookie) cross-origin WS upgrade — CSWSH only rides cookies", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        // No Cookie header → not a forgeable-by-a-browser credential, so the origin
        // guard is exempt (bearer/token/server-to-server clients keep working).
        const upgrade = new Request("https://app.example/_lunora/ws", {
            headers: { Origin: "https://evil.com", Upgrade: "websocket" },
        });

        await worker.fetch(upgrade, {}, fakeContext);

        expect(shard.calls).toHaveLength(1);
    });

    it("default-denies a non-default shard when no authorize callback is configured (M1)", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list", shardKey: "tenant-b" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        expect(shard.calls).toHaveLength(0);
    });

    it("default-denies a fan-out envelope when no authorize callback is configured (M2)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            queryCoordinator: { fanOut: vi.fn<() => never>() } as never,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
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

    it("with no `routes` key, an unmatched path reaches default dispatch and 404s", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/nope"), {}, fakeContext);

        expect(res.status).toBe(404);
    });

    it("prefers getByName when the namespace exposes it", async () => {
        expect.assertions(3);

        const stub = { fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("via-getByName")) };
        const namespace: ShardNamespaceLike = {
            get: vi.fn<NonNullable<ShardNamespaceLike["get"]>>(),
            getByName: vi.fn<NonNullable<ShardNamespaceLike["getByName"]>>(() => stub),
            idFromName: vi.fn<NonNullable<ShardNamespaceLike["idFromName"]>>(),
        };

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ functionPath: "x:y", shardKey: "a" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        // Second argument is the placement bag, absent here since no
        // `shardRegion` policy is configured.
        expect(namespace.getByName).toHaveBeenCalledWith("a", undefined);
        expect(namespace.idFromName).not.toHaveBeenCalled();
        // Confirms the stub returned by getByName received the forwarded RPC,
        // i.e. dispatch went through getByName rather than the idFromName + get fallback.
        expect(stub.fetch).toHaveBeenCalledWith(expect.any(Request));
    });

    describe("replica reads", () => {
        /** A namespace that records every resolved name + placement and answers with a per-name scripted stub. */
        const createReplicaNamespace = (
            respond: (name: string, request: Request) => Response,
        ): { calls: { name: string; options: unknown }[]; namespace: ShardNamespaceLike } => {
            const calls: { name: string; options: unknown }[] = [];

            return {
                calls,
                namespace: {
                    get: () => {
                        return { fetch: async () => new Response("unused") };
                    },
                    getByName: (name: string, options?: unknown) => {
                        calls.push({ name, options });

                        return {
                            fetch: async (request: Request) => respond(name, request),
                        };
                    },
                    idFromName: (name: string) => name,
                },
            };
        };

        /** An RPC request carrying edge geography, so the runtime can pick a region for it. */
        const geoRpc = (functionPath: string, headers: Record<string, string> = {}): Request =>
            Object.assign(
                new Request("https://app.example/_lunora/rpc", {
                    body: JSON.stringify({ functionPath, shardKey: "tenant-7" }),
                    headers,
                    method: "POST",
                }),
                { cf: { continent: "EU", longitude: "2.35" } },
            );

        const functions = { "posts:list": { kind: "query" as const }, "posts:add": { kind: "mutation" as const } };

        it("routes a query to a replica in the caller's region, and places it there", async () => {
            expect.assertions(5);

            let marker: null | string = null;
            let binding: null | string = null;
            const { calls, namespace } = createReplicaNamespace((_name, request) => {
                marker = request.headers.get("x-lunora-replica-read");
                binding = request.headers.get("x-lunora-shard-binding");

                return Response.json({ result: [] });
            });
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            const response = await worker.fetch(geoRpc("posts:list"), { SHARD: namespace }, fakeContext);

            expect(response.status).toBe(200);
            expect(calls[0]?.name).toBe("tenant-7::replica::weur");
            // The hint is what puts the replica near the reader; without it the
            // copy would be created wherever this request happened to run.
            expect(calls[0]?.options).toStrictEqual({ locationHint: "weur" });
            // The marker is the single thing the DO gate keys on: drop it and
            // every replica read 421s back to the owner — correct results, and a
            // feature that is silently dead with every test still green.
            expect(marker).toBe("1");
            // Without the binding the replica cannot address the owner it follows.
            expect(binding).toBe("SHARD");
        });

        it("sends writes to the owner even when replica reads are on", async () => {
            expect.assertions(1);

            const { calls, namespace } = createReplicaNamespace(() => Response.json({ result: null }));
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            await worker.fetch(geoRpc("posts:add"), {}, fakeContext);

            expect(calls.map((call) => call.name)).toStrictEqual(["tenant-7"]);
        });

        it("retries against the owner once when the replica cannot serve the read", async () => {
            expect.assertions(2);

            const { calls, namespace } = createReplicaNamespace((name) =>
                name.includes("::replica::")
                    ? Response.json(
                          { error: { code: "REPLICA_NOT_READY", message: "stale" } },
                          { headers: { "x-lunora-replica-fallback": "stale" }, status: 421 },
                      )
                    : Response.json({ result: ["from-owner"] }),
            );
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            const response = await worker.fetch(geoRpc("posts:list"), {}, fakeContext);

            expect(calls.map((call) => call.name)).toStrictEqual(["tenant-7::replica::weur", "tenant-7"]);
            await expect(response.json()).resolves.toStrictEqual({ result: ["from-owner"] });
        });

        it("forwards the caller's read-your-writes bookmark to the replica", async () => {
            expect.assertions(2);

            let seen: string | null = null;
            const { namespace } = createReplicaNamespace((_name, request) => {
                seen = request.headers.get("x-lunora-min-seq");

                return Response.json({ result: [] });
            });
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            await worker.fetch(geoRpc("posts:list", { "x-lunora-min-seq": "42" }), {}, fakeContext);

            expect(seen).toBe("42");

            // A non-numeric bookmark is dropped rather than forwarded: the header
            // reaches the replica's integer parse, and garbage there would read as
            // "no requirement" — the one reading that silently weakens the
            // guarantee the caller asked for.
            await worker.fetch(geoRpc("posts:list", { "x-lunora-min-seq": "not-a-number" }), {}, fakeContext);

            expect(seen).toBeNull();
        });

        it("keeps reads on the owner when the request has no geography", async () => {
            expect.assertions(1);

            const { calls, namespace } = createReplicaNamespace(() => Response.json({ result: [] }));
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ functionPath: "posts:list", shardKey: "tenant-7" }), method: "POST" }),
                {},
                fakeContext,
            );

            expect(calls.map((call) => call.name)).toStrictEqual(["tenant-7"]);
        });

        it("never re-targets a shard key that already carries a reserved role infix", async () => {
            expect.assertions(1);

            const { calls, namespace } = createReplicaNamespace(() => Response.json({ result: [] }));
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, replicaReads: true, shardDO: namespace });

            await worker.fetch(
                Object.assign(
                    new Request("https://app.example/_lunora/rpc", {
                        body: JSON.stringify({ functionPath: "posts:list", shardKey: "tenant-7::replica::weur" }),
                        method: "POST",
                    }),
                    { cf: { continent: "EU", longitude: "2.35" } },
                ),
                {},
                fakeContext,
            );

            // A replica of a replica follows a DO nobody feeds.
            expect(calls.map((call) => call.name)).toStrictEqual(["tenant-7::replica::weur"]);
        });

        it("names the shard it resolved, so the client can key one cursor for it", async () => {
            expect.assertions(2);

            const { namespace } = createReplicaNamespace(() => Response.json({ commitCursor: 4, result: null }));
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, defaultShardKey: "__root__", functions, shardDO: namespace });

            const response = await worker.fetch(
                new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ functionPath: "posts:add" }), method: "POST" }),
                {},
                fakeContext,
            );

            // The caller named no shard; the worker resolved its configured
            // default, and only the worker knows those are the same shard.
            expect(response.headers.get("x-lunora-shard-key")).toBe("__root__");
            // The shard's own response headers survive the stamp.
            await expect(response.json()).resolves.toStrictEqual({ commitCursor: 4, result: null });
        });

        it("does not send a region hint when the deployment is pinned to a jurisdiction", async () => {
            expect.assertions(2);

            const placements: unknown[] = [];
            const pinned: ShardNamespaceLike = {
                get: (_id, options) => {
                    placements.push(options);

                    return { fetch: async () => Response.json({ result: [] }) };
                },
                idFromName: (name: string) => name,
            };
            const namespace: ShardNamespaceLike = {
                get: () => {
                    return { fetch: async () => new Response("unused") };
                },
                idFromName: (name: string) => name,
                jurisdiction: () => pinned,
            };

            const worker = createWorker({
                allowUnauthenticatedShardAccess: true,
                functions,
                jurisdiction: "eu",
                shardDO: namespace,
                shardRegion: () => "weur",
            });

            await worker.fetch(geoRpc("posts:list"), {}, fakeContext);

            // Residency is a hard constraint and the region only a hint, and the
            // pairing cannot be exercised on any runtime available to us
            // (workerd does not implement jurisdictions at all). The hint is
            // dropped rather than shipped untested.
            expect(placements).toHaveLength(1);
            expect(placements[0]).toBeUndefined();
        });

        it("stays on the owner when replica reads are off", async () => {
            expect.assertions(1);

            const { calls, namespace } = createReplicaNamespace(() => Response.json({ result: [] }));
            const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions, shardDO: namespace });

            await worker.fetch(geoRpc("posts:list"), {}, fakeContext);

            expect(calls.map((call) => call.name)).toStrictEqual(["tenant-7"]);
        });
    });

    it("applies the `shardRegion` placement policy to the forward path", async () => {
        expect.assertions(2);

        const stub = { fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("ok")) };
        const namespace: ShardNamespaceLike = {
            get: vi.fn<NonNullable<ShardNamespaceLike["get"]>>(),
            getByName: vi.fn<NonNullable<ShardNamespaceLike["getByName"]>>(() => stub),
            idFromName: vi.fn<NonNullable<ShardNamespaceLike["idFromName"]>>(),
        };

        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            shardDO: namespace,
            shardRegion: (shardKey) => (shardKey === "tenant-eu" ? "weur" : undefined),
        });

        const call = async (shardKey: string): Promise<void> => {
            await worker.fetch(
                new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ functionPath: "x:y", shardKey }), method: "POST" }),
                {},
                fakeContext,
            );
        };

        await call("tenant-eu");
        await call("tenant-unknown");

        expect(namespace.getByName).toHaveBeenNthCalledWith(1, "tenant-eu", { locationHint: "weur" });
        // A key the policy has no opinion about keeps the platform default
        // (create near the first request) rather than being pinned anywhere.
        expect(namespace.getByName).toHaveBeenNthCalledWith(2, "tenant-unknown", undefined);
    });

    it("forwards resolveIdentity userId on the x-lunora-userid header", async () => {
        expect.assertions(2);

        const worker = createWorker({
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBe("user_42");
        expect(shard.calls[0]!.request.headers.get("x-lunora-identity")).toBeNull();
    });

    it("omits identity headers when resolveIdentity returns null", async () => {
        expect.assertions(2);

        const worker = createWorker({
            resolveIdentity: () => null,
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBeNull();
        expect(shard.calls[0]!.request.headers.get("x-lunora-identity")).toBeNull();
    });

    it("serialises extra identity claims as JSON on x-lunora-identity", async () => {
        expect.assertions(3);

        const worker = createWorker({
            resolveIdentity: () => {
                return { email: "u@example.com", roles: ["admin"], userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBe("user_42");

        const identityHeader = shard.calls[0]!.request.headers.get("x-lunora-identity");

        expect(identityHeader).not.toBeNull();
        expect(decodeIdentityHeader(identityHeader)).toEqual({ email: "u@example.com", roles: ["admin"] });
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
            new Request("https://app.example/_lunora/rpc", {
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
            allowUnauthenticatedShardAccess: true,
            queryCoordinator: {
                fanOut: fanOut as never,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: fanOut as never,
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveIdentity: () => {
                return { email: "u@example.com", userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(fanOut).toHaveBeenCalledTimes(1);

        const { headers } = fanOut.mock.calls[0]![1];

        expect(headers["x-lunora-userid"]).toBe("user_42");
        expect(decodeIdentityHeader(headers["x-lunora-identity"])).toEqual({ email: "u@example.com" });
    });

    it("denies fan-out by default when authorizeShard is set without authorizeFanOut", async () => {
        expect.assertions(4);

        const fanOut = vi.fn<() => never>();
        const worker = createWorker({
            authorizeShard: () => true,
            queryCoordinator: {
                fanOut,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_FANOUT" } });
        expect(fanOut).not.toHaveBeenCalled();
        // No per-shard dispatch either: the default-deny fires before any forward.
        expect(shard.calls).toHaveLength(0);
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveIdentity: () => {
                return { userId: "user_42" };
            },
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
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
        expect.assertions(4);

        const fanOut = vi.fn<() => never>();
        const worker = createWorker({
            authorizeFanOut: () => false,
            queryCoordinator: {
                fanOut,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_FANOUT" } });
        expect(fanOut).not.toHaveBeenCalled();
        // No per-shard dispatch either: the deny fires before any forward.
        expect(shard.calls).toHaveLength(0);
    });

    it("denies a single-shard RPC with 403 FORBIDDEN_SHARD when authorizeShard returns false", async () => {
        expect.assertions(3);

        const authorizeShard = vi.fn<() => boolean>(() => false);
        const worker = createWorker({
            authorizeShard,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list", shardKey: "channel-42" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_SHARD" } });
        // The gate must short-circuit before any shard dispatch happens.
        expect(shard.calls).toHaveLength(0);
    });

    it("exempts a reserved `__lunora_admin__:*` RPC from authorizeShard (the DO's admin-bearer gate authorizes it)", async () => {
        expect.assertions(4);

        // Even with a fail-closed `authorizeShard`, a token-gated admin RPC must
        // reach the shard DO (the real admin authority) instead of being 403'd by
        // the per-tenant gate — an admin request carries an admin bearer, not an
        // end-user identity, so `authorizeShard(null, …)` would default-deny it.
        // Regression: this broke E2E mail-capture once the playground configured
        // `authorizeShard`.
        const authorizeShard = vi.fn<() => boolean>(() => false);
        const worker = createWorker({
            authorizeShard,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                // A real admin bearer rides the `authorization` header; this
                // worker-level test only proves the tenant gate is skipped, so the
                // mock shard (standing in for the DO's `isAdminAuthorized`) accepts
                // it unconditionally.
                body: JSON.stringify({ args: { limit: 50 }, functionPath: "__lunora_admin__:getCapturedMail" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        // The per-tenant gate must NOT be consulted for a reserved admin op…
        expect(authorizeShard).not.toHaveBeenCalled();
        // …and the request must be forwarded to the (default __root__) shard,
        // whose `isAdminAuthorized` bearer check is the real gate.
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]!.shardKey).toBe("__root__");
    });

    it.each([
        ["unknown merge kind", { merge: { kind: "bogus" }, table: "messages" }],
        ["negative topK.k", { merge: { by: "score", k: -1, kind: "topK" }, table: "messages" }],
        ["missing topK.k", { merge: { by: "score", kind: "topK" }, table: "messages" }],
        ["non-integer topK.k", { merge: { by: "score", k: 1.5, kind: "topK" }, table: "messages" }],
        ["missing topK.by", { merge: { k: 5, kind: "topK" }, table: "messages" }],
        ["missing table", { merge: { kind: "concat" } }],
        ["missing merge", { table: "messages" }],
    ])("rejects malformed fan-out merge shape (%s) with 400 before the coordinator", async (_label, fanOutSpec) => {
        expect.assertions(2);

        const fanOut = vi.fn<() => never>();
        const worker = createWorker({
            authorizeFanOut: () => true,
            queryCoordinator: {
                fanOut,
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, fanOut: fanOutSpec, functionPath: "messages:list" }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        expect(fanOut).not.toHaveBeenCalled();
    });
});

describe("createWorker — RPC batch forward failure (Plan 118 toErrorBody migration)", () => {
    // Plan 118: the batch fan-out's per-sub-batch `forwardToShard` catch now
    // routes the caught error through `toErrorBody` instead of embedding its raw
    // `.message` directly into every entry's slot error. Pin both branches: an
    // unrecognized throw (e.g. a network failure reaching the shard) is redacted,
    // while a recognized `LunoraError` still surfaces its real code/message. The
    // slot status stays the protocol-level 502 regardless (independent of the
    // underlying error), per the existing "shard unreachable" contract.
    const unreachableNamespace = (thrown: Error): ShardNamespaceLike => {
        return {
            get: () => {
                return {
                    fetch: (): Promise<Response> => Promise.reject(thrown),
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
    };

    it("redacts an unrecognized shard-forward failure instead of leaking its raw message", async () => {
        expect.assertions(3);

        const worker = createWorker({ shardDO: unreachableNamespace(new Error("connect ECONNREFUSED 10.0.0.1:443")) });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc-batch", {
                body: JSON.stringify({ calls: [{ functionPath: "messages:list", id: 0 }] }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);

        const body = await res.json<{ results: { body: { error: { code: string; message: string } }; status: number }[] }>();

        expect(body.results).toHaveLength(1);
        expect(body.results[0]).toMatchObject({ body: { error: { code: "SHARD_UNAVAILABLE", message: "shard unavailable" } }, status: 502 });
    });

    it("still surfaces a recognized LunoraError's real code + message on a shard-forward failure", async () => {
        expect.assertions(2);

        const structured = new LunoraError("CONFLICT", "cross-shard join guard tripped", { status: 409 });
        const worker = createWorker({ shardDO: unreachableNamespace(structured) });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc-batch", {
                body: JSON.stringify({ calls: [{ functionPath: "messages:list", id: 0 }] }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        const body = await res.json<{ results: { body: { error: { code: string; message: string } }; status: number }[] }>();

        expect(body.results).toHaveLength(1);
        expect(body.results[0]).toMatchObject({ body: { error: { code: "CONFLICT", message: "cross-shard join guard tripped" } }, status: 502 });
    });
});

describe("createWorker — RPC batch cross-shard bookmark", () => {
    // A namespace whose per-shard `/rpc-batch` reply echoes the demux-shaped
    // `{ results }` and attaches an `x-d1-bookmark` only for the shard keys in
    // `bookmarks`. Lets a test span shards where only some produce a bookmark.
    const bookmarkingNamespace = (bookmarks: Record<string, string>): ShardNamespaceLike => {
        return {
            get: (id) => {
                const shardKey = (id as { __name: string }).__name;

                return {
                    fetch: async (request: Request): Promise<Response> => {
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- request.json() is Promise<unknown> under the build tsconfig; the assertion is required there
                        const { calls } = (await request.json()) as { calls: { id: string }[] };
                        const results = calls.map((call) => {
                            return { body: { shardKey }, id: call.id, status: 200 };
                        });
                        const headers: Record<string, string> = { "content-type": "application/json" };
                        const bookmark = bookmarks[shardKey];

                        if (bookmark !== undefined) {
                            headers["x-d1-bookmark"] = bookmark;
                        }

                        return Response.json({ results }, { headers, status: 200 });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
    };

    const batchRequest = (calls: unknown[]): Request =>
        new Request("https://app.example/_lunora/rpc-batch", { body: JSON.stringify({ calls }), method: "POST" });

    it("echoes the bookmark when exactly one shard in the batch produced one", async () => {
        expect.assertions(1);

        // Shard "a" (the mutation) emits a bookmark; shard "b" (a read) does not.
        // The single producer's bookmark is safe to pin the client's next read to.
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: bookmarkingNamespace({ a: "bm-a" }) });

        const res = await worker.fetch(
            batchRequest([
                { functionPath: "messages:send", id: 0, shardKey: "a" },
                { functionPath: "messages:list", id: 1, shardKey: "b" },
            ]),
            {},
            fakeContext,
        );

        expect(res.headers.get("x-d1-bookmark")).toBe("bm-a");
    });

    it("omits the bookmark when the batch spans shards that each produced one (not comparable across sources)", async () => {
        expect.assertions(1);

        // Two distinct shards each return a bookmark; their D1 bookmarks are from
        // different sources and aren't comparable, so pinning the client to an
        // arbitrary one would silently break read-your-writes — omit instead.
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: bookmarkingNamespace({ a: "bm-a", b: "bm-b" }) });

        const res = await worker.fetch(
            batchRequest([
                { functionPath: "messages:send", id: 0, shardKey: "a" },
                { functionPath: "messages:send", id: 1, shardKey: "b" },
            ]),
            {},
            fakeContext,
        );

        expect(res.headers.get("x-d1-bookmark")).toBeNull();
    });
});

describe("createWorker — RPC batch body-shape guard (RUNTIME-04)", () => {
    // `handleBatchRpc` used to run its own `typeof body !== "object" || …` check
    // by hand after parsing; it now delegates to `readJsonBodyWithLimit`, which
    // applies the same guard for every caller. These pin the batch endpoint's
    // observable behavior (still 400, never forwarded) across that refactor.
    const shard = createShardSpy();

    it("rejects a literal `null` batch body with 400", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/rpc-batch", { body: "null", method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("rejects a batch body that parses to an array with 400", async () => {
        expect.assertions(1);

        const worker = createWorker({ shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/_lunora/rpc-batch", { body: "[1,2]", method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(400);
    });
});

describe("createWorker — x402 paid procedures", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    /** Structural shape of the injected `x402Charge` gate (the type is internal to create-worker). */
    type ChargeGateStub = (
        request: Request,
        spec: { functionPath: string; price: number | string },
        dispatch: () => Promise<Response>,
        deps?: { waitUntil?: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;

    /** A registry with one paid `.x402({ price })`-tagged query. */
    const paidFunctions = { "reports:latest": { kind: "query", x402: { price: "$0.05" } } } as const;

    /** A single paid RPC POST for `functionPath`, merging any extra envelope fields (e.g. `fanOut`). */
    const paidRpc = (functionPath: string, extra: Record<string, unknown> = {}): Request =>
        new Request("https://app.example/_lunora/rpc", {
            body: JSON.stringify({ args: {}, functionPath, ...extra }),
            method: "POST",
        });

    it("fail-closes a paid function with no x402Charge gate: 500, never served free", async () => {
        expect.assertions(3);

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions: paidFunctions, shardDO: shard.namespace });

        const res = await worker.fetch(paidRpc("reports:latest"), {}, fakeContext);

        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "MISCONFIGURED" } });
        // The crown jewel: a paid function without a paywall is refused, NOT dispatched free.
        expect(shard.calls).toHaveLength(0);
    });

    it("runs the injected charge gate around dispatch and withholds the shard when unpaid", async () => {
        expect.assertions(4);

        // A gate that always challenges (unpaid): it must never invoke `dispatch`.
        const x402Charge = vi.fn<ChargeGateStub>(() => Promise.resolve(new Response(null, { status: 402 })));

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const res = await worker.fetch(paidRpc("reports:latest"), {}, fakeContext);

        expect(res.status).toBe(402);
        expect(x402Charge).toHaveBeenCalledTimes(1);
        // The gate is handed the paid function's path + declared price as the charge spec.
        expect(x402Charge.mock.calls[0]![1]).toStrictEqual({ functionPath: "reports:latest", price: "$0.05" });
        // Unpaid: the gate never ran `dispatch`, so no shard was touched.
        expect(shard.calls).toHaveLength(0);
    });

    it("dispatches to the shard once the gate settles the payment", async () => {
        expect.assertions(2);

        // A gate that treats the request as paid: run the real dispatch.
        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const res = await worker.fetch(paidRpc("reports:latest"), {}, fakeContext);

        expect(res.status).toBe(200);
        // Paid: the gate ran `dispatch`, forwarding to the shard exactly once.
        expect(shard.calls).toHaveLength(1);
    });

    it("threads ctx.waitUntil into the charge gate so the settlement receipt survives past the response", async () => {
        expect.assertions(4);

        // A paid gate that just dispatches — we only care about the `deps` (4th arg) it receives.
        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        // A spy `waitUntil` on the execution context: the gate's forwarded `waitUntil`
        // must be bound to *this*, not a bare no-op — a wrong binding silently drops the receipt.
        const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
        const ctx: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil };

        const res = await worker.fetch(paidRpc("reports:latest"), {}, ctx);

        expect(res.status).toBe(200);

        const deps = x402Charge.mock.calls[0]![3];

        expect(deps?.waitUntil).toBeTypeOf("function");

        // Invoking the forwarded `waitUntil` must reach the context's `waitUntil` with the same promise.
        const receipt = Promise.resolve();

        deps!.waitUntil!(receipt);

        expect(waitUntil).toHaveBeenCalledWith(receipt);
        expect(shard.calls).toHaveLength(1);
    });

    it("refuses to fan out a paid function: 400, gate never consulted, coordinator untouched", async () => {
        expect.assertions(3);

        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());
        const fanOut = vi.fn<() => never>();

        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            // Allow the fan-out past the authorization gate so the paid-fan-out refusal is what's under test.
            authorizeFanOut: () => true,
            functions: paidFunctions,
            queryCoordinator: { fanOut } as never,
            shardDO: shard.namespace,
            x402Charge,
        });

        const res = await worker.fetch(paidRpc("reports:latest", { fanOut: { merge: { kind: "concat" }, table: "reports" } }), {}, fakeContext);

        expect(res.status).toBe(400);
        // A paid fan-out is one payment fanned across N shards — refused before the gate or the coordinator runs.
        expect(x402Charge).not.toHaveBeenCalled();
        expect(fanOut).not.toHaveBeenCalled();
    });

    it("rejects a paid function inside a batch: 400 for the whole batch, no shard forward", async () => {
        expect.assertions(3);

        const x402Charge = vi.fn<ChargeGateStub>((_request, _spec, dispatch) => dispatch());

        const worker = createWorker({ allowUnauthenticatedShardAccess: true, functions: paidFunctions, shardDO: shard.namespace, x402Charge });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc-batch", {
                body: JSON.stringify({
                    calls: [
                        { functionPath: "messages:list", id: 0 },
                        { functionPath: "reports:latest", id: 1 },
                    ],
                }),
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
        // The batch is refused whole — no entry (paid or free) reaches a shard, and the gate never runs.
        expect(shard.calls).toHaveLength(0);
    });
});

describe("createWorker — migration endpoint", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    const migrateRequest = (body: unknown, headers: Record<string, string> = {}): Request =>
        new Request("https://app.example/_lunora/migrate", { body: JSON.stringify(body), headers, method: "POST" });

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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: orchestrateMigration as never,
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            migrateRequest(
                { args: { direction: "up", id: "backfill" }, functionPath: "__lunora_admin__:runMigration", table: "messages" },
                { authorization: "Bearer s3cret" },
            ),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ changed: 3, ok: 2, status: "completed" });
        expect(orchestrateMigration).toHaveBeenCalledTimes(1);

        const request = orchestrateMigration.mock.calls[0]![1];

        expect(request).toMatchObject({ args: { direction: "up", id: "backfill" }, functionPath: "__lunora_admin__:runMigration", table: "messages" });
        expect(request.headers.authorization).toBe("Bearer s3cret");
    });

    it("400s when no queryCoordinator is configured", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: "s3cret", shardDO: shard.namespace });

        const res = await worker.fetch(
            migrateRequest({ functionPath: "__lunora_admin__:runMigration", table: "messages" }, { authorization: "Bearer s3cret" }),
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(migrateRequest({ functionPath: "__lunora_admin__:runMigration" }, { authorization: "Bearer s3cret" }), {}, fakeContext);

        expect(res.status).toBe(400);
    });

    it("rejects non-POST with 405", async () => {
        expect.assertions(1);

        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/_lunora/migrate"), {}, fakeContext);

        expect(res.status).toBe(405);
    });
});

/**
 * Bindings the runtime injects on the env when dispatching to the HTTP router.
 * Mirrors `@lunora/server`'s `LunoraHttpEnv` without importing the server
 * package — the runtime stays structurally hono-free.
 */
interface ContextEnv {
    Bindings: { __lunoraCtx?: HttpActionContext };
    Variables: { lunora: HttpActionContext };
}

/**
 * Build a real hono app pre-wired with the same `__lunoraCtx` → `c.var.lunora`
 * lift that `@lunora/server`'s `httpRouter()` installs, then let the test
 * register routes on it. Returned as an {@link HttpRouterLike} (`{ fetch }`).
 */
const honoApp = (register: (app: Hono<ContextEnv>) => void): HttpRouterLike => {
    const app = new Hono<ContextEnv>();

    app.use("*", async (c, next) => {
        const injected = c.env.__lunoraCtx;

        if (injected) {
            c.set("lunora", injected);
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

    it("an empty `routes: {}` does not shadow a matching httpRouter route", async () => {
        expect.assertions(2);

        // The generated composed/app workers pass a literal `routes: {}` (never
        // undefined); the construction-time check must treat that as "no routes"
        // so the empty map can't intercept an httpRouter match.
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/ping", () => new Response("pong", { status: 201 }))),
            routes: {},
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/ping"), {}, fakeContext);

        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe("pong");
    });

    it("c.var.lunora.scheduler.runAfter reaches the scheduler DO", async () => {
        expect.assertions(5);

        // "receive webhook → enqueue the real work → return
        // 200" is the most common HTTP-action shape, and HttpActionCtx had no
        // scheduler. Apps hopped through a mutation and, because a function
        // reference cannot cross the RPC boundary, named targets by string —
        // which on an unauthenticated webhook endpoint is a "call any internal
        // function" primitive needing a closed allow-list.
        const scheduler = createShardSpy(Response.json({ id: "job-1", scheduledFor: 1 }, { status: 200 }));

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/hooks/stripe", async (c) => {
                    const id = await c.var.lunora.scheduler?.runAfter(0, { __lunoraRef: "billing:sync" }, { eventId: "evt_1" });

                    return new Response(id ?? "no-scheduler", { status: 202 });
                }),
            ),
            schedulerDO: scheduler.namespace,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/hooks/stripe", { method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(202);
        await expect(res.text()).resolves.toBe("job-1");
        expect(scheduler.calls).toHaveLength(1);

        const body = (await scheduler.calls[0]?.request.json()) as Record<string, unknown>;

        expect(body).toMatchObject({ args: { eventId: "evt_1" }, functionPath: "billing:sync" });
        // No origin is sent. The DO takes its callback origin from
        // `env.LUNORA_ORIGIN_URL` at both schedule and fire time, deliberately,
        // so a request cannot steer where the job dispatches back to.
        expect(body["originUrl"]).toBeUndefined();
    });

    it("c.var.lunora.storage stores an object through the worker's own R2 binding", async () => {
        expect.assertions(4);

        // HttpActionCtx had no `storage`, so an HTTP handler could not store an
        // upload or mint a presigned URL. R2 is a worker binding, so this needs
        // no shard hop — the omission was incidental, and it propagated: any
        // helper the ctx was threaded into had to be typed for its
        // storage-touching branch, barring HTTP callers from the whole helper.
        const stored: { body: unknown; key: string }[] = [];
        const bucketStorage = {
            getSignedUrl: (key: string) => Promise.resolve(`https://cdn.example/${key}?sig=x`),
            store: (key: string, body: unknown) => {
                stored.push({ body, key });

                return Promise.resolve({ key });
            },
        };

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/upload", async (c) => {
                    const storage = c.var.lunora.storage as typeof bucketStorage & { bucket: (name?: string) => typeof bucketStorage };

                    await storage.store("receipts/1.pdf", "bytes");

                    return new Response(await storage.getSignedUrl("receipts/1.pdf"), { status: 201 });
                }),
            ),
            shardDO: shard.namespace,
            storage: () => bucketStorage,
        });

        const res = await worker.fetch(new Request("https://app.example/upload", { method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe("https://cdn.example/receipts/1.pdf?sig=x");
        expect(stored).toStrictEqual([{ body: "bytes", key: "receipts/1.pdf" }]);

        // Tagged bucket-aware on the way in, so `.bucket(name)` resolves for a
        // single-bucket app exactly as it does inside a shard.
        const probe = await worker.fetch(new Request("https://app.example/upload", { method: "POST" }), {}, fakeContext);

        expect(probe.status).toBe(201);
    });

    it("leaves ctx.storage absent when the app declared no storage", async () => {
        expect.assertions(2);

        // Absent rather than a throwing stub — that is what makes the optional
        // `storage` on `HttpActionCtx` an honest signal instead of a type that
        // lies about what the handler can reach.
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/probe", (c) => new Response(String(c.var.lunora.storage === undefined), { status: 200 }))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/probe"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("true");
    });

    it("refuses a bare function-path string as a scheduler target", async () => {
        expect.assertions(2);

        // An HTTP action can be reached unauthenticated, so accepting a
        // caller-shaped `"ns:fn"` here would be a "call any internal function"
        // primitive — the very thing this surface exists to avoid. `run()`
        // beside it rejects anything without `__lunoraRef` for the same reason.
        const scheduler = createShardSpy(Response.json({ id: "job-1" }, { status: 200 }));

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/hooks/evil", async (c) => {
                    try {
                        await c.var.lunora.scheduler?.runAfter(0, c.req.header("x-job") ?? "", {});

                        return new Response("accepted", { status: 200 });
                    } catch {
                        return new Response("refused", { status: 400 });
                    }
                }),
            ),
            schedulerDO: scheduler.namespace,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/hooks/evil", { headers: { "x-job": "admin:deleteEverything" }, method: "POST" }),
            {},
            fakeContext,
        );

        await expect(res.text()).resolves.toBe("refused");
        expect(scheduler.calls).toHaveLength(0);
    });

    it("ctx.scheduler.list() returns the records array, walking every page the DO answers", async () => {
        expect.assertions(3);

        // The DO answers ONE bounded page plus `{ truncated, cursor }`. Handing
        // the raw body back would return an object where an array is declared —
        // and would drop every job past the first page on the floor.
        const paths: string[] = [];
        const schedulerNamespace: ShardNamespaceLike = {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        const url = new URL(request.url);

                        paths.push(`${url.pathname}${url.search}`);

                        if (url.searchParams.get("cursor") === "id:b") {
                            return Response.json({ records: [{ id: "c" }], truncated: false });
                        }

                        return Response.json({ cursor: "id:b", records: [{ id: "a" }, { id: "b" }], truncated: true });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };

        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/jobs", async (c) => Response.json(await (c.var.lunora.scheduler?.list() ?? Promise.resolve([]))))),
            schedulerDO: schedulerNamespace,
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/jobs"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toStrictEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
        expect(paths).toStrictEqual(["/list", "/list?cursor=id%3Ab"]);
    });

    it("leaves ctx.scheduler undefined when the worker declares no schedulerDO", async () => {
        expect.assertions(2);

        // Optional rather than a throwing stub: an app that never declared
        // `.scheduler(...)` should see the capability absent, and `?.` is the
        // documented way to branch on it.
        const worker = createWorker({
            httpRouter: honoApp((app) => app.get("/probe", (c) => new Response(String(c.var.lunora.scheduler === undefined), { status: 200 }))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/probe"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("true");
    });

    it("c.var.lunora.runMutation forwards an RPC envelope to the default shard and unwraps `{ result }`", async () => {
        expect.assertions(6);

        shard.response = Response.json({ result: { id: "m1" } });

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/webhook", async (c) => {
                    const body = await c.req.json();
                    const created = await c.var.lunora.runMutation({ __lunoraRef: "messages:send" }, { body });

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

    it("marks a route's `ctx.run*` as a trusted system dispatch, so `internal` functions are reachable", async () => {
        expect.assertions(3);

        shard.response = Response.json({ result: "cell_1" });

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/v1/cells", async (c) => Response.json({ cellId: await c.var.lunora.runMutation({ __lunoraRef: "cells:register" }, { name: "c" }) })),
            ),
            resolveIdentity: () => {
                return { userId: "user_7" };
            },
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/v1/cells", { method: "POST" }), {}, fakeContext);

        expect(res.status).toBe(200);

        // The whole point: `handleRpc` refuses an `internal` function to any caller
        // without this flag, so an operator/webhook/ingest route delegating to one
        // used to fail with FUNCTION_NOT_FOUND surfaced as a 500.
        expect(shard.calls[0]!.request.headers.get("x-lunora-system")).toBe("1");

        // And it widens visibility ONLY — the caller's identity still rides along,
        // so RLS and ownership checks inside the function are unchanged.
        expect(shard.calls[0]!.request.headers.get("x-lunora-userid")).toBe("user_7");
    });

    it("exposes resolveIdentity on c.var.lunora.auth", async () => {
        expect.assertions(1);

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.get("/me", async (c) => Response.json({ claims: await c.var.lunora.auth.getIdentity(), userId: c.var.lunora.auth.userId })),
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

    it("exposes ctx.cache on c.var.lunora.cache for HTTP action handlers", async () => {
        expect.assertions(3);

        const purgedTags: string[] = [];
        const fakeCacheContext: ExecutionContextLike = {
            ...fakeContext,
            cache: {
                purge: async (options: { purgeEverything?: boolean; tags?: string[] }) => {
                    if (options.tags) {
                        purgedTags.push(...options.tags);
                    }
                },
            },
        };

        const worker = createWorker({
            httpRouter: honoApp((app) =>
                app.post("/purge", async (c) => {
                    await c.var.lunora.cache!.purge({ tags: ["products", "users"] });

                    return new Response("ok");
                }),
            ),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/purge", { method: "POST" }), {}, fakeCacheContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("ok");
        expect(purgedTags).toEqual(["products", "users"]);
    });

    it("the internal RPC path is never shadowed by a catch-all router", async () => {
        expect.assertions(3);

        const action = vi.fn<() => Response>(() => new Response("action"));

        const worker = createWorker({
            httpRouter: honoApp((app) => app.all("*", action)),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(action).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });
});

describe("composeWorker — meta-framework composition (PLAN4 §2.2)", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("routes /_lunora/* to Lunora rather than the httpRouter", async () => {
        expect.assertions(3);

        const ssr = vi.fn<() => Response>(() => new Response("ssr"));

        const worker = composeWorker({
            httpRouter: honoApp((app) => app.all("*", ssr)),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(ssr).not.toHaveBeenCalled();
        expect(shard.calls).toHaveLength(1);
    });

    it("falls through a non-reserved path to the httpRouter SSR handler", async () => {
        expect.assertions(3);

        const worker = composeWorker({
            httpRouter: honoApp((app) => app.get("/about", () => new Response("rendered", { status: 200 }))),
            shardDO: shard.namespace,
        });

        const res = await worker.fetch(new Request("https://app.example/about"), {}, fakeContext);

        expect(res.status).toBe(200);
        await expect(res.text()).resolves.toBe("rendered");
        expect(shard.calls).toHaveLength(0);
    });

    it("isolates a throwing SSR render as a 500 while /_lunora/* stays serviceable", async () => {
        expect.assertions(4);

        // Swallow the expected server-side log so the deliberate throw doesn't
        // spam the test output.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const worker = composeWorker({
            httpRouter: honoApp((app) =>
                app.get("/boom", () => {
                    throw new Error("SSR render exploded");
                }),
            ),
            shardDO: shard.namespace,
        });

        // A throwing SSR render is contained at the seam and surfaced as a 500 —
        // the raw message is never echoed to the client.
        const ssrRes = await worker.fetch(new Request("https://app.example/boom"), {}, fakeContext);

        expect(ssrRes.status).toBe(500);
        await expect(ssrRes.text()).resolves.not.toContain("SSR render exploded");

        // The SAME worker still services the realtime plane: a subsequent
        // /_lunora/rpc request forwards to the shard and succeeds.
        const rpcRes = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
            fakeContext,
        );

        expect(rpcRes.status).toBe(200);
        expect(shard.calls).toHaveLength(1);

        errorSpy.mockRestore();
    });
});

describe("createLunoraHandler — framework-neutral mount seam", () => {
    let shard: ShardSpy;

    beforeEach(() => {
        shard = createShardSpy();
    });

    it("defaults shardDO to env.SHARD and forwards /_lunora/rpc", async () => {
        expect.assertions(2);

        const handler = createLunoraHandler();

        const res = await handler(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            { SHARD: shard.namespace },
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(shard.calls).toHaveLength(1);
    });

    it("honours an explicit shardDO over env.SHARD", async () => {
        expect.assertions(2);

        const ignored = createShardSpy();
        const handler = createLunoraHandler({ shardDO: shard.namespace });

        const res = await handler(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            { SHARD: ignored.namespace },
            fakeContext,
        );

        expect(res.status).toBe(200);
        expect(ignored.calls).toHaveLength(0);
    });

    it("supports an (env) => options factory", async () => {
        expect.assertions(1);

        const handler = createLunoraHandler((env) => {
            return { shardDO: (env as { CUSTOM: ShardNamespaceLike }).CUSTOM };
        });

        const res = await handler(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            { CUSTOM: shard.namespace },
            fakeContext,
        );

        expect(res.status).toBe(200);
    });

    it("defaults the ExecutionContext when the host omits one", async () => {
        expect.assertions(1);

        const handler = createLunoraHandler({ shardDO: shard.namespace });

        const res = await handler(
            new Request("https://app.example/_lunora/rpc", { body: JSON.stringify({ args: {}, functionPath: "x:y" }), method: "POST" }),
            {},
        );

        expect(res.status).toBe(200);
    });

    it("throws a clear error when no shard namespace resolves", () => {
        expect.assertions(1);

        const handler = createLunoraHandler();

        expect(() => handler(new Request("https://app.example/_lunora/rpc", { method: "POST" }), {})).toThrow(/no shard Durable Object namespace/);
    });
});

describe("createWorker auth-metrics instrumentation (PLAN3 §2.3)", () => {
    let shard: ShardSpy;
    /** Captures `waitUntil` promises so the test can await the fire-and-forget recording. */
    let deferred: Promise<unknown>[];
    let collectingContext: ExecutionContextLike;

    beforeEach(() => {
        shard = createShardSpy();
        deferred = [];
        collectingContext = {
            passThroughOnException: () => undefined,
            waitUntil: (promise) => {
                deferred.push(promise);
            },
        };
    });

    it("records a `fail` event when an auth sign-in route answers with status >= 400", async () => {
        expect.assertions(3);

        const authHandler = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("nope", { status: 401 }));

        const worker = createWorker({ adminToken: "s3cret", authHandler, shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/api/auth/sign-in/email", { method: "POST" }), {}, collectingContext);

        expect(res.status).toBe(401);

        // Drain the fire-and-forget recording.
        await Promise.all(deferred);

        const recordCall = shard.calls.find((c) => c.request.url.endsWith("/rpc"));

        expect(recordCall).toBeDefined();

        const body = await recordCall!.request.json<{ args: { outcome: string }; functionPath: string }>();

        expect(body).toEqual({ args: { outcome: "fail" }, functionPath: "__lunora_admin__:recordAuthEvent" });
    });

    it("records an `ok` event for a successful sign-up attempt", async () => {
        expect.assertions(1);

        const authHandler = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("ok", { status: 200 }));

        const worker = createWorker({ adminToken: "s3cret", authHandler, shardDO: shard.namespace });

        await worker.fetch(new Request("https://app.example/api/auth/sign-up/email", { method: "POST" }), {}, collectingContext);
        await Promise.all(deferred);

        const recordCall = shard.calls.find((c) => c.request.url.endsWith("/rpc"));
        const body = await recordCall!.request.json<{ args: { outcome: string } }>();

        expect(body.args.outcome).toBe("ok");
    });

    it("does NOT record for a non-attempt auth route (get-session)", async () => {
        expect.assertions(2);

        const authHandler = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("session", { status: 200 }));

        const worker = createWorker({ adminToken: "s3cret", authHandler, shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/api/auth/get-session", { method: "GET" }), {}, collectingContext);
        await Promise.all(deferred);

        expect(res.status).toBe(200);
        // No recording fired — get-session is not an attempt.
        expect(shard.calls.filter((c) => c.request.url.endsWith("/rpc"))).toHaveLength(0);
    });

    it("skips recording silently when no admin token is configured", async () => {
        expect.assertions(2);

        const authHandler = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("nope", { status: 403 }));

        const worker = createWorker({ authHandler, shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/api/auth/callback/github", { method: "GET" }), {}, collectingContext);
        await Promise.all(deferred);

        expect(res.status).toBe(403);
        expect(shard.calls.filter((c) => c.request.url.endsWith("/rpc"))).toHaveLength(0);
    });

    it("falls through to normal routing when the auth handler returns undefined", async () => {
        expect.assertions(2);

        const authHandler = vi.fn<(request: Request) => Promise<Response | undefined>>(async () => undefined);

        const worker = createWorker({ adminToken: "s3cret", authHandler, shardDO: shard.namespace });

        const res = await worker.fetch(new Request("https://app.example/nope", { method: "GET" }), {}, collectingContext);

        expect(res.status).toBe(404);
        expect(authHandler).toHaveBeenCalledTimes(1);
    });
});

describe("createWorker — relay-tier routing (plan 075 Phase 2)", () => {
    interface Forward {
        binding: null | string;
        name: string;
        system: null | string;
        userId: null | string;
    }

    const routingNamespace = (relayCount: number, forwards: Forward[]): ShardNamespaceLike => {
        return {
            get: (id) => {
                const name = (id as { __name: string }).__name;

                return {
                    fetch: async (request: Request) => {
                        if (new URL(request.url).pathname === "/_lunora/route") {
                            return Response.json({ relayCount }, { headers: { "content-type": "application/json" } });
                        }

                        forwards.push({
                            binding: request.headers.get("x-lunora-shard-binding"),
                            name,
                            system: request.headers.get("x-lunora-system"),
                            userId: request.headers.get("x-lunora-userid"),
                        });

                        return new Response(null, { status: 101 });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
    };

    const upgrade = (shardKey: string): Request => new Request(`https://app.example/_lunora/ws?shard=${shardKey}`, { headers: { Upgrade: "websocket" } });

    it("routes a new WS connection on a promoted shard to one of its relays", async () => {
        expect.assertions(3);

        const forwards: Forward[] = [];
        const namespace = routingNamespace(2, forwards);
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });

        await worker.fetch(upgrade("promoted-a"), { SHARD: namespace }, fakeContext);

        expect(forwards).toHaveLength(1);
        expect(forwards[0]?.name).toMatch(/^promoted-a::relay::[01]$/u); // routed to a relay
        expect(forwards[0]?.binding).toBe("SHARD"); // told the DO its namespace binding
    });

    it("spreads connections across the relay set and hints the client's region", async () => {
        expect.assertions(3);

        const placements: unknown[] = [];
        const forwards: Forward[] = [];
        const base = routingNamespace(4, forwards);
        const namespace: ShardNamespaceLike = {
            ...base,
            get: (id, options) => {
                placements.push(options);

                return base.get(id);
            },
        };
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });
        const fromParis = (): Request => Object.assign(upgrade("promoted-r"), { cf: { continent: "EU", longitude: "2.35" } });

        // Enough connections that a spread over four relays is overwhelmingly
        // likely to touch more than one — the point being that a whole region
        // must NOT collapse onto a single relay, which is the wall promotion
        // exists to escape.
        for (let attempt = 0; attempt < 40; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential upgrades: each one's routing decision is what is under test
            await worker.fetch(fromParis(), { SHARD: namespace }, fakeContext);
        }

        expect(new Set(forwards.map((forward) => forward.name)).size).toBeGreaterThan(1);
        expect(forwards.every((forward) => /^promoted-r::relay::[0-3]$/u.test(forward.name))).toBe(true);
        // Every relay is nonetheless CREATED in the caller's region — that is
        // what puts the socket near the client without pinning load.
        expect(placements).toContainEqual({ locationHint: "weur" });
    });

    it("keeps a new WS connection on the owner when the shard is not promoted", async () => {
        expect.assertions(2);

        const forwards: Forward[] = [];
        const namespace = routingNamespace(0, forwards);
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });

        await worker.fetch(upgrade("cold-b"), { SHARD: namespace }, fakeContext);

        expect(forwards).toHaveLength(1);
        expect(forwards[0]?.name).toBe("cold-b"); // owner-served
    });

    it("stays owner-served when the namespace binding can't be found (relay tier inert)", async () => {
        expect.assertions(2);

        const forwards: Forward[] = [];
        const namespace = routingNamespace(2, forwards);
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });

        // `env` does not expose the namespace → no binding → no probe, no relay routing.
        await worker.fetch(upgrade("cold-c"), {}, fakeContext);

        expect(forwards[0]?.name).toBe("cold-c");
        expect(forwards[0]?.binding).toBeNull();
    });

    it("strips forged x-lunora-* headers from the upgrade before forwarding to the DO", async () => {
        expect.assertions(4);

        const forwards: Forward[] = [];
        const namespace = routingNamespace(2, forwards);
        const worker = createWorker({ allowUnauthenticatedShardAccess: true, shardDO: namespace });

        // Attacker forges control headers on the WS upgrade. With `env` not exposing
        // the namespace, `resolveShardBindingName` returns undefined, so the forged
        // `x-lunora-shard-binding` is never overwritten — it must be *stripped*
        // instead, along with the forged `x-lunora-system`/`x-lunora-userid`.
        const forged = new Request("https://app.example/_lunora/ws?shard=forged-d", {
            headers: {
                Upgrade: "websocket",
                "x-lunora-shard-binding": "EVIL",
                "x-lunora-system": "1",
                "x-lunora-userid": "attacker",
            },
        });

        await worker.fetch(forged, {}, fakeContext);

        expect(forwards).toHaveLength(1);
        expect(forwards[0]?.binding).toBeNull(); // forged "EVIL" stripped, no binding resolved to re-set it
        expect(forwards[0]?.system).toBeNull(); // forged x-lunora-system stripped
        expect(forwards[0]?.userId).toBeNull(); // forged x-lunora-userid stripped (anonymous upgrade)
    });
});

describe("createWorker — voice-session upgrade", () => {
    /** Records the `x-lunora-*` headers the voice DO actually receives. */
    const voiceNamespace = (seen: { headers: string[]; name: string }[]): ShardNamespaceLike => {
        return {
            get: (id) => {
                const name = (id as { __name: string }).__name;

                return {
                    fetch: async (request: Request) => {
                        seen.push({ headers: [...request.headers.keys()].filter((key) => key.startsWith("x-lunora-")), name });

                        return new Response(null, { status: 101 });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
    };

    it("strips every forged x-lunora-* header from the voice upgrade before forwarding", async () => {
        expect.assertions(2);

        const seen: { headers: string[]; name: string }[] = [];
        const namespace = voiceNamespace(seen);
        const worker = createWorker({
            allowUnauthenticatedShardAccess: true,
            shardDO: namespace,
            voiceAgents: { support: namespace },
        });

        // Six forged headers, not three: a strip that deletes from a LIVE `Headers`
        // iterator skips every second entry, and because iteration is sorted the
        // attacker picks which one survives by padding with decoys. The decoys are
        // named so `x-lunora-system` — the trusted-server-dispatch flag — is one of
        // the survivors under the broken loop.
        const forged = new Request("https://app.example/_lunora/voice/support?threadKey=t1", {
            headers: {
                Upgrade: "websocket",
                "x-lunora-aaa": "1",
                "x-lunora-bbb": "1",
                "x-lunora-ccc": "1",
                "x-lunora-ddd": "1",
                "x-lunora-shard-binding": "EVIL",
                "x-lunora-system": "1",
            },
        });

        await worker.fetch(forged, {}, fakeContext);

        expect(seen).toHaveLength(1);
        // Anonymous upgrade: nothing server-minted is re-set, so NOTHING may survive.
        expect(seen[0]?.headers).toStrictEqual([]);
    });
});
