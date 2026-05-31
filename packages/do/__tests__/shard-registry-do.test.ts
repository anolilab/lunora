import { describe, expect, test } from "vitest";

import { ShardRegistryDO } from "../src/shard-registry-do.js";

/** In-memory `DurableObjectState` substitute — same shape SessionDO tests use. */
const createFakeState = (initial: Record<string, unknown> = {}) => {
    const storage = new Map<string, unknown>(Object.entries(initial));

    return {
        blockConcurrencyWhile: async (callback: () => Promise<unknown>) => {
            await callback();
        },
        storage: {
            get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
            put: async <T>(key: string, value: T): Promise<void> => {
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
    test("starts empty — /list returns an empty shardKeys array", async () => {
        const state = createFakeState();
        const registry = new ShardRegistryDO(state, {});
        // construction kicks off blockConcurrencyWhile; the fake awaits it synchronously
        // but the fetch path still works either way.

        const response = await registry.fetch(get("/list?table=messages"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ shardKeys: [] });
    });

    test("/register adds a shard key and reports changed=true on first add", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        const first = await registry.fetch(post("/register", { shardKey: "channel-1", table: "messages" }));

        expect(first.status).toBe(200);
        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(post("/register", { shardKey: "channel-1", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });

        const list = await registry.fetch(get("/list?table=messages"));

        await expect(list.json()).resolves.toEqual({ shardKeys: ["channel-1"] });
    });

    test("/register accumulates multiple shard keys per table", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        for (const key of ["channel-1", "channel-2", "channel-3"]) {
            await registry.fetch(post("/register", { shardKey: key, table: "messages" }));
        }

        const list = await registry.fetch(get("/list?table=messages"));
        const body = (await list.json()) as { shardKeys: string[] };

        expect(body.shardKeys.toSorted()).toEqual(["channel-1", "channel-2", "channel-3"]);
    });

    test("tables are isolated — registering one table doesn't leak into another", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "b", table: "tasks" }));

        const m = await (await registry.fetch(get("/list?table=messages"))).json();
        const t = await (await registry.fetch(get("/list?table=tasks"))).json();

        expect(m).toEqual({ shardKeys: ["a"] });
        expect(t).toEqual({ shardKeys: ["b"] });
    });

    test("/unregister removes a key and reports changed=true once, changed=false on repeat", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "x", table: "messages" }));

        const first = await registry.fetch(post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });
    });

    test("/unregister on an unknown table is a quiet no-op", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(post("/unregister", { shardKey: "x", table: "ghost" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ changed: false, ok: true });
    });

    test("/list rejects requests without a table parameter", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(get("/list"));

        expect(response.status).toBe(400);

        const body = (await response.json()) as { error: { code: string } };

        expect(body.error.code).toBe("BAD_REQUEST");
    });

    test("/register rejects missing fields", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        const noTable = await registry.fetch(post("/register", { shardKey: "x" }));

        expect(noTable.status).toBe(400);

        const noShardKey = await registry.fetch(post("/register", { table: "messages" }));

        expect(noShardKey.status).toBe(400);
    });

    test("/register rejects malformed JSON", async () => {
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

    test("unknown route returns 404", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        const response = await registry.fetch(get("/missing"));

        expect(response.status).toBe(404);
    });

    test("/snapshot returns the full table → keys map", async () => {
        const registry = new ShardRegistryDO(createFakeState(), {});

        await registry.fetch(post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "b", table: "messages" }));
        await registry.fetch(post("/register", { shardKey: "c", table: "tasks" }));

        const response = await registry.fetch(get("/snapshot"));
        const body = (await response.json()) as { tables: Record<string, string[]> };

        expect(body.tables["messages"]!.toSorted()).toEqual(["a", "b"]);
        expect(body.tables["tasks"]).toEqual(["c"]);
    });

    test("state survives a fresh DO instance — load from storage", async () => {
        const state = createFakeState();
        const first = new ShardRegistryDO(state, {});

        await first.fetch(post("/register", { shardKey: "alpha", table: "messages" }));
        await first.fetch(post("/register", { shardKey: "beta", table: "messages" }));

        // Same storage, new instance — mirrors a DO restart.
        const second = new ShardRegistryDO(state, {});

        // Give the blockConcurrencyWhile callback a microtask to complete.
        await Promise.resolve();

        const list = await (await second.fetch(get("/list?table=messages"))).json();

        expect((list as { shardKeys: string[] }).shardKeys.toSorted()).toEqual(["alpha", "beta"]);
    });
});
