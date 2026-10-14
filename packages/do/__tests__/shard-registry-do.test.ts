import { describe, expect, it } from "vitest";

import { ShardRegistryDO } from "../src/shard-registry-do";

/**
 * In-memory `DurableObjectState` substitute — same shape SessionDO tests use.
 *
 * `putGuard` stands in for the per-value storage limit: a `put` the real DO
 * would refuse throws here instead, which is the only way to observe what the
 * registry does to its in-memory map when persistence fails.
 */
const createFakeState = (
    options: { putGuard?: (key: string, value: unknown) => void } = {},
): {
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>;
    storage: {
        delete: (key: string) => Promise<boolean>;
        entries: Map<string, unknown>;
        list: <T>(listOptions: { prefix: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
    };
} => {
    const storage = new Map<string, unknown>();

    return {
        blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
        storage: {
            delete: async (key: string): Promise<boolean> => storage.delete(key),
            entries: storage,
            list: async <T>(listOptions: { prefix: string }): Promise<Map<string, T>> =>
                new Map([...storage].filter(([key]) => key.startsWith(listOptions.prefix)) as [string, T][]),
            put: async (key: string, value: unknown): Promise<void> => {
                options.putGuard?.(key, value);
                storage.set(key, value);
            },
        },
    };
};

const post = (path: string, body: unknown): Request =>
    new Request(`https://shard-registry.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const get = (path: string): Request => new Request(`https://shard-registry.internal${path}`, { method: "GET" });

describe("shardRegistryDO", () => {
    it("starts empty — /list returns an empty shardKeys array", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, {});
        // construction kicks off blockConcurrencyWhile; the fake awaits it synchronously
        // but the fetch path still works either way.

        const response = await registry.fetch(get("/list?table=messages"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ shardKeys: [] });
    });

    it("/register adds a shard key and reports changed=true on first add", async () => {
        expect.assertions(4);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const first = await registry.fetch(post("/register", { shardKey: "channel-1", table: "messages" }));

        expect(first.status).toBe(200);
        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(post("/register", { shardKey: "channel-1", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });

        const list = await registry.fetch(get("/list?table=messages"));

        await expect(list.json()).resolves.toEqual({ shardKeys: ["channel-1"] });
    });

    it("/register accumulates multiple shard keys per table", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), {});

        for (const key of ["channel-1", "channel-2", "channel-3"]) {
            // eslint-disable-next-line no-await-in-loop -- ordered registrations must apply sequentially
            await registry.fetch(post("/register", { shardKey: key, table: "messages" }));
        }

        const list = await registry.fetch(get("/list?table=messages"));
        const body = await list.json<{ shardKeys: string[] }>();

        expect(body.shardKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(["channel-1", "channel-2", "channel-3"]);
    });

    it("tables are isolated — registering one table doesn't leak into another", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "b", table: "tasks" }));

        const messagesResponse = await registry.fetch(get("/list?table=messages"));
        const m = await messagesResponse.json();
        const tasksResponse = await registry.fetch(get("/list?table=tasks"));
        const t = await tasksResponse.json();

        expect(m).toEqual({ shardKeys: ["a"] });
        expect(t).toEqual({ shardKeys: ["b"] });
    });

    it("/unregister removes a key and reports changed=true once, changed=false on repeat", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "x", table: "messages" }));

        const first = await registry.fetch(post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });
    });

    it("/unregister on an unknown table is a quiet no-op", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(post("/unregister", { shardKey: "x", table: "ghost" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ changed: false, ok: true });
    });

    it("/list rejects requests without a table parameter", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(get("/list"));

        expect(response.status).toBe(400);

        const body = await response.json<{ error: { code: string } }>();

        expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("/register rejects missing fields", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const noTable = await registry.fetch(post("/register", { shardKey: "x" }));

        expect(noTable.status).toBe(400);

        const noShardKey = await registry.fetch(post("/register", { table: "messages" }));

        expect(noShardKey.status).toBe(400);
    });

    it("/register rejects malformed JSON", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(
            new Request("https://shard-registry.internal/register", {
                body: "not json",
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(400);
    });

    it("unknown route returns 404", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(get("/missing"));

        expect(response.status).toBe(404);
    });

    it("/snapshot returns the full table → keys map", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "b", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "c", table: "tasks" }));

        const response = await registry.fetch(get("/snapshot"));
        const body = await response.json<{ tables: Record<string, string[]> }>();

        expect(body.tables["messages"]!.toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
        expect(body.tables["tasks"]).toEqual(["c"]);
    });

    /**
     * The registry used to persist the whole `table → [keys]` map as ONE storage
     * value, which capped it at the per-value limit — 128 KiB on a KV-backed
     * Durable Object, 2 MB on a SQLite-backed one. Around 3,300 UUID-shaped keys
     * on the first, ~50k on the second: inside the "one shard per user-created
     * channel/organisation/project" workload this DO exists for.
     *
     * The guard below is the smaller of the two documented limits, so the old
     * single-value shape fails this on either backend's arithmetic while the
     * per-key shape is bounded by nothing.
     */
    it("registers past the per-value storage limit — no key holds the whole snapshot", async () => {
        expect.assertions(2);

        const KV_BACKED_VALUE_LIMIT = 128 * 1024;
        const state = createFakeState({
            putGuard: (key, value) => {
                if (key.length + JSON.stringify(value).length > KV_BACKED_VALUE_LIMIT) {
                    throw new Error("value too large");
                }
            },
        });
        const registry = new ShardRegistryDO(state, {});

        // 5,000 UUID-shaped keys — ~195 KB as one serialized snapshot.
        const shardKeys = Array.from({ length: 5000 }, (_unused, index) => `3f2504e0-4f89-11d3-9a0c-${String(index).padStart(12, "0")}`);

        for (const shardKey of shardKeys) {
            // eslint-disable-next-line no-await-in-loop -- registrations are serialized by `blockConcurrencyWhile` anyway
            const response = await registry.fetch(post("/register", { shardKey, table: "channels" }));

            if (response.status !== 200) {
                throw new Error(`register failed at ${shardKey}`);
            }
        }

        const listResponse = await registry.fetch(get("/list?table=channels"));
        const list = await listResponse.json<{ shardKeys: string[] }>();

        expect(list.shardKeys).toHaveLength(5000);
        expect(state.storage.entries.size).toBe(5000);
    });

    /**
     * The in-memory set used to be mutated BEFORE the persist, so a `put` the
     * platform refused left the registry serving a shard key it had not stored —
     * until the next eviction dropped it, and the query coordinator's fan-out
     * quietly stopped including that shard.
     */
    it("does not admit a shard key whose write was refused", async () => {
        expect.assertions(2);

        const state = createFakeState({
            putGuard: () => {
                throw new Error("value too large");
            },
        });
        const registry = new ShardRegistryDO(state, {});

        await expect(registry.fetch(post("/register", { shardKey: "channel-1", table: "channels" }))).rejects.toThrow("value too large");

        const listResponse = await registry.fetch(get("/list?table=channels"));
        const list = await listResponse.json<{ shardKeys: string[] }>();

        expect(list.shardKeys).toStrictEqual([]);
    });

    it("refuses a table/shardKey pair too long to be a storage key", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), {});
        const response = await registry.fetch(post("/register", { shardKey: "x".repeat(2100), table: "channels" }));

        expect(response.status).toBe(400);

        const listResponse = await registry.fetch(get("/list?table=channels"));
        const list = await listResponse.json<{ shardKeys: string[] }>();

        expect(list.shardKeys).toStrictEqual([]);
    });

    it("state survives a fresh DO instance — load from storage", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const first = new ShardRegistryDO(state, {});

        await first.fetch(post("/register", { shardKey: "alpha", table: "messages" }));
        await first.fetch(post("/register", { shardKey: "beta", table: "messages" }));

        // Same storage, new instance — mirrors a DO restart.
        const second = new ShardRegistryDO(state, {});

        // Give the blockConcurrencyWhile callback a microtask to complete.
        await Promise.resolve();

        const listResponse = await second.fetch(get("/list?table=messages"));
        const list = await listResponse.json();

        expect((list as { shardKeys: string[] }).shardKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(["alpha", "beta"]);
    });
});
