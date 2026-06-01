import { describe, expect, it } from "vitest";

import { createDynamicShardRegistry, DEFAULT_REGISTRY_CACHE_TTL_MS, SHARD_REGISTRY_DO_NAME } from "../src/dynamic-shard-registry.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * Minimal in-process implementation of the ShardRegistryDO surface — same
 * routes, same JSON wire format. Lets us exercise the client without
 * importing `@cirrus/do` (which would create a hard dep).
 */
const createFakeRegistryDO = (initial: Record<string, string[]> = {}) => {
    const tables = new Map<string, Set<string>>();

    for (const [table, keys] of Object.entries(initial)) {
        tables.set(table, new Set(keys));
    }

    const calls: { body?: unknown; method: string; path: string }[] = [];

    const fetch = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const body: unknown = request.method === "POST" ? await request.json() : undefined;

        calls.push({ body, method: request.method, path: url.pathname });

        if (request.method === "POST" && url.pathname === "/register") {
            const { shardKey, table } = body as { shardKey: string; table: string };
            let set = tables.get(table);

            if (!set) {
                set = new Set();
                tables.set(table, set);
            }

            const changed = !set.has(shardKey);

            set.add(shardKey);

            return Response.json({ changed, ok: true });
        }

        if (request.method === "POST" && url.pathname === "/unregister") {
            const { shardKey, table } = body as { shardKey: string; table: string };
            const set = tables.get(table);
            const changed = Boolean(set?.delete(shardKey));

            return Response.json({ changed, ok: true });
        }

        if (request.method === "GET" && url.pathname === "/list") {
            const table = url.searchParams.get("table") ?? "";

            return Response.json({ shardKeys: [...(tables.get(table) ?? [])] });
        }

        if (request.method === "GET" && url.pathname === "/snapshot") {
            const out: Record<string, string[]> = {};

            for (const [t, set] of tables) {
                out[t] = [...set];
            }

            return Response.json({ tables: out });
        }

        return new Response("not found", { status: 404 });
    };

    return { calls, fetch, tables };
};

const createFakeNamespace = (stub: { fetch: (request: Request) => Promise<Response> }): ShardNamespaceLike & { instanceCalls: unknown[] } => {
    const instanceCalls: unknown[] = [];

    return {
        get: () => stub,
        idFromName: (name) => {
            instanceCalls.push(name);

            return { __name: name };
        },
        instanceCalls,
    };
};

describe("createDynamicShardRegistry", () => {
    it("listShardKeys returns the keys the DO has registered", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a", "b", "c"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        const result = await registry.listShardKeys("messages");

        expect([...result].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b", "c"]);
    });

    it("uses SHARD_REGISTRY_DO_NAME by default for the DO instance", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO();
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.listShardKeys("anything");

        expect(namespace.instanceCalls).toContain(SHARD_REGISTRY_DO_NAME);
    });

    it("honors a custom instanceName", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO();
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ instanceName: "custom-registry", namespace });

        await registry.listShardKeys("messages");

        expect(namespace.instanceCalls).toContain("custom-registry");
        expect(namespace.instanceCalls).not.toContain(SHARD_REGISTRY_DO_NAME);
    });

    it("register propagates to the DO and returns void", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO();
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.register("messages", "channel-7");

        expect(fakeDO.calls).toContainEqual({ body: { shardKey: "channel-7", table: "messages" }, method: "POST", path: "/register" });
        expect([...fakeDO.tables.get("messages")!]).toEqual(["channel-7"]);
    });

    it("unregister propagates to the DO", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["x", "y"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.unregister("messages", "x");

        expect([...fakeDO.tables.get("messages")!]).toEqual(["y"]);
    });

    it("listShardKeys caches within the TTL window", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ cacheTtlMs: 30_000, namespace });

        await registry.listShardKeys("messages");
        await registry.listShardKeys("messages");
        await registry.listShardKeys("messages");

        const listCalls = fakeDO.calls.filter((c) => c.path === "/list");

        expect(listCalls).toHaveLength(1);
    });

    it("register busts the local cache", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        // Prime the cache.
        await registry.listShardKeys("messages");

        // Register a new key — should drop the cache so the next list re-fetches.
        await registry.register("messages", "b");

        const result = await registry.listShardKeys("messages");

        expect([...result].toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
        expect(fakeDO.calls.filter((c) => c.path === "/list")).toHaveLength(2);
    });

    it("unregister busts the local cache", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a", "b"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.listShardKeys("messages");
        await registry.unregister("messages", "a");

        const result = await registry.listShardKeys("messages");

        expect([...result]).toEqual(["b"]);
    });

    it("invalidate() drops the entire cache", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"], tasks: ["x"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.listShardKeys("messages");
        await registry.listShardKeys("tasks");

        registry.invalidate();

        await registry.listShardKeys("messages");
        await registry.listShardKeys("tasks");

        expect(fakeDO.calls.filter((c) => c.path === "/list")).toHaveLength(4);
    });

    it("invalidate(table) drops only one entry", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"], tasks: ["x"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        await registry.listShardKeys("messages");
        await registry.listShardKeys("tasks");

        registry.invalidate("messages");

        await registry.listShardKeys("messages");
        await registry.listShardKeys("tasks");

        const listCalls = fakeDO.calls.filter((c) => c.path === "/list");

        expect(listCalls.filter((c) => (c as { path: string }).path === "/list")).toHaveLength(3);
    });

    it("cacheTtlMs=0 disables caching entirely", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ cacheTtlMs: 0, namespace });

        await registry.listShardKeys("messages");
        await registry.listShardKeys("messages");
        await registry.listShardKeys("messages");

        expect(fakeDO.calls.filter((c) => c.path === "/list")).toHaveLength(3);
    });

    it("snapshot returns the full tables map", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO({ messages: ["a"], tasks: ["x", "y"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        const snap = await registry.snapshot();

        expect(snap["messages"]).toEqual(["a"]);
        expect([...snap["tasks"]!].toSorted((a, b) => a.localeCompare(b))).toEqual(["x", "y"]);
    });

    it("listShardKeys throws when the DO returns non-2xx", async () => {
        expect.assertions(1);

        const failingDO = {
            fetch: async () => new Response("oops", { status: 500 }),
        };
        const namespace = createFakeNamespace(failingDO);
        const registry = createDynamicShardRegistry({ namespace });

        await expect(registry.listShardKeys("messages")).rejects.toThrow(/registry \/list returned 500/);
    });

    it("dEFAULT_REGISTRY_CACHE_TTL_MS is 30s", () => {
        expect.assertions(1);

        expect(DEFAULT_REGISTRY_CACHE_TTL_MS).toBe(30_000);
    });
});
