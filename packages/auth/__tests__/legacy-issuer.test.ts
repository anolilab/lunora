import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ddlDeclaresLegacyIssuer, hasLegacyIssuerColumn, legacyIssuerCleanupStatements } from "../src/legacy-issuer";

/**
 * The `account` table as `authDoSchemaStatements` rendered it under
 * `@better-auth/core` 1.7.0-1.7.2: `issuer` was `required`, so it became a bare
 * `NOT NULL` column with no default, plus a unique index over `(issuer, accountId)`.
 */
const LEGACY_ACCOUNT_DDL = `CREATE TABLE "account" (
    "id" text NOT NULL PRIMARY KEY,
    "providerId" text NOT NULL,
    "issuer" text NOT NULL,
    "accountId" text NOT NULL,
    "userId" text NOT NULL,
    "password" text
)`;

const LEGACY_ACCOUNT_INDEX = `CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")`;

/** What better-auth 1.7.3 writes when linking a local password account — no `issuer`. */
const linkAccount = (database: DatabaseSync): void => {
    database
        .prepare(`INSERT INTO "account" ("id", "providerId", "accountId", "userId", "password") VALUES (?, ?, ?, ?, ?)`)
        .run("acc_1", "credential", "user_1", "user_1", "hash");
};

describe("legacyIssuerCleanupStatements", () => {
    it("drops the index before the column, because SQLite refuses to drop an indexed column", () => {
        expect.assertions(2);

        const [dropIndex, dropColumn] = legacyIssuerCleanupStatements();

        expect(dropIndex).toBe(`DROP INDEX IF EXISTS "account_issuer_accountId_uidx"`);
        expect(dropColumn).toBe(`ALTER TABLE "account" DROP COLUMN "issuer"`);
    });

    it("names the index the way better-auth named it, so a renamed account table still matches", () => {
        expect.assertions(1);

        // Derived from better-auth's own `getDatabaseIndexName`, not hard-coded — the
        // point is that this drops the index that was actually created.
        expect(legacyIssuerCleanupStatements("auth_account")[0]).toBe(`DROP INDEX IF EXISTS "auth_account_issuer_accountId_uidx"`);
    });

    it("unbreaks a database provisioned under 1.7.0-1.7.2", () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");

        database.exec(LEGACY_ACCOUNT_DDL);
        database.exec(LEGACY_ACCOUNT_INDEX);

        // The break itself: 1.7.3 stopped writing `issuer`, and the column is NOT NULL.
        expect(() => {
            linkAccount(database);
        }).toThrow(/NOT NULL constraint failed: account\.issuer/u);

        for (const statement of legacyIssuerCleanupStatements()) {
            database.exec(statement);
        }

        expect(() => {
            linkAccount(database);
        }).not.toThrow();

        const columns = [...database.prepare(`SELECT name FROM pragma_table_info('account')`).all()].map((row) => row["name"]);

        expect(columns).not.toContain("issuer");
    });
});

describe("hasLegacyIssuerColumn", () => {
    it("detects the column in a physical column list, and stays quiet without it", () => {
        expect.assertions(3);

        expect(hasLegacyIssuerColumn(["id", "providerId", "issuer", "accountId"])).toBe(true);
        expect(hasLegacyIssuerColumn(["id", "providerId", "accountId"])).toBe(false);

        // The table does not exist yet — nothing to clean up.
        expect(hasLegacyIssuerColumn([])).toBe(false);
    });
});

describe("ddlDeclaresLegacyIssuer", () => {
    it("reads the column off a CREATE TABLE, which is all D1 can offer", () => {
        expect.assertions(2);

        expect(ddlDeclaresLegacyIssuer(LEGACY_ACCOUNT_DDL)).toBe(true);
        expect(ddlDeclaresLegacyIssuer(`CREATE TABLE "account" ("id" text NOT NULL, "accountId" text NOT NULL)`)).toBe(false);
    });

    it("does not fire on a different column that merely starts the same", () => {
        // This predicate gates an irreversible `DROP COLUMN`, so a substring match on a
        // user's own `issuerId` / `issuer_url` column would be a data-loss bug.
        expect.assertions(3);

        expect(ddlDeclaresLegacyIssuer(`CREATE TABLE "account" ("issuerId" text NOT NULL)`)).toBe(false);
        expect(ddlDeclaresLegacyIssuer(`CREATE TABLE "account" ("issuer_url" text)`)).toBe(false);
        expect(ddlDeclaresLegacyIssuer(`CREATE TABLE "account" ("reissuer" text)`)).toBe(false);
    });

    it("matches an unquoted column, since the DDL is whatever the original migrator emitted", () => {
        expect.assertions(1);

        expect(ddlDeclaresLegacyIssuer("CREATE TABLE account (id text, issuer text not null, accountId text)")).toBe(true);
    });

    it("treats a missing table as nothing to do", () => {
        expect.assertions(1);

        expect(ddlDeclaresLegacyIssuer("")).toBe(false);
    });
});
