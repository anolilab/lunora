import type { ShardKvListOptions } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createShardKvStore } from "../src/cloudflare-host";

/**
 * A sorted, in-memory stand-in for `DurableObjectStorage.list`. Keys come back in
 * code-unit order, and `limit` cuts the page after the prefix filter, as workerd
 * does. Reserved secret-value keys begin with `_` (0x5f), which sorts after the
 * uppercase letters and before the lowercase app keys, so a page cut short by
 * `limit` fills with reserved records before it reaches any app key.
 */
const sortedStorage = (entries: Record<string, unknown>) => {
    const data = new Map<string, unknown>(Object.entries(entries));

    return {
        delete: async (key: string) => data.delete(key),
        get: async <T = unknown>(key: string) => data.get(key) as T | undefined,
        list: async <T = unknown>(options?: { limit?: number; prefix?: string }) => {
            const prefix = options?.prefix ?? "";
            const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).toSorted((left, right) => (left < right ? -1 : 1));
            const page = options?.limit === undefined ? keys : keys.slice(0, options.limit);

            return new Map(page.map((key) => [key, data.get(key) as T]));
        },
        put: async (key: string, value: unknown) => {
            data.set(key, value);
        },
    };
};

describe("createShardKvStore list", () => {
    const reserved = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`__lunora_secret_value:${String(index).padStart(3, "0")}`, { value: "sealed" }]),
    );

    it("returns every app key, however many reserved secret records sort before them", async () => {
        expect.assertions(2);

        const kv = createShardKvStore(sortedStorage({ ...reserved, a1: 1, a2: 2, a3: 3 }));
        const all = await kv.list();
        const prefixed = await kv.list({ prefix: "a" });

        expect([...all.keys()]).toStrictEqual(["a1", "a2", "a3"]);
        expect([...prefixed.keys()]).toStrictEqual(["a1", "a2", "a3"]);
    });

    it("ignores a page limit that an untyped options object carries", async () => {
        expect.assertions(1);

        const kv = createShardKvStore(sortedStorage({ ...reserved, a1: 1, a2: 2, a3: 3 }));

        // The contract has no limit, but a runtime caller can still pass one. The
        // intersection type accepts the literal without a cast.
        const page: ShardKvListOptions & { limit: number } = { limit: 10 };
        const listed = await kv.list(page);

        expect([...listed.keys()]).toStrictEqual(["a1", "a2", "a3"]);
    });
});
