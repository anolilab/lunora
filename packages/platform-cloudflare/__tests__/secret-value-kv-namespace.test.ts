import { afterEach, describe, expect, it, vi } from "vitest";

import { createSecretValueHost, createShardKvStore } from "../src/cloudflare-host";

const PREFIX = "__lunora_secret_value:";

/** Base64 of 32 bytes: a valid AES-256 key for the secret host. */
const KEY = btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)));

/** One map behind the KV surface, the secret host and direct writes that stand in for pre-upgrade data. */
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
        list: async <T>(options?: { limit?: number; prefix?: string }) => {
            const prefix = options?.prefix ?? "";
            const keys = [...records.keys()].filter((key) => key.startsWith(prefix));
            const page = options?.limit === undefined ? keys : keys.slice(0, options.limit);

            return new Map(page.map((key) => [key, records.get(key) as T]));
        },
        records,
        transaction: async <T>(closure: (t: typeof txn) => Promise<T>) => closure(txn),
    };
};

const setup = (now?: () => number) => {
    const storage = memoryStorage();
    const kv = createShardKvStore(storage);
    const secrets = createSecretValueHost(storage, { LUNORA_SECRET_VALUE_KEY: KEY }, now === undefined ? {} : { now });

    return { kv, secrets, storage };
};

describe("createShardKvStore secret-value namespace", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("refuses a put shaped like a secret record, so the secret host can never read a forged one", async () => {
        expect.assertions(3);

        const { kv, secrets, storage } = setup();
        const forged = { claimant: "step-a", expiresAt: Number.MAX_SAFE_INTEGER, scope: "thread-1", value: "forged" };

        await expect(kv.put(`${PREFIX}forged`, forged)).rejects.toThrow(TypeError);
        expect(storage.records.has(`${PREFIX}forged`)).toBe(false);
        await expect(secrets.take("forged", { claimant: "step-a", scope: "thread-1" })).resolves.toBeUndefined();
    });

    it("refuses to overwrite a stored secret with a plain value", async () => {
        expect.assertions(2);

        const { kv, secrets } = setup();
        const ref = await secrets.put("the secret", { scope: "thread-1", ttlMs: 60_000 });

        await expect(kv.put(`${PREFIX}${ref}`, "plain")).rejects.toThrow(TypeError);
        await expect(secrets.take(ref, { claimant: "step-a", scope: "thread-1" })).resolves.toBe("the secret");
    });

    it("keeps a pre-existing non-secret record under the prefix readable and listed", async () => {
        expect.assertions(3);

        const { kv, storage } = setup();
        const appRecord = { note: "written before upgrade" };
        const expiredLookalike = { expiresAt: 0, scope: "thread-1" };

        storage.records.set(`${PREFIX}notes`, appRecord);
        storage.records.set(`${PREFIX}partial`, expiredLookalike);

        await expect(kv.get(`${PREFIX}notes`)).resolves.toStrictEqual(appRecord);

        const listed = await kv.list({ prefix: PREFIX });

        expect([...listed.keys()].toSorted((left, right) => left.localeCompare(right))).toStrictEqual([`${PREFIX}notes`, `${PREFIX}partial`]);
        expect(listed.get(`${PREFIX}notes`)).toStrictEqual(appRecord);
    });

    it("still stores and reads a real secret through the secret host", async () => {
        expect.assertions(2);

        const { kv, secrets } = setup();
        const ref = await secrets.put("the secret", { scope: "thread-1", ttlMs: 60_000 });

        await expect(secrets.take(ref, { claimant: "step-a", scope: "thread-1" })).resolves.toBe("the secret");
        // The record is hidden from the KV surface even though it is stored.
        await expect(kv.get(`${PREFIX}${ref}`)).resolves.toBeUndefined();
    });

    it("refuses to delete a secret record through the KV surface", async () => {
        expect.assertions(3);

        const { kv, secrets, storage } = setup();
        const ref = await secrets.put("the secret", { scope: "thread-1", ttlMs: 60_000 });

        await expect(kv.delete(`${PREFIX}${ref}`)).rejects.toThrow(TypeError);
        expect(storage.records.has(`${PREFIX}${ref}`)).toBe(true);
        await expect(secrets.take(ref, { claimant: "step-a", scope: "thread-1" })).resolves.toBe("the secret");
    });

    it("does not overwrite an app record at the ref the secret host just issued", async () => {
        expect.assertions(2);

        vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");

        const { secrets, storage } = setup(() => 0);
        const appRecord = { note: "collides with the next ref" };

        // With the clock at 0 and a 1000 ms ttl, the ref is fully determined.
        storage.records.set(`${PREFIX}000000000001000.00000000-0000-4000-8000-000000000000`, appRecord);

        await expect(secrets.put("the secret", { scope: "thread-1", ttlMs: 1000 })).rejects.toThrow("already in use");
        expect(storage.records.get(`${PREFIX}000000000001000.00000000-0000-4000-8000-000000000000`)).toStrictEqual(appRecord);
    });

    it("does not sweep a non-secret record out from under an expired-looking key", async () => {
        expect.assertions(1);

        const { secrets, storage } = setup(() => 1000);
        const appRecord = { expiresAt: 0 };

        storage.records.set(`${PREFIX}app`, appRecord);
        await secrets.put("the secret", { scope: "thread-1", ttlMs: 60_000 });

        expect(storage.records.get(`${PREFIX}app`)).toStrictEqual(appRecord);
    });
});
