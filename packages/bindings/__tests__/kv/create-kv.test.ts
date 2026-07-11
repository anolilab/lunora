import { describe, expect, it } from "vitest";

import { createKv, scopeKey } from "../../src/kv/create-kv";
import type { KvGetOptions, KVNamespaceLike, KvNamespaceListResult, KvNamespacePutOptions, KvValue, KvValueType } from "../../src/kv/types";

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

    it("rejects putting both expiration and expirationTtl", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.put("k", "v", { expiration: 1_700_000_000, expirationTtl: 60 })).rejects.toThrow(/mutually exclusive/);
    });

    it("forwards cacheTtl to the binding get", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const gets: { key: string; options?: KvGetOptions | KvValueType }[] = [];
        const wrapped: KVNamespaceLike = {
            ...namespace,
            get: async (key, options) => {
                gets.push({ key, options });

                return namespace.get(key, options);
            },
        };
        const kv = createKv({ namespace: wrapped });

        await kv.get("k", { cacheTtl: 120 });

        expect(gets[0]?.options).toStrictEqual({ cacheTtl: 120, type: "json" });
    });

    it("getRaw decodes JSON when type is json", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await kv.put("k", { a: 1 });

        await expect(kv.getRaw<{ a: number }>("k", { type: "json" })).resolves.toStrictEqual({ a: 1 });
    });

    it("getRaw returns null for an absent key", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.getRaw("missing")).resolves.toBeNull();
    });

    it("clamps a list limit above KV's per-page ceiling", async () => {
        expect.assertions(1);

        const namespace = fakeNamespace();
        const lists: { options?: { cursor?: string; limit?: number; prefix?: string } }[] = [];
        const wrapped: KVNamespaceLike = {
            ...namespace,
            list: async (options) => {
                lists.push({ options });

                return namespace.list(options);
            },
        };
        const kv = createKv({ namespace: wrapped });

        await kv.list({ limit: 5000 });

        expect(lists[0]?.options?.limit).toBe(1000);
    });

    it("rejects a list limit of 0", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.list({ limit: 0 })).rejects.toThrow(/positive integer/);
    });

    it("rejects a negative list limit", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.list({ limit: -5 })).rejects.toThrow(/positive integer/);
    });

    it("rejects a non-integer list limit", async () => {
        expect.assertions(1);

        const kv = createKv({ namespace: fakeNamespace() });

        await expect(kv.list({ limit: 2.5 })).rejects.toThrow(/positive integer/);
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

        it("rejects a malformed keyPrefix at construction", () => {
            expect.assertions(2);

            expect(() => createKv({ keyPrefix: "../peer", namespace: fakeNamespace() })).toThrow(/path component/);
            expect(() => createKv({ keyPrefix: "a\0b", namespace: fakeNamespace() })).toThrow(/NUL/);
        });

        it("handles a keyPrefix with a trailing slash", async () => {
            expect.assertions(2);

            const namespace = fakeNamespace();
            const kv = createKv({ keyPrefix: "tenant/a/", namespace });

            await kv.put("session", 1);

            expect(namespace.store.has("tenant/a/session")).toBe(true);

            const listed = await kv.list();

            expect(listed.keys.map((key) => key.name)).toStrictEqual(["session"]);
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

        it("rejects `..` path components in a list prefix", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.list({ prefix: "a/../b" })).rejects.toThrow(/path component/);
        });

        it("rejects a list prefix past the 512-byte ceiling", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.list({ prefix: "x".repeat(513) })).rejects.toThrow(/512-byte limit/);
        });

        it("rejects a list prefix that escapes the instance scope", async () => {
            expect.assertions(1);

            const kv = createKv({ keyPrefix: "tenant/a", namespace: fakeNamespace() });

            await expect(kv.list({ prefix: "../b/" })).rejects.toThrow(/path component/);
        });

        it("rejects keys past the 512-byte ceiling", async () => {
            expect.assertions(1);

            const kv = createKv({ namespace: fakeNamespace() });

            await expect(kv.get("x".repeat(513))).rejects.toThrow(/512-byte limit/);
        });

        it("measures the key ceiling in UTF-8 bytes, not UTF-16 code units", async () => {
            // 200 CJK chars = 200 UTF-16 code units (well under 512) but 600
            // UTF-8 bytes (over the 512-byte ceiling). String.length would wave
            // it through only for KV to reject it remotely; byte-length rejects.
            expect.assertions(2);

            const kv = createKv({ namespace: fakeNamespace() });
            const multibyteKey = "你".repeat(200);

            expect(multibyteKey.length).toBeLessThan(512);
            await expect(kv.get(multibyteKey)).rejects.toThrow(/512-byte limit/);
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

    it("rejects a composed key past the 512-byte ceiling", () => {
        expect.assertions(1);

        expect(() => scopeKey("p".repeat(300), "k".repeat(300))).toThrow(/scoped key exceeds/);
    });
});
