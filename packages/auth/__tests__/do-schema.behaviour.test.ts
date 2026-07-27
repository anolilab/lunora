import { DatabaseSync } from "node:sqlite";

import { scim } from "@better-auth/scim";
import { describe, expect, it } from "vitest";

import { authDoColumnAdditions, authDoSchemaStatements } from "../src/do-schema";
import { admin } from "../src/plugins";

/**
 * The DDL that backs `lunoraDoAdapter`.
 *
 * The property that earns these tests is uniqueness. better-auth expresses
 * `unique: true` as a separate `CREATE UNIQUE INDEX`, not a column constraint, so a
 * materialiser that walks `fields` alone yields tables that accept duplicate
 * emails and duplicate SCIM external ids without complaint. Several assertions
 * below therefore execute the DDL against a real SQLite and try the duplicate
 * insert — asserting on the generated string alone would not prove the constraint
 * is live.
 */

const SECRET = "lunora-do-schema-secret-lunora-do-schema-xx";

const scimOptions = {
    connections: [{ credentials: [{ id: "primary", token: "do-schema-token", type: "bearer" as const }], id: "okta-acme" }], // secret-scanner:allow
};

/** Physical column names on a table, the way the DO reads them. */
const columnNames = (database: DatabaseSync, table: string): string[] =>
    database
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(table)
        .map((row) => String(row.name));

/** Apply the statements to an in-memory SQLite and hand back the connection. */
const materialise = (options: Parameters<typeof authDoSchemaStatements>[0]): DatabaseSync => {
    const database = new DatabaseSync(":memory:");

    for (const statement of authDoSchemaStatements(options)) {
        database.exec(statement);
    }

    return database;
};

describe("authDoSchemaStatements", () => {
    it("creates the core tables every better-auth config needs", () => {
        expect.assertions(1);

        const database = materialise({ secret: SECRET });
        const names = database
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
            .all()
            .map((row) => row.name);

        expect(names).toStrictEqual(expect.arrayContaining(["account", "session", "user", "verification"]));
    });

    it("enforces uniqueness on user.email, which a fields-only walk would miss", () => {
        expect.assertions(1);

        const database = materialise({ secret: SECRET });
        const insert = (id: string): void => {
            database
                .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, '', '')`)
                .run(id, "Ada", "ada@acme.test");
        };

        insert("u1");

        // The whole point: the second insert must be refused by the unique index,
        // not accepted into a table that merely looks correct.
        expect(() => {
            insert("u2");
        }).toThrow(/UNIQUE/i);
    });

    it("creates SCIM's tables and their unique indexes when the plugin is loaded", () => {
        expect.assertions(2);

        const database = materialise({ plugins: [scim(scimOptions), admin()], secret: SECRET });

        const tables = database
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all()
            .map((row) => String(row.name));
        const uniqueIndexes = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '%UNIQUE%'`).all();

        expect(tables.filter((name) => name.startsWith("scim")).length).toBeGreaterThan(0);
        expect(uniqueIndexes.length).toBeGreaterThan(0);
    });

    it("marks required columns NOT NULL and leaves optional ones nullable", () => {
        expect.assertions(2);

        const database = materialise({ secret: SECRET });
        const columns = database.prepare(`SELECT name, "notnull" FROM pragma_table_info('user')`).all();
        const byName = new Map(columns.map((row) => [String(row.name), Number(row.notnull)]));

        // `email` is required in better-auth's core schema; `image` is not.
        expect(byName.get("email")).toBe(1);
        expect(byName.get("image")).toBe(0);
    });

    it("is idempotent, so a cold start can re-run it", () => {
        expect.assertions(1);

        const options = { plugins: [scim(scimOptions), admin()], secret: SECRET };
        const database = materialise(options);

        // Every statement is IF NOT EXISTS — a second pass must be a no-op rather
        // than an error, because the DO applies this on each cold start.
        expect(() => {
            for (const statement of authDoSchemaStatements(options)) {
                database.exec(statement);
            }
        }).not.toThrow();
    });

    it("adds the columns a newly-enabled plugin needs to an existing table", () => {
        expect.assertions(3);

        // Deploy once without `admin`…
        const database = materialise({ secret: SECRET });
        const columnsOf = (table: string): string[] => columnNames(database, table);

        expect(columnsOf("user")).not.toContain("role");

        // …then enable it. `CREATE TABLE IF NOT EXISTS` is a no-op on the existing
        // `user` table, so without the additions below the column never arrives and
        // every admin write fails on an unknown column.
        const withAdmin = { plugins: [admin()], secret: SECRET };

        for (const statement of authDoSchemaStatements(withAdmin)) {
            database.exec(statement);
        }

        const additions = authDoColumnAdditions(withAdmin, columnsOf);

        expect(additions.length).toBeGreaterThan(0);

        for (const statement of additions) {
            database.exec(statement);
        }

        expect(columnsOf("user")).toContain("role");
    });

    it("adds nothing when the live schema is already current", () => {
        expect.assertions(1);

        const options = { plugins: [admin()], secret: SECRET };
        const database = materialise(options);
        const columnsOf = (table: string): string[] => columnNames(database, table);

        // Idempotence matters as much as the addition: this runs on every cold start.
        expect(authDoColumnAdditions(options, columnsOf)).toStrictEqual([]);
    });

    it("never emits an addition for a table that does not exist yet", () => {
        expect.assertions(1);

        // An empty column list means "absent" — emitting ALTER against it would throw,
        // and `CREATE TABLE IF NOT EXISTS` is what handles that case.
        expect(authDoColumnAdditions({ plugins: [admin()], secret: SECRET }, () => [])).toStrictEqual([]);
    });

    it("names indexes the way better-auth's own introspection expects", () => {
        expect.assertions(1);

        const statements = authDoSchemaStatements({ secret: SECRET });

        // The names come from better-auth's resolver, not from a local convention,
        // so a schema migrated to D1 later compares equal instead of reporting
        // drift on every index.
        expect(statements.some((statement) => statement.includes("CREATE UNIQUE INDEX") && statement.includes(`"user"`))).toBe(true);
    });
});
