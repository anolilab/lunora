import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker";
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

const REGISTRY: FunctionRegistryLike = { "messages:list": { kind: "query" } };
const ADMIN_TOKEN = "static-bearer";
const ADMIN_PATH = "https://app.example/_lunora/admin/functions";

describe("createWorker — adminGate (async Access-style admin authorization)", () => {
    it("authorizes an admin route when adminGate resolves true, with no bearer", async () => {
        expect.assertions(2);

        const adminGate = vi.fn<() => Promise<boolean>>(async () => true);
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(adminGate).toHaveBeenCalledTimes(1);
    });

    it("denies (403) when adminGate resolves false and no bearer is supplied", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminGate: async () => false, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("denies (403) when adminGate resolves a truthy non-boolean", async () => {
        expect.assertions(1);

        // Polarity here GRANTS on truthy, so an app gate that returns its claims
        // object (or anything else non-`false` it happened to compute) instead of a
        // boolean would unlock every `/_lunora/admin/*` route. Only an exact `true`
        // grants.
        const worker = createWorker({
            adminGate: async () => ({ groups: [] }) as unknown as boolean,
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("still accepts the static admin bearer when adminGate resolves false", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminGate: async () => false, adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
    });

    it("denies (403) when adminGate throws and no bearer is supplied", async () => {
        expect.assertions(1);

        // A throwing gate must degrade to "no grant" (fail closed for the gate),
        // not propagate out and 500 the whole admin request.
        const worker = createWorker({
            adminGate: async () => {
                throw new Error("verification blew up");
            },
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("still accepts the static admin bearer when adminGate throws", async () => {
        expect.assertions(1);

        // The bearer path must survive a throwing gate — a failing Access check
        // cannot lock out a request carrying a valid static token.
        const worker = createWorker({
            adminGate: async () => {
                throw new Error("verification blew up");
            },
            adminToken: ADMIN_TOKEN,
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request(ADMIN_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
    });

    it("never evaluates adminGate on the non-admin RPC hot path", async () => {
        expect.assertions(1);

        const adminGate = vi.fn<() => Promise<boolean>>(async () => true);
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(adminGate).not.toHaveBeenCalled();
    });
});

describe("createWorker — adminGate execution context", () => {
    /**
     * A context shaped like the one Cloudflare hands a Worker protected by an
     * Access policy attached to the Worker itself: the caller's identity arrives
     * out-of-band on `ctx.access`, not on the request, so a gate can only reach it
     * if the worker forwards the context it was invoked with.
     */
    const accessContext: ExecutionContextLike = {
        ...fakeContext,
        access: { getIdentity: () => Promise.resolve({ email: "admin@acme.test", sub: "user-1" }) },
    };

    it("hands the gate the ExecutionContext the request was served with", async () => {
        expect.assertions(3);

        const adminGate = vi.fn<(request: Request, context?: ExecutionContextLike) => Promise<boolean>>(
            async (_request, context) => (await context?.access?.getIdentity()) !== undefined,
        );
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, accessContext);

        expect(response.status).toBe(200);
        expect(adminGate).toHaveBeenCalledTimes(1);
        expect(adminGate.mock.calls[0]?.[1]?.access).toBeDefined();
    });

    it("denies when the context carries no Access identity", async () => {
        expect.assertions(1);

        const adminGate = async (_request: Request, context?: ExecutionContextLike): Promise<boolean> => (await context?.access?.getIdentity()) !== undefined;
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });
});

/**
 * The two reserved admin RPCs the WORKER serves itself dispatch at
 * `/_lunora/rpc`, not under `/_lunora/admin/*`. `applyAdminGate` is scoped to
 * `isAdminPath` (so the async gate stays off the data hot path), so it recorded no
 * grant for them and `requestIsAdmin` fell back to the static bearer alone — an
 * Access-only deployment got 403 on the Studio's auth-audit and
 * notification-device reads while every `/_lunora/admin/*` route worked.
 */
describe("createWorker — adminGate authorizes the worker-served reserved admin RPCs", () => {
    const rpc = (functionPath: string): Request =>
        new Request("https://app.example/_lunora/rpc", {
            body: JSON.stringify({ args: {}, functionPath }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

    it("serves __lunora_admin__:getAuthAuditLog to an Access-only admin (no static token)", async () => {
        expect.assertions(3);

        const adminGate = vi.fn<() => Promise<boolean>>(async () => true);
        const worker = createWorker({
            adminGate,
            authAuditReader: { read: async () => [] },
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(rpc("__lunora_admin__:getAuthAuditLog"), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(adminGate).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toStrictEqual({ result: { entries: [] } });
    });

    it("still denies (403) when the gate refuses and no bearer is supplied", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminGate: async () => false,
            authAuditReader: { read: async () => [] },
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(rpc("__lunora_admin__:getAuthAuditLog"), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("never evaluates adminGate for an ordinary RPC", async () => {
        expect.assertions(1);

        const adminGate = vi.fn<() => Promise<boolean>>(async () => true);
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        await worker.fetch(rpc("messages:list"), {}, fakeContext);

        expect(adminGate).not.toHaveBeenCalled();
    });
});
