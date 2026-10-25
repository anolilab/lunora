import { RELAY_SIGNATURE_HEADER, signSiblingBody } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { shardRegistryFrame } from "../../../shared/shard-registry-frame";
import { hostedShardRegistry, ShardRegistryDO } from "../src/shard-registry-do";

const SECRET = "test-relay-secret";
const ENV = { LUNORA_RELAY_SECRET: SECRET };

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

const BASE = "https://shard-registry.internal";

/** A request signed the way the registry's clients sign it. */
const signed = async (method: "GET" | "POST", path: string, body = "", secret = SECRET): Promise<Request> =>
    new Request(`${BASE}${path}`, {
        body: method === "POST" ? body : undefined,
        headers: {
            "content-type": "application/json",
            [RELAY_SIGNATURE_HEADER]: await signSiblingBody(secret, shardRegistryFrame(method, `${BASE}${path}`, body)),
        },
        method,
    });

const post = async (path: string, body: unknown): Promise<Request> => signed("POST", path, JSON.stringify(body));

const get = async (path: string): Promise<Request> => signed("GET", path);

describe("shardRegistryDO — authentication", () => {
    const unsigned = (method: "GET" | "POST", path: string, body?: unknown): Request =>
        new Request(`${BASE}${path}`, { body: body === undefined ? undefined : JSON.stringify(body), method });

    it("refuses every route when the DO has no LUNORA_RELAY_SECRET, even for a signed request", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, {});
        const body = JSON.stringify({ shardKey: "a", table: "messages" });

        const requests = await Promise.all([
            signed("POST", "/register", body),
            signed("POST", "/unregister", body),
            signed("GET", "/list?table=messages"),
            signed("GET", "/snapshot"),
        ]);
        const responses = await Promise.all(requests.map(async (request) => registry.fetch(request)));

        expect(responses.map((response) => response.status)).toStrictEqual([403, 403, 403, 403]);
        expect(state.storage.entries.size).toBe(0);
    });

    it("refuses an unsigned request on every route", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, ENV);

        const responses = await Promise.all(
            [
                unsigned("POST", "/register", { shardKey: "a", table: "messages" }),
                unsigned("POST", "/unregister", { shardKey: "a", table: "messages" }),
                unsigned("GET", "/list?table=messages"),
                unsigned("GET", "/snapshot"),
            ].map(async (request) => registry.fetch(request)),
        );

        expect(responses.map((response) => response.status)).toStrictEqual([403, 403, 403, 403]);
        expect(state.storage.entries.size).toBe(0);
    });

    it("caps the body it buffers, so an oversized request is refused before its signature is checked", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, ENV);
        const oversized = JSON.stringify({ shardKey: "a".repeat(128 * 1024), table: "messages" });
        const response = await registry.fetch(await signed("POST", "/register", oversized));

        expect(response.status).toBe(413);
        expect(state.storage.entries.size).toBe(0);
    });

    it("refuses a signature made under another secret and leaves storage untouched", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, ENV);
        const response = await registry.fetch(await signed("POST", "/register", JSON.stringify({ shardKey: "a", table: "messages" }), "another-secret"));

        expect(response.status).toBe(403);
        expect(state.storage.entries.size).toBe(0);
    });

    it("refuses a signature replayed against a different route or query", async () => {
        expect.assertions(3);

        const registry = new ShardRegistryDO(createFakeState(), ENV);
        const listMessages = await signed("GET", "/list?table=messages");
        const header = listMessages.headers.get(RELAY_SIGNATURE_HEADER) ?? "";

        const replay = async (path: string): Promise<number> => {
            const response = await registry.fetch(new Request(`${BASE}${path}`, { headers: { [RELAY_SIGNATURE_HEADER]: header } }));

            return response.status;
        };

        // The signature serves the request it was made for, and nothing else.
        await expect(replay("/list?table=messages")).resolves.toBe(200);
        // Moved to another table's list and to the snapshot.
        await expect(replay("/list?table=secrets")).resolves.toBe(403);
        await expect(replay("/snapshot")).resolves.toBe(403);
    });
});

describe("shardRegistryDO", () => {
    it("starts empty — /list returns an empty shardKeys array", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const registry = new ShardRegistryDO(state, ENV);
        // construction kicks off blockConcurrencyWhile; the fake awaits it synchronously
        // but the fetch path still works either way.

        const response = await registry.fetch(await get("/list?table=messages"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ shardKeys: [] });
    });

    it("/register adds a shard key and reports changed=true on first add", async () => {
        expect.assertions(4);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const first = await registry.fetch(await post("/register", { shardKey: "channel-1", table: "messages" }));

        expect(first.status).toBe(200);
        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(await post("/register", { shardKey: "channel-1", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });

        const list = await registry.fetch(await get("/list?table=messages"));

        await expect(list.json()).resolves.toEqual({ shardKeys: ["channel-1"] });
    });

    it("/register accumulates multiple shard keys per table", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        for (const key of ["channel-1", "channel-2", "channel-3"]) {
            // eslint-disable-next-line no-await-in-loop -- ordered registrations must apply sequentially
            await registry.fetch(await post("/register", { shardKey: key, table: "messages" }));
        }

        const list = await registry.fetch(await get("/list?table=messages"));
        const body = await list.json<{ shardKeys: string[] }>();

        expect(body.shardKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(["channel-1", "channel-2", "channel-3"]);
    });

    it("tables are isolated — registering one table doesn't leak into another", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        await registry.fetch(await post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(await post("/register", { shardKey: "b", table: "tasks" }));

        const messagesResponse = await registry.fetch(await get("/list?table=messages"));
        const m = await messagesResponse.json();
        const tasksResponse = await registry.fetch(await get("/list?table=tasks"));
        const t = await tasksResponse.json();

        expect(m).toEqual({ shardKeys: ["a"] });
        expect(t).toEqual({ shardKeys: ["b"] });
    });

    it("/unregister removes a key and reports changed=true once, changed=false on repeat", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        await registry.fetch(await post("/register", { shardKey: "x", table: "messages" }));

        const first = await registry.fetch(await post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(first.json()).resolves.toEqual({ changed: true, ok: true });

        const second = await registry.fetch(await post("/unregister", { shardKey: "x", table: "messages" }));

        await expect(second.json()).resolves.toEqual({ changed: false, ok: true });
    });

    it("/unregister on an unknown table is a quiet no-op", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const response = await registry.fetch(await post("/unregister", { shardKey: "x", table: "ghost" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ changed: false, ok: true });
    });

    it("/list rejects requests without a table parameter", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const response = await registry.fetch(await get("/list"));

        expect(response.status).toBe(400);

        const body = await response.json<{ error: { code: string } }>();

        expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("/register rejects missing fields", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const noTable = await registry.fetch(await post("/register", { shardKey: "x" }));

        expect(noTable.status).toBe(400);

        const noShardKey = await registry.fetch(await post("/register", { table: "messages" }));

        expect(noShardKey.status).toBe(400);
    });

    it("/register rejects malformed JSON", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const response = await registry.fetch(await signed("POST", "/register", "not json"));

        expect(response.status).toBe(400);
    });

    it("unknown route returns 404", async () => {
        expect.assertions(1);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        const response = await registry.fetch(await get("/missing"));

        expect(response.status).toBe(404);
    });

    it("/snapshot returns the full table → keys map", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);

        await registry.fetch(await post("/register", { shardKey: "a", table: "messages" }));
        await registry.fetch(await post("/register", { shardKey: "b", table: "messages" }));
        await registry.fetch(await post("/register", { shardKey: "c", table: "tasks" }));

        const response = await registry.fetch(await get("/snapshot"));
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
        const registry = new ShardRegistryDO(state, ENV);

        // 5,000 UUID-shaped keys — ~195 KB as one serialized snapshot.
        const shardKeys = Array.from({ length: 5000 }, (_unused, index) => `3f2504e0-4f89-11d3-9a0c-${String(index).padStart(12, "0")}`);

        for (const shardKey of shardKeys) {
            // eslint-disable-next-line no-await-in-loop -- registrations are serialized by `blockConcurrencyWhile` anyway
            const response = await registry.fetch(await post("/register", { shardKey, table: "channels" }));

            if (response.status !== 200) {
                throw new Error(`register failed at ${shardKey}`);
            }
        }

        const listResponse = await registry.fetch(await get("/list?table=channels"));
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
        const registry = new ShardRegistryDO(state, ENV);

        await expect(registry.fetch(await post("/register", { shardKey: "channel-1", table: "channels" }))).rejects.toThrow("value too large");

        const listResponse = await registry.fetch(await get("/list?table=channels"));
        const list = await listResponse.json<{ shardKeys: string[] }>();

        expect(list.shardKeys).toStrictEqual([]);
    });

    it("refuses a table/shardKey pair too long to be a storage key", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);
        const response = await registry.fetch(await post("/register", { shardKey: "x".repeat(2100), table: "channels" }));

        expect(response.status).toBe(400);

        const listResponse = await registry.fetch(await get("/list?table=channels"));
        const list = await listResponse.json<{ shardKeys: string[] }>();

        expect(list.shardKeys).toStrictEqual([]);
    });

    it("state survives a fresh DO instance — load from storage", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const first = new ShardRegistryDO(state, ENV);

        await first.fetch(await post("/register", { shardKey: "alpha", table: "messages" }));
        await first.fetch(await post("/register", { shardKey: "beta", table: "messages" }));

        // Same storage, new instance — mirrors a DO restart.
        const second = new ShardRegistryDO(state, ENV);

        // Give the blockConcurrencyWhile callback a microtask to complete.
        await Promise.resolve();

        const listResponse = await second.fetch(await get("/list?table=messages"));
        const list = await listResponse.json();

        expect((list as { shardKeys: string[] }).shardKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(["alpha", "beta"]);
    });
});

describe("hostedShardRegistry", () => {
    it("serves the registry's writes and reads through the host's own namespace, signed with its secret", async () => {
        expect.assertions(2);

        const registry = new ShardRegistryDO(createFakeState(), ENV);
        const namespace = {
            get: () => {return { fetch: async (url: string, init?: RequestInit) => registry.fetch(new Request(url, init)) }},
            getByName: () => {return { fetch: async (url: string, init?: RequestInit) => registry.fetch(new Request(url, init)) }},
            idFromName: (name: string) => name,
        };
        const host = hostedShardRegistry({ ...ENV, SHARD_REGISTRY: namespace });

        await host.register("messages", "alpha");

        await expect(host.listShardKeys("messages")).resolves.toStrictEqual(["alpha"]);
        await expect(host.snapshot()).resolves.toStrictEqual({ messages: ["alpha"] });
    });
});
