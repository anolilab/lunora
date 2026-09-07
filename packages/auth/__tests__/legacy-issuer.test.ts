import { describe, expect, it } from "vitest";

import { indexesReferencingIssuer, legacyIssuerCleanupStatements, schemaDeclaresIssuer } from "../src/legacy-issuer";

/**
 * The pure decisions the `account.issuer` cleanup is built out of.
 *
 * The end-to-end proof — that a database provisioned under better-auth 1.7.0-1.7.2 is
 * actually repaired — lives in `__tests__/workerd/legacy-issuer.workerd.test.ts`, against
 * a real Durable Object. Reproducing it here on `node:sqlite` would assert the same three
 * things against an engine that cannot reproduce workerd's constraints, so this file
 * covers only what is engine-independent: which columns are ours to drop, which indexes
 * block the drop, and the statements that come out.
 */

describe("schemaDeclaresIssuer", () => {
    it("claims the column when better-auth's current schema declares it", () => {
        // An app can add its own `account.issuer` through `account.additionalFields`, and
        // better-auth merges it into the account model. Dropping that column would destroy
        // app data — and on the DO path `authDoColumnAdditions` would re-add it on the next
        // cold start, so the two steps would add and drop it forever.
        expect.assertions(1);

        expect(schemaDeclaresIssuer(["id", "providerId", "accountId", "issuer"])).toBe(true);
    });

    it("disclaims it for the schema better-auth 1.7.3 actually resolves", () => {
        expect.assertions(2);

        expect(schemaDeclaresIssuer(["id", "providerId", "accountId", "userId", "password"])).toBe(false);
        expect(schemaDeclaresIssuer([])).toBe(false);
    });
});

describe("indexesReferencingIssuer", () => {
    it("finds the index better-auth created, whatever it ended up being called", () => {
        // better-auth names an index after the PHYSICAL columns, so an app that renamed
        // `accountId` got a different name. Enumerating is what makes the rename survivable;
        // a name reconstructed from the default fields would miss this one, and the leftover
        // index then makes `DROP COLUMN` fail.
        expect.assertions(1);

        expect(
            indexesReferencingIssuer([
                {
                    name: "account_issuer_provider_account_id_uidx",
                    sql: `CREATE UNIQUE INDEX "account_issuer_provider_account_id_uidx" ON "account" ("issuer", "provider_account_id")`,
                },
            ]),
        ).toStrictEqual(["account_issuer_provider_account_id_uidx"]);
    });

    it("finds a second index someone added by hand, which one guessed name would leave behind", () => {
        expect.assertions(1);

        expect(
            indexesReferencingIssuer([
                { name: "account_issuer_accountId_uidx", sql: `CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId")` },
                { name: "account_issuer_idx", sql: `CREATE INDEX "account_issuer_idx" ON "account" ("issuer")` },
            ]),
        ).toStrictEqual(["account_issuer_accountId_uidx", "account_issuer_idx"]);
    });

    it("leaves indexes that do not reference the column alone", () => {
        expect.assertions(1);

        expect(
            indexesReferencingIssuer([
                { name: "account_userId_idx", sql: `CREATE INDEX "account_userId_idx" ON "account" ("userId")` },
                { name: "account_issuerId_idx", sql: `CREATE INDEX "account_issuerId_idx" ON "account" ("issuerId")` },
            ]),
        ).toStrictEqual([]);
    });

    it("skips SQLite's own auto-indexes, which have no DDL to read", () => {
        // `sqlite_autoindex_*` rows carry a null `sql`; they back a UNIQUE/PK constraint and
        // cannot reference a plain column declaration.
        expect.assertions(1);

        expect(indexesReferencingIssuer([{ name: "sqlite_autoindex_account_1", sql: null }, { name: "other" }])).toStrictEqual([]);
    });
});

describe("legacyIssuerCleanupStatements", () => {
    it("drops every blocking index before the column, because SQLite refuses otherwise", () => {
        expect.assertions(1);

        expect(legacyIssuerCleanupStatements("account", ["account_issuer_accountId_uidx", "account_issuer_idx"])).toStrictEqual([
            `DROP INDEX IF EXISTS "account_issuer_accountId_uidx"`,
            `DROP INDEX IF EXISTS "account_issuer_idx"`,
            `ALTER TABLE "account" DROP COLUMN "issuer"`,
        ]);
    });

    it("quotes a renamed account table rather than interpolating it raw", () => {
        expect.assertions(1);

        expect(legacyIssuerCleanupStatements("auth_account")).toStrictEqual([`ALTER TABLE "auth_account" DROP COLUMN "issuer"`]);
    });
});
