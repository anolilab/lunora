import { describe, expect, it, vi } from "vitest";

import { createKvIntrospector, createKvIntrospectorFromEnv } from "../../src/kv/kv-introspector";
import type { KVNamespaceLike } from "../../src/kv/types";

/** Minimal in-memory `KVNamespaceLike` double — enough surface for the introspector + the duck-type guard. */
const fakeNamespace = (seed: Record<string, string> = {}): KVNamespaceLike => {
    const store = new Map(Object.entries(seed));

    return {
        delete: async (key) => {
            store.delete(key);
        },
        get: async (key) => store.get(key) ?? null,
        getWithMetadata: async (key) => {
            return { metadata: null, value: store.get(key) ?? null };
        },
        list: async () => {
            return {
                cursor: undefined,
                keys: [...store.keys()]
                    .toSorted((a, b) => a.localeCompare(b))
                    .map((name) => {
                        return { name };
                    }),
                list_complete: true,
            };
        },
        put: async (key, value) => {
            store.set(key, value as string);
        },
    };
};

/** An R2-bucket-shaped binding: `get`/`put`/`list`/`delete` but no `getWithMetadata` — must NOT be treated as KV. */
const fakeR2Bucket = (): Record<string, unknown> => {
    return {
        delete: async () => {},
        get: async () => null,
        head: async () => null,
        list: async () => {
            return { objects: [] };
        },
        put: async () => {
            return {};
        },
    };
};

describe("createKvIntrospectorFromEnv", () => {
    it("discovers every KV-shaped binding by name and skips non-KV bindings", async () => {
        expect.assertions(1);

        const env = {
            ANALYTICS: { writeDataPoint: () => {} },
            CACHE: fakeNamespace(),
            LUNORA_ADMIN_TOKEN: "secret", // gitleaks:allow -- test fixture value, not a real credential
            SESSIONS: fakeNamespace(),
            UPLOADS: fakeR2Bucket(),
        };

        const introspector = createKvIntrospectorFromEnv(env);
        const namespaces = await introspector.listNamespaces();

        expect(namespaces.map((ns) => ns.binding).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["CACHE", "SESSIONS"]);
    });

    it("round-trips a value through the discovered binding under its name", async () => {
        expect.assertions(2);

        const env = { CACHE: fakeNamespace({ "greeting:en": "hello" }) };
        const introspector = createKvIntrospectorFromEnv(env);

        const before = await introspector.getValue({ key: "greeting:en", namespace: "CACHE" });

        expect(before.value).toBe("hello");

        await introspector.putValue({ key: "greeting:fr", namespace: "CACHE", value: "bonjour" });
        const page = await introspector.listKeys({ namespace: "CACHE" });

        expect(page.keys.map((entry) => entry.name)).toStrictEqual(["greeting:en", "greeting:fr"]);
    });

    // KV resolves `expiration` + `expirationTtl` by taking the TTL and dropping
    // the absolute timestamp — so forwarding both silently gives the caller an
    // expiry it never asked for. `createKv` already rejects the pair; the admin
    // introspector used to forward it.
    it("rejects putValue carrying both expiration and expirationTtl", async () => {
        expect.assertions(2);

        const namespace = fakeNamespace();
        const introspector = createKvIntrospectorFromEnv({ CACHE: namespace });

        await expect(introspector.putValue({ expiration: 1_700_000_000, expirationTtl: 60, key: "k", namespace: "CACHE", value: "v" })).rejects.toThrow(
            /mutually exclusive/u,
        );

        await expect(introspector.getValue({ key: "k", namespace: "CACHE" })).resolves.toStrictEqual({ metadata: null, value: null });
    });

    it("returns an empty-but-usable introspector when env holds no KV bindings", async () => {
        expect.assertions(4);

        const results = await Promise.all([{}, null, undefined, { NOT_KV: 42 }].map((env) => createKvIntrospectorFromEnv(env).listNamespaces()));

        for (const namespaces of results) {
            expect(namespaces).toStrictEqual([]);
        }
    });
});

describe("createKvIntrospector — admin write-path guards", () => {
    it("rejects metadata past KV's 1,024-byte ceiling, naming the limit", async () => {
        expect.assertions(2);

        const put = vi.fn<KVNamespaceLike["put"]>(async () => undefined);
        const namespace: KVNamespaceLike = { ...fakeNamespace(), put };
        const introspector = createKvIntrospector({ namespaces: { CACHE: namespace } });

        // The studio's KV browser posts this straight from a free-text JSON box.
        await expect(introspector.putValue({ key: "k", metadata: { owner: "x".repeat(1024) }, namespace: "CACHE", value: "v" })).rejects.toThrow(
            /metadata exceeds 1024-byte limit/u,
        );

        expect(put).not.toHaveBeenCalled();
    });

    it("rejects an over-long key on put/get/delete, naming the limit", async () => {
        expect.assertions(3);

        const introspector = createKvIntrospector({ namespaces: { CACHE: fakeNamespace() } });
        const tooLong = "x".repeat(513);

        await expect(introspector.putValue({ key: tooLong, namespace: "CACHE", value: "v" })).rejects.toThrow(/key exceeds 512-byte limit/u);
        await expect(introspector.getValue({ key: tooLong, namespace: "CACHE" })).rejects.toThrow(/key exceeds 512-byte limit/u);
        await expect(introspector.deleteKey({ key: tooLong, namespace: "CACHE" })).rejects.toThrow(/key exceeds 512-byte limit/u);
    });

    it("rejects a `..` path component and a NUL byte in a key", async () => {
        expect.assertions(2);

        const introspector = createKvIntrospector({ namespaces: { CACHE: fakeNamespace() } });

        await expect(introspector.putValue({ key: "a/../b", namespace: "CACHE", value: "v" })).rejects.toThrow(/path component/u);
        await expect(introspector.putValue({ key: "a\u0000b", namespace: "CACHE", value: "v" })).rejects.toThrow(/NUL byte/u);
    });

    it("codes every guard BAD_REQUEST so the admin route answers 400 with the message, not a redacted 500", async () => {
        expect.assertions(2);

        const introspector = createKvIntrospector({ namespaces: { CACHE: fakeNamespace() } });

        // `INTERNAL` is a redacting code: `toErrorBody` replaces the message
        // with "Internal error" and answers 500 — exactly the opaque failure
        // these guards exist to replace.
        await expect(introspector.putValue({ key: "x".repeat(513), namespace: "CACHE", value: "v" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(introspector.putValue({ key: "k", metadata: { owner: "x".repeat(1024) }, namespace: "CACHE", value: "v" })).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
    });
});
