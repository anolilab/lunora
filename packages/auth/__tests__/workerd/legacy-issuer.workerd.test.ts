import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AuthStorageDO } from "./test-worker";
import { SCIM_TOKEN } from "./test-worker";

/**
 * The `account.issuer` cleanup, against a **real** Durable Object.
 *
 * better-auth 1.7.0 added a required `account.issuer` column and 1.7.3 reverted it
 * (better-auth/better-auth#11153). The revert only stopped better-auth *writing* the
 * column — upstream's migrator does not remove it — so a DO provisioned while
 * 1.7.0-1.7.2 was installed keeps `issuer text NOT NULL` and every account write fails.
 *
 * A Node suite could exercise the statements against `node:sqlite`, and
 * `__tests__/legacy-issuer.test.ts` does. What it cannot prove is the two things that
 * actually decide whether a deployed app recovers: that workerd's SQLite accepts
 * `ALTER TABLE ... DROP COLUMN` at all (its authorizer refuses plenty — `sqlite_version()`
 * among them), and that `LunoraAuthDO` really runs the cleanup on the cold-start path
 * rather than only owning a function that would. Both are DO-only facts.
 */

/** The `account` table exactly as `authDoSchemaStatements` rendered it under 1.7.0-1.7.2. */
const LEGACY_ACCOUNT_DDL = `CREATE TABLE "account" (
    "id" text NOT NULL PRIMARY KEY,
    "providerId" text NOT NULL,
    "issuer" text NOT NULL,
    "accountId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" date,
    "refreshTokenExpiresAt" date,
    "scope" text,
    "password" text,
    "createdAt" date NOT NULL,
    "updatedAt" date NOT NULL
)`;

const LEGACY_ACCOUNT_INDEX = `CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")`;

/** Exactly the row better-auth 1.7.3 writes when linking a local password account. */
const LINK_ACCOUNT_SQL = `INSERT INTO "account" ("id", "providerId", "accountId", "userId", "password", "createdAt", "updatedAt")
    VALUES ('acc_1', 'credential', 'user_1', 'user_1', 'hashed', 0, 0)`;

/**
 * Force the object through `#ensureReady`, which is where the schema is materialised and
 * the cleanup runs. Any authenticated auth route does it; SCIM is the one this worker has.
 *
 * `instance` is typed explicitly because `runInDurableObject`'s inference otherwise widens
 * it to a shape whose `fetch` is optional.
 */
const warmSchema = async (stub: DurableObjectStub): Promise<void> => {
    await runInDurableObject(stub, async (instance: AuthStorageDO) => {
        await instance.fetch(new Request("https://example.test/api/auth/scim/v2/Users", { headers: { authorization: `Bearer ${SCIM_TOKEN}` } }));
    });
};

describe("legacy account.issuer cleanup in workerd", () => {
    it("drops the reverted column on cold start, so account writes work again", async () => {
        expect.assertions(3);

        const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName("legacy-issuer"));

        // 1. A database provisioned by an older @lunora/auth, before better-auth runs here.
        await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec(LEGACY_ACCOUNT_DDL);
            state.storage.sql.exec(LEGACY_ACCOUNT_INDEX);
        });

        const before = await runInDurableObject(stub, (_instance, state) => {
            try {
                state.storage.sql.exec(LINK_ACCOUNT_SQL);

                return "inserted";
            } catch (error) {
                return String(error);
            }
        });

        // The break this cleanup exists for — asserted rather than assumed, so the test
        // still means something if better-auth ever changes the shape again.
        expect(before).toMatch(/NOT NULL constraint failed: account\.issuer/u);

        // 2. The first real request materialises the schema, which is where the cleanup runs.
        await warmSchema(stub);

        // 3. The column is gone and the write better-auth 1.7.3 makes now lands.
        const after = await runInDurableObject(stub, (_instance, state) => {
            const columns = [...state.storage.sql.exec(`SELECT name FROM pragma_table_info('account')`)]
                .map((row) => row["name"])
                .filter((name) => typeof name === "string");

            try {
                state.storage.sql.exec(LINK_ACCOUNT_SQL);

                return { columns, insert: "inserted" };
            } catch (error) {
                return { columns, insert: String(error) };
            }
        });

        expect(after.columns).not.toContain("issuer");
        expect(after.insert).toBe("inserted");
    });

    it("leaves a database that never had the column alone", async () => {
        // The cleanup is gated on the column actually being present: on a fresh DO it
        // must not run, or every cold start would issue a failing `DROP COLUMN`.
        expect.assertions(2);

        const stub = env.AUTH_DO.get(env.AUTH_DO.idFromName("no-legacy-issuer"));

        await warmSchema(stub);

        const columns = await runInDurableObject(stub, (_instance, state) =>
            [...state.storage.sql.exec(`SELECT name FROM pragma_table_info('account')`)].map((row) => row["name"]).filter((name) => typeof name === "string"),
        );

        expect(columns).toContain("accountId");
        expect(columns).not.toContain("issuer");
    });
});
