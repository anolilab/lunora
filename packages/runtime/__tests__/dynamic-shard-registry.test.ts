import { describe, expect, it } from "vitest";

import { createDynamicShardRegistry, DEFAULT_REGISTRY_CACHE_TTL_MS, SHARD_REGISTRY_DO_NAME } from "../src/dynamic-shard-registry";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * Minimal in-process implementation of the ShardRegistryDO surface — same
 * routes, same JSON wire format. Lets us exercise the client without
 * importing `@lunora/do` (which would create a hard dep).
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

    it("resolves a fresh stub per call, since workerd refuses a stub from another request", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ cacheTtlMs: 0, namespace });

        await registry.listShardKeys("messages");
        await registry.listShardKeys("messages");

        expect(namespace.instanceCalls).toHaveLength(2);
    });

    it("routes through a jurisdiction-pinned subnamespace when configured", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const inner = createFakeNamespace(fakeDO);
        const jurisdictionCalls: string[] = [];
        const namespace: ShardNamespaceLike = {
            get: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            idFromName: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            jurisdiction: (j) => {
                jurisdictionCalls.push(j);

                return inner;
            },
        };

        const registry = createDynamicShardRegistry({ jurisdiction: "us", namespace });

        const result = await registry.listShardKeys("messages");

        expect(jurisdictionCalls).toStrictEqual(["us"]);
        expect([...result]).toStrictEqual(["a"]);
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

    it("shares one /list request across concurrent misses on an empty cache", async () => {
        expect.assertions(2);

        const fakeDO = createFakeRegistryDO({ messages: ["a", "b"] });
        const namespace = createFakeNamespace(fakeDO);
        const registry = createDynamicShardRegistry({ namespace });

        const results = await Promise.all(Array.from({ length: 20 }, async () => registry.listShardKeys("messages")));

        expect(fakeDO.calls.filter((c) => c.path === "/list")).toHaveLength(1);
        expect(results.map((keys) => [...keys].toSorted((a, b) => a.localeCompare(b)))).toStrictEqual(Array.from({ length: 20 }, () => ["a", "b"]));
    });

    it("clears the in-flight request on failure, so the next call retries", async () => {
        expect.assertions(3);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        let listAttempts = 0;
        const flaky = {
            fetch: async (request: Request): Promise<Response> => {
                if (new URL(request.url).pathname === "/list") {
                    listAttempts += 1;

                    if (listAttempts === 1) {
                        return new Response("boom", { status: 500 });
                    }
                }

                return fakeDO.fetch(request);
            },
        };
        const registry = createDynamicShardRegistry({ namespace: createFakeNamespace(flaky) });

        const first = registry.listShardKeys("messages");
        const second = registry.listShardKeys("messages");

        await expect(first).rejects.toThrow("shard registry /list returned 500");
        await expect(second).rejects.toThrow("shard registry /list returned 500");

        expect([...(await registry.listShardKeys("messages"))]).toStrictEqual(["a"]);
    });

    it("does not join a list that started before a register on the same worker", async () => {
        expect.assertions(4);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        let listAttempts = 0;
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const gated = {
            fetch: async (request: Request): Promise<Response> => {
                if (new URL(request.url).pathname !== "/list") {
                    return fakeDO.fetch(request);
                }

                listAttempts += 1;

                // The first list reads the table before the register, then its reply is held.
                if (listAttempts === 1) {
                    const response = await fakeDO.fetch(request);

                    await firstHeld;

                    return response;
                }

                return fakeDO.fetch(request);
            },
        };
        const registry = createDynamicShardRegistry({ namespace: createFakeNamespace(gated) });

        const beforeRegister = registry.listShardKeys("messages");

        await registry.register("messages", "b");

        const afterRegister = registry.listShardKeys("messages");

        // Checked before the held list is released: a call that joined it would never get a reply.
        expect(listAttempts).toBe(2);
        expect([...(await afterRegister)].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["a", "b"]);

        releaseFirst();

        expect([...(await beforeRegister)]).toStrictEqual(["a"]);
        // The held list finished after the fresh one; its stale reply must not replace the fresh cache entry.
        expect([...(await registry.listShardKeys("messages"))].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["a", "b"]);
    });

    it("does not share a request when caching is off, so every call reaches the DO", async () => {
        expect.assertions(1);

        const fakeDO = createFakeRegistryDO({ messages: ["a"] });
        const registry = createDynamicShardRegistry({ cacheTtlMs: 0, namespace: createFakeNamespace(fakeDO) });

        await Promise.all([registry.listShardKeys("messages"), registry.listShardKeys("messages")]);

        expect(fakeDO.calls.filter((c) => c.path === "/list")).toHaveLength(2);
    });
});

describe("createDynamicShardRegistry secret", () => {
    it("sends the secret header on reads and writes", async () => {
        expect.assertions(1);

        const seen: (string | null)[] = [];
        const namespace = createFakeNamespace({
            fetch: async (request) => {
                seen.push(request.headers.get("x-lunora-shard-registry-do-secret"));

                return Response.json({ ok: true, shardKeys: [], tables: {} });
            },
        });
        const registry = createDynamicShardRegistry({ cacheTtlMs: 0, namespace, secret: "s3cret" });

        await registry.register("messages", "a");
        await registry.unregister("messages", "a");
        await registry.listShardKeys("messages");
        await registry.snapshot();

        expect(seen).toStrictEqual(["s3cret", "s3cret", "s3cret", "s3cret"]);
    });
});
