import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { doExecutor } from "../../src/do-store";
import { createSqlAuthStore } from "../../src/sql-store";

/**
 * The `_creationTime` column probe, against **real** workerd SQLite.
 *
 * The `node:sqlite` suite asserts the same three answers and cannot catch the way
 * this went wrong, because the cause is a property of the platform's engine:
 * workerd's SQLite keeps the double-quoted-string misfeature enabled, so a bare
 * `"col"` that resolves to no column becomes a string literal rather than an
 * error. The probe therefore "succeeded" on exactly the tables that lack the
 * column, and every Durable Object auth insert failed. `node:sqlite` builds with
 * `SQLITE_DQS=0`, so it raises either way — a green node suite over a broken
 * adapter.
 *
 * These run the probe through the real `doExecutor` seam, so the qualified
 * reference that fixes it cannot be simplified back out unnoticed.
 */
/** Each case gets its own Durable Object, keyed by its table, so one test's schema cannot answer another's probe. */
const withStorage = async (table: string, assertion: (storage: DurableObjectState["storage"]) => Promise<void>): Promise<void> => {
    const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName(`probe-${table}`));

    await runInDurableObject(stub, async (_instance, state) => assertion(state.storage));
};

describe("createSqlAuthStore `_creationTime` probe on workerd SQLite", () => {
    it("does not add the column to a table that lacks it", async () => {
        expect.assertions(1);

        await withStorage("probeA", async (storage) => {
            storage.sql.exec(`CREATE TABLE "probeA" ("id" TEXT PRIMARY KEY, "key" TEXT)`);

            await createSqlAuthStore(doExecutor(storage)).create("probeA", { id: "a", key: "k" });

            expect([...storage.sql.exec(`SELECT COUNT(*) AS n FROM "probeA"`)][0]?.["n"]).toBe(1);
        });
    });

    it("is not fooled by a CHECK expression that names the column", async () => {
        expect.assertions(1);

        await withStorage("probeB", async (storage) => {
            storage.sql.exec(`CREATE TABLE "probeB" ("id" TEXT PRIMARY KEY, "kind" TEXT CHECK ("kind" <> '_creationTime'))`);

            await createSqlAuthStore(doExecutor(storage)).create("probeB", { id: "b", kind: "k" });

            expect([...storage.sql.exec(`SELECT COUNT(*) AS n FROM "probeB"`)][0]?.["n"]).toBe(1);
        });
    });

    it("fills the column in when the table declares it", async () => {
        expect.assertions(1);

        await withStorage("probeC", async (storage) => {
            storage.sql.exec(`CREATE TABLE "probeC" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "key" TEXT)`);

            await createSqlAuthStore(doExecutor(storage)).create("probeC", { id: "c", key: "k" });

            expect([...storage.sql.exec(`SELECT "_creationTime" FROM "probeC"`)][0]?.["_creationTime"]).toBeGreaterThan(0);
        });
    });
});
