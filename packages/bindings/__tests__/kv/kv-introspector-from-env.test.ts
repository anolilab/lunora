import { describe, expect, it } from "vitest";

import { createKvIntrospectorFromEnv } from "../../src/kv/kv-introspector";
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
