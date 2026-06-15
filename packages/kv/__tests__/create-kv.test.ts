import { describe, expect, it } from "vitest";

import { createKv, scopeKey } from "../src/create-kv";
import type { KvGetOptions, KVNamespaceLike, KvNamespaceListResult, KvNamespacePutOptions, KvValue, KvValueType } from "../src/types";

const NAMESPACE_RE = /namespace/;

interface StoredEntry {
    expiration?: number;
    metadata?: unknown;
    value: string;
}

/**
 * In-memory `Map`-backed `KVNamespaceLike` double. Stores values as the string
 * the binding would persist (the facade JSON-stringifies before `put`), decodes
 * on `get` per the `type` option, and records the put options for assertions.
 */
const fakeNamespace = (): KVNamespaceLike & { puts: { key: string; options?: KvNamespacePutOptions }[]; store: Map<string, StoredEntry> } => {
    const store = new Map<string, StoredEntry>();
    const puts: { key: string; options?: KvNamespacePutOptions }[] = [];

    const decodeType = (options?: KvGetOptions | KvValueType): KvValueType => {
        if (typeof options === "string") {
            return options;
        }

        return options?.type ?? "text";
    };

    const decode = (raw: string, type: KvValueType): unknown => {
        if (type === "json") {
            return JSON.parse(raw);
        }

        if (type === "arrayBuffer") {
            return new TextEncoder().encode(raw).buffer;
        }

        return raw;
    };

    return {
        delete: async (key) => {
            store.delete(key);
        },
        get: async (key, options) => {
            const entry = store.get(key);

            if (entry === undefined) {
                return null;
            }

            return decode(entry.value, decodeType(options));
        },
        getWithMetadata: async (key, options) => {
            const entry = store.get(key);

            if (entry === undefined) {
                return { metadata: null, value: null };
            }

            return { metadata: entry.metadata ?? null, value: decode(entry.value, decodeType(options)) };
        },
        list: async (options) => {
            const prefix = options?.prefix ?? "";
            const all = [...store.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .toSorted(([a], [b]) => a.localeCompare(b))
                .map(([name, entry]) => {
                    return { expiration: entry.expiration, metadata: entry.metadata, name };
                });

            const limit = options?.limit ?? all.length;
            const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
            const page = all.slice(start, start + limit);
            const next = start + limit;

            if (next < all.length) {
                return { cursor: String(next), keys: page, list_complete: false } satisfies KvNamespaceListResult;
            }

            return { keys: page, list_complete: true } satisfies KvNamespaceListResult;
        },
        put: async (key, value: KvValue, options) => {
            puts.push({ key, options });
            store.set(key, { expiration: options?.expiration, metadata: options?.metadata, value: value as string });
        },
        puts,
        store,
    };
};

describe("createKv", () => {
    it("throws when namespace is missing", () => {
        expect.assertions(1);

        // @ts-expect-error - intentional misuse
        expect(() => createKv({})).toThrow(NAMESPACE_RE);
    });

    it("jSON round-trips via put/get", async () => {
        expect.assertions(2);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("user:1", { name: "Ada", roles: ["admin"] });

        // The binding receives the stringified JSON, not the object.
        expect(namespace.store.get("user:1")?.value).toBe('{"name":"Ada","roles":["admin"]}');
        await expect(kv.get<{ name: string; roles: string[] }>("user:1")).resolves.toStrictEqual({ name: "Ada", roles: ["admin"] });
    });

    it("get returns null for an absent key", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.get("missing")).resolves.toBeNull();
    });

    it("forwards expirationTtl + metadata to the binding put", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("k", { a: 1 }, { expirationTtl: 60, metadata: { owner: "x" } });

        expect(namespace.puts[0]?.options).toStrictEqual({ expirationTtl: 60, metadata: { owner: "x" } });
    });

    it("forwards expiration to the binding put", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("k", "v", { expiration: 1_700_000_000 });

        expect(namespace.puts[0]?.options).toStrictEqual({ expiration: 1_700_000_000 });
    });

    it("omits put options when none are set", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("k", "v");

        expect(namespace.puts[0]?.options).toBeUndefined();
    });

    it("raw mode writes the value verbatim (no JSON.stringify)", async () => {
        expect.assertions(2);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("raw", "hello", { raw: true });

        // No surrounding quotes — written as-is.
        expect(namespace.store.get("raw")?.value).toBe("hello");
        await expect(kv.getRaw("raw")).resolves.toBe("hello");
    });

    it("getRaw honors an explicit decode type", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("blob", "abc", { raw: true });
        const buffer = await kv.getRaw<ArrayBuffer>("blob", { type: "arrayBuffer" });

        expect(new TextDecoder().decode(buffer!)).toBe("abc");
    });

    it("getWithMetadata returns value + metadata", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("flag", { on: true }, { metadata: { owner: "growth" } });

        await expect(kv.getWithMetadata<{ on: boolean }, { owner: string }>("flag")).resolves.toStrictEqual({
            metadata: { owner: "growth" },
            value: { on: true },
        });
    });

    it("getWithMetadata returns nulls for an absent key", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.getWithMetadata("missing")).resolves.toStrictEqual({ metadata: null, value: null });
    });

    it("delete removes the key", async () => {
        expect.assertions(2);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await kv.put("k", "v", { raw: true });
        await kv.delete("k");

        expect(namespace.store.has("k")).toBe(false);
        await expect(kv.get("k")).resolves.toBeNull();
    });

    it("list paginates via cursor and reports completion", async () => {
        expect.assertions(4);

        const namespace = fakeNamespace();
        const kv = createKv({ namespace });

        await Promise.all([0, 1, 2].map(async (index) => kv.put(`item:${String(index)}`, index)));

        const first = await kv.list({ limit: 2, prefix: "item:" });

        expect(first.keys.map((key) => key.name)).toStrictEqual(["item:0", "item:1"]);
        expect(first.listComplete).toBe(false);

        const second = await kv.list({ cursor: first.cursor, limit: 2, prefix: "item:" });

        expect(second.keys.map((key) => key.name)).toStrictEqual(["item:2"]);
        expect(second.listComplete).toBe(true);
    });

    describe("keyPrefix scoping", () => {
        it("scopes get/put/delete keys to the prefix", async () => {
            expect.assertions(3);

            const namespace = fakeNamespace();
            const kv = createKv({ keyPrefix: "tenant/a", namespace });

            await kv.put("session", { token: "t" });

            // Stored under the scoped key...
            expect(namespace.store.has("tenant/a/session")).toBe(true);
            // ...and readable back via the unscoped key.
            await expect(kv.get<{ token: string }>("session")).resolves.toStrictEqual({ token: "t" });

            await kv.delete("session");

            expect(namespace.store.has("tenant/a/session")).toBe(false);
        });

        it("only lists the instance's own keys and strips the prefix", async () => {
            expect.assertions(2);

            const namespace = fakeNamespace();
            const a = createKv({ keyPrefix: "tenant/a", namespace });
            const b = createKv({ keyPrefix: "tenant/b", namespace });

            await a.put("k1", 1);
            await a.put("k2", 2);
            await b.put("k1", 3);

            const listed = await a.list();

            expect(listed.keys.map((key) => key.name)).toStrictEqual(["k1", "k2"]);
            expect(listed.listComplete).toBe(true);
        });

        it("combines instance prefix with a list prefix", async () => {
            expect.assertions(1);

            const namespace = fakeNamespace();
            const kv = createKv({ keyPrefix: "tenant/a", namespace });

            await kv.put("flags:beta", true);
            await kv.put("session", true);

            const listed = await kv.list({ prefix: "flags:" });

            expect(listed.keys.map((key) => key.name)).toStrictEqual(["flags:beta"]);
        });
    });

    describe("key validation", () => {
        it("rejects empty keys", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.get("")).rejects.toThrow(/non-empty/);
        });

        it("rejects `..` path components", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.put("a/../b", 1)).rejects.toThrow(/path component/);
        });

        it("rejects NUL bytes in keys", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.delete("a\0b")).rejects.toThrow(/NUL/);
        });

        it("rejects NUL bytes in a list prefix", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.list({ prefix: "a\0b" })).rejects.toThrow(/NUL/);
        });
    });
});

describe("scopeKey", () => {
    it("composes a per-tenant key", () => {
        expect.assertions(1);

        expect(scopeKey("tenant/a", "session")).toBe("tenant/a/session");
    });

    it("trims a trailing slash on the prefix", () => {
        expect.assertions(1);

        expect(scopeKey("tenant/a/", "session")).toBe("tenant/a/session");
    });

    it("rejects a `..` in either half", () => {
        expect.assertions(2);

        expect(() => scopeKey("..", "k")).toThrow(/path component/);
        expect(() => scopeKey("tenant", "../peer")).toThrow(/path component/);
    });
});
