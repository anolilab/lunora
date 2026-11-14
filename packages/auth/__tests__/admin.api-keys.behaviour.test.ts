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
