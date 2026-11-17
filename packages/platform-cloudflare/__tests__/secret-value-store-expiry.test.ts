import { describe, expect, it } from "vitest";

import { createSecretValueStore } from "../src/cloudflare-host";

/** A transaction-capable storage double over one map, enough for the secret store's reads and writes. */
const memoryStorage = () => {
    const records = new Map<string, unknown>();
    const txn = {
        delete: async (key: string) => records.delete(key),
        get: async <T>(key: string) => records.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
            records.set(key, value);
        },
    };

    return {
        ...txn,
        list: async () => new Map(records),
        transaction: async <T>(closure: (t: typeof txn) => Promise<T>) => closure(txn),
    };
};

describe("createSecretValueStore take", () => {
    it("does not return a value that runs out while it is being opened", async () => {
        expect.assertions(2);

        const clock = { now: 0 };
        const store = createSecretValueStore(memoryStorage() as unknown as Parameters<typeof createSecretValueStore>[0], { now: () => clock.now });
        const ref = await store.put(async () => "sealed", { scope: "thread-1", ttlMs: 1000 });

        // An asynchronous open that runs past the deadline, as a slow decrypt can.
        const taken = await store.take(ref, { claimant: "step-a", scope: "thread-1" }, async (stored) => {
            clock.now = 1000;

            return stored;
        });

        expect(taken).toBeUndefined();
        await expect(store.take(ref, { claimant: "step-a", scope: "thread-1" }, async (stored) => stored)).resolves.toBeUndefined();
    });
});
