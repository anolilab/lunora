import { apiKey as upstreamApiKey } from "@better-auth/api-key";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { createAuthAdmin } from "../src/admin";
import { createAuth } from "../src/create-auth";
import { admin, apiKey } from "../src/plugins";

/**
 * `createAuthAdmin`'s API key surface, against the real better-auth runtime on an
 * in-memory adapter. The rows are seeded directly: creating one needs a session,
 * and this spec is about what the admin plane does with a row once it exists.
 */

const SECRET = "x".repeat(32);

const seedDatabase = (): Record<string, unknown[]> => {
    return { account: [], apikey: [], session: [], user: [], verification: [] };
};

/** An admin plane over a fresh in-memory database, with the given plugins. */
const buildAdmin = (database: Record<string, unknown[]>, plugins: Parameters<typeof createAuth>[0]["plugins"] = [apiKey()]) =>
    createAuthAdmin(createAuth({ baseURL: "http://localhost", database: memoryAdapter(database), plugins, secret: SECRET }));

/** A key-value store backed by a `Map`, the shape both `secondaryStorage` and the plugin's `customStorage` take. */
const mapStorage = () => {
    const entries = new Map<string, string>();

    return {
        delete: async (key: string) => {
            entries.delete(key);
        },
        get: async (key: string) => entries.get(key) ?? null,
        getAndDelete: async (key: string) => {
            const value = entries.get(key) ?? null;

            entries.delete(key);

            return value;
        },
        increment: async (key: string) => {
            const next = Number(entries.get(key) ?? 0) + 1;

            entries.set(key, String(next));

            return next;
        },
        set: async (key: string, value: string) => {
            entries.set(key, value);
        },
    };
};

/** The auth instance alongside its admin plane, for specs that mint and verify real keys. */
const buildLiveAuth = (plugins: Parameters<typeof createAuth>[0]["plugins"], extra: Partial<Parameters<typeof createAuth>[0]> = {}) => {
    const auth = createAuth({
        baseURL: "http://localhost",
        database: memoryAdapter(seedDatabase()),
        plugins: [admin(), ...(plugins ?? [])],
        secret: SECRET,
        ...extra,
    });

    return { adminApi: createAuthAdmin(auth), auth };
};

/**
 * The plugin's server endpoints. `createAuth` returns the plugin-agnostic `LunoraAuth`, so
 * the endpoints the plugin adds are not on its type.
 */
const keyApi = (auth: ReturnType<typeof createAuth>) =>
    auth.api as unknown as {
        createApiKey: (input: { body: { userId: string } }) => Promise<{ id: string; key: string }>;
        verifyApiKey: (input: { body: { key: string } }) => Promise<{ valid: boolean }>;
    };

/** Mint a key for a fresh user through the plugin's own server-side create, so it can be verified. */
const mintKey = async (adminApi: ReturnType<typeof createAuthAdmin>, auth: ReturnType<typeof createAuth>) => {
    const user = await adminApi.createUser({ email: "owner@example.com", name: "Owner" });
    const created = await keyApi(auth).createApiKey({ body: { userId: user.id } });

    return { id: created.id, key: created.key };
};

const keyRow = (id: string, referenceId: string): Record<string, unknown> => {
    return {
        configId: "default",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        enabled: true,
        expiresAt: null,
        id,
        key: `hash-of-${id}`,
        name: `key ${id}`,
        referenceId,
        start: `lnr_${id}`,
    };
};

describe("createAuthAdmin API keys", () => {
    it("reports the apiKey capability from the enabled plugins, and honours the override", async () => {
        expect.assertions(3);

        const withPlugin = buildAdmin(seedDatabase());
        const withoutPlugin = buildAdmin(seedDatabase(), [admin()]);
        const forcedOff = createAuthAdmin(
            createAuth({ baseURL: "http://localhost", database: memoryAdapter(seedDatabase()), plugins: [apiKey()], secret: SECRET }),
            {
                features: { apiKey: false },
            },
        );

        await expect(withPlugin.capabilities()).resolves.toMatchObject({ apiKey: true });
        await expect(withoutPlugin.capabilities()).resolves.toMatchObject({ apiKey: false });
        await expect(forcedOff.capabilities()).resolves.toMatchObject({ apiKey: false });
    });

    it("lists only the user's keys and never returns the stored hash", async () => {
        expect.assertions(3);

        const database = seedDatabase();
        const adminApi = buildAdmin(database);

        database["apikey"]?.push(keyRow("k1", "alice"), keyRow("k2", "alice"), keyRow("k3", "bob"));

        const keys = await adminApi.listApiKeys({ userId: "alice" });

        expect(keys.map((key) => key.id)).toStrictEqual(["k1", "k2"]);
        expect(keys.every((key) => !("key" in key))).toBe(true);
        // The rest of the row survives, so the drawer can show a name, prefix and expiry.
        expect(keys[0]).toMatchObject({ name: "key k1", referenceId: "alice", start: "lnr_k1" });
    });

    it("revokes one key by id and leaves the owner's other keys in place", async () => {
        expect.assertions(2);

        const database = seedDatabase();
        const adminApi = buildAdmin(database);

        database["apikey"]?.push(keyRow("k1", "alice"), keyRow("k2", "alice"));

        await adminApi.deleteApiKey({ apiKeyId: "k1" });

        expect((database["apikey"] ?? []).map((row) => (row as { id: string }).id)).toStrictEqual(["k2"]);
        await expect(adminApi.listApiKeys({ userId: "alice" })).resolves.toHaveLength(1);
    });

    it("refuses an unknown key id", async () => {
        expect.assertions(2);

        const database = seedDatabase();
        const adminApi = buildAdmin(database);

        database["apikey"]?.push(keyRow("k1", "alice"));

        await expect(adminApi.deleteApiKey({ apiKeyId: "nope" })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
        expect((database["apikey"] ?? []).map((row) => (row as { id: string }).id)).toStrictEqual(["k1"]);
    });

    it("lets only one of two concurrent revocations of a key report success", async () => {
        expect.assertions(2);

        const database = seedDatabase();
        // Both revocations read the row before either deletes it: the first delete waits for the second to arrive.
        let arrived: (() => void) | undefined;
        const secondArrived = new Promise<void>((resolve) => {
            arrived = resolve;
        });
        let deletes = 0;
        const holdFirstDelete = async (model: string): Promise<void> => {
            if (model !== "apikey") {
                return;
            }

            deletes += 1;

            if (deletes === 1) {
                await secondArrived;
            } else {
                arrived?.();
            }
        };
        const memory = memoryAdapter(database);
        const adminApi = createAuthAdmin(
            createAuth({
                baseURL: "http://localhost",
                database: (options: Parameters<typeof memory>[0]) => {
                    const adapter = memory(options);

                    return {
                        ...adapter,
                        delete: async (input: Parameters<typeof adapter.delete>[0]) => {
                            await holdFirstDelete(input.model);

                            return adapter.delete(input);
                        },
                        deleteMany: async (input: Parameters<typeof adapter.deleteMany>[0]) => {
                            await holdFirstDelete(input.model);

                            return adapter.deleteMany(input);
                        },
                    };
                },
                plugins: [apiKey()],
                secret: SECRET,
            }),
        );

        database["apikey"]?.push(keyRow("k1", "alice"));

        const outcomes = await Promise.allSettled([adminApi.deleteApiKey({ apiKeyId: "k1" }), adminApi.deleteApiKey({ apiKeyId: "k1" })]);

        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { code: "API_KEY_NOT_FOUND" } });
    });

    it("revokes a database-stored key while sessions live in secondary storage, and the key stops verifying", async () => {
        expect.assertions(3);

        const { adminApi, auth } = buildLiveAuth([apiKey({ rateLimit: { enabled: false } })], { secondaryStorage: mapStorage() });
        const { id, key } = await mintKey(adminApi, auth);

        await expect(keyApi(auth).verifyApiKey({ body: { key } })).resolves.toMatchObject({ valid: true });

        await adminApi.deleteApiKey({ apiKeyId: id });

        await expect(keyApi(auth).verifyApiKey({ body: { key } })).resolves.toMatchObject({ valid: false });
        await expect(adminApi.deleteApiKey({ apiKeyId: id })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
    });

    it("revokes a key minted under a configuration whose configId is empty, which the plugin treats as the default", async () => {
        expect.assertions(2);

        const { adminApi, auth } = buildLiveAuth([apiKey({ configId: "", rateLimit: { enabled: false } })]);
        const { id, key } = await mintKey(adminApi, auth);

        await adminApi.deleteApiKey({ apiKeyId: id });

        await expect(keyApi(auth).verifyApiKey({ body: { key } })).resolves.toMatchObject({ valid: false });
        await expect(adminApi.deleteApiKey({ apiKeyId: id })).rejects.toMatchObject({ code: "API_KEY_NOT_FOUND" });
    });

    it("refuses to revoke a key the plugin also holds in its own storage, and never reports success over a verifying copy", async () => {
        expect.assertions(2);

        const { adminApi, auth } = buildLiveAuth([
            apiKey({ customStorage: mapStorage(), fallbackToDatabase: true, rateLimit: { enabled: false }, storage: "secondary-storage" }),
        ]);
        const { id, key } = await mintKey(adminApi, auth);

        await expect(adminApi.deleteApiKey({ apiKeyId: id })).rejects.toMatchObject({ code: "API_KEY_STORAGE_UNSUPPORTED" });
        // Refused outright, so the key is exactly as revoked as before the call: not at all.
        await expect(keyApi(auth).verifyApiKey({ body: { key } })).resolves.toMatchObject({ valid: true });
    });

    it("refuses to revoke when the api-key plugin was not added through @lunora/auth/plugins", async () => {
        expect.assertions(2);

        const database = seedDatabase();
        const adminApi = buildAdmin(database, [upstreamApiKey()]);

        database["apikey"]?.push(keyRow("k1", "alice"));

        await expect(adminApi.deleteApiKey({ apiKeyId: "k1" })).rejects.toMatchObject({ code: "API_KEY_STORAGE_UNSUPPORTED" });
        expect((database["apikey"] ?? []).map((row) => (row as { id: string }).id)).toStrictEqual(["k1"]);
    });

    it("cascades removeUser over the user's keys, keyed by referenceId", async () => {
        expect.assertions(2);

        const database = seedDatabase();
        const adminApi = buildAdmin(database, [admin(), apiKey()]);

        const user = await adminApi.createUser({ email: "gone@example.com", name: "Gone" });
        const survivor = await adminApi.createUser({ email: "stays@example.com", name: "Stays" });

        database["apikey"]?.push(keyRow("gone-1", user.id), keyRow("stays-1", survivor.id));

        await adminApi.removeUser({ userId: user.id });

        expect((database["apikey"] ?? []).map((row) => (row as { id: string }).id)).toStrictEqual(["stays-1"]);
        await expect(adminApi.listApiKeys({ userId: survivor.id })).resolves.toHaveLength(1);
    });
});
