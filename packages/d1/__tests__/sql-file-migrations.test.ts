import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/d1-client";
import { applySqlMigrationFiles } from "../src/sql-file-migrations";

/** A {@link D1DatabaseLike} over a real `node:sqlite` connection, so the statements run through SQLite itself. */
const createSqliteDatabase = (sqlite: DatabaseSync): D1DatabaseLike => {
    const prepare = (sql: string): D1PreparedStatementLike => {
        let bound: unknown[] = [];
        const stmt: D1PreparedStatementLike = {
            all: async () => {
                return { results: sqlite.prepare(sql).all(...(bound as never[])) as never[], success: true };
            },
            bind: (...values) => {
                bound = values;

                return stmt;
            },
            first: async () => null,
            raw: async () => [],
            run: async () => {
                sqlite.prepare(sql).all(...(bound as never[]));

                return { success: true };
            },
        };

        return stmt;
    };

    return {
        batch: async (stmts: D1PreparedStatementLike[]) => {
            const results = [];

            for (const stmt of stmts) {
                // eslint-disable-next-line no-await-in-loop -- D1 batches run their statements in order
                results.push(await stmt.run());
            }

            return results;
        },
        prepare,
        withSession: () => {
            return { getBookmark: () => null, prepare };
        },
    };
};

const tables = (sqlite: DatabaseSync): string[] =>
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const DROP_STATEMENT = `-- Lunora migration: drop_emails\n-- lunora:allow-destructive\nDROP TABLE IF EXISTS "emails"`;

const trackedNames = (sqlite: DatabaseSync): string[] =>
    (sqlite.prepare("SELECT name FROM __lunora_sql_migrations ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const CREATE_FILE = `-- Lunora migration: create_emails
-- Generated at 2026-11-05T14:37:38.000Z
CREATE TABLE IF NOT EXISTS "emails" ("_id" TEXT PRIMARY KEY, "subject" TEXT);
CREATE INDEX IF NOT EXISTS "emails_subject" ON "emails" ("subject");
`;

const DROP_FILE = `-- Lunora migration: drop_emails
-- lunora:allow-destructive
DROP TABLE IF EXISTS "emails";
`;

describe("applySqlMigrationFiles", () => {
    it("runs a multi-statement file once and records it by name and hash", async () => {
        expect.assertions(6);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        const first = await applySqlMigrationFiles(database, [{ name: "create_emails.sql", sql: CREATE_FILE }]);

        expect(first.files.map((file) => file.state)).toEqual(["ran"]);
        expect(first.files[0]?.statements).toHaveLength(2);
        expect(tables(sqlite)).toContain("emails");
        expect(trackedNames(sqlite)).toEqual(["create_emails.sql"]);

        const second = await applySqlMigrationFiles(database, [{ name: "create_emails.sql", sql: CREATE_FILE }]);

        expect(second.files.map((file) => file.state)).toEqual(["applied"]);
        expect(second.files[0]?.statements).toEqual([]);

        sqlite.close();
    });

    it("refuses an applied file whose SQL changed, and runs none of the batch", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "a.sql", sql: "CREATE TABLE a (id INTEGER);" }]);

        await expect(
            applySqlMigrationFiles(database, [
                { name: "a.sql", sql: "CREATE TABLE a (id INTEGER, extra TEXT);" },
                { name: "b.sql", sql: "CREATE TABLE b (id INTEGER);" },
            ]),
        ).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });

        expect(tables(sqlite)).toEqual(["__lunora_sql_migrations", "a"]);

        sqlite.close();
    });

    it("refuses a destructive file without confirmation and leaves its table in place", async () => {
        expect.assertions(5);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "create.sql", sql: CREATE_FILE }]);

        await expect(applySqlMigrationFiles(database, [{ name: "drop.sql", sql: DROP_FILE }])).rejects.toMatchObject({
            code: "MIGRATION_DESTRUCTIVE",
            message: expect.stringContaining("drop.sql: DROP TABLE IF EXISTS"),
        });
        expect(tables(sqlite)).toContain("emails");
        expect(trackedNames(sqlite)).toEqual(["create.sql"]);

        const applied = await applySqlMigrationFiles(database, [{ name: "drop.sql", sql: DROP_FILE }], { confirmDestructive: true });

        expect(applied.files.map((file) => file.state)).toEqual(["ran"]);
        expect(tables(sqlite)).not.toContain("emails");

        sqlite.close();
    });

    it("skips an ADD COLUMN whose column the runtime already provisioned, and still records the file", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "create.sql", sql: CREATE_FILE }]);
        // The runtime adds a `.global()` column on first use, before this file is applied.
        sqlite.exec(`ALTER TABLE "emails" ADD COLUMN "sender" TEXT`);

        const result = await applySqlMigrationFiles(database, [
            { name: "add_sender.sql", sql: `ALTER TABLE "emails" ADD COLUMN "sender" TEXT;\nALTER TABLE emails ADD COLUMN body TEXT;` },
        ]);

        expect(result.files[0]?.skipped).toEqual([`ALTER TABLE "emails" ADD COLUMN "sender" TEXT`]);
        expect(result.files[0]?.state).toBe("ran");
        expect(trackedNames(sqlite)).toContain("add_sender.sql");

        sqlite.close();
    });

    it("splits a CREATE TRIGGER with an inner body `;` as one statement, even when it is not the first", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const sql = `CREATE TABLE posts (id INTEGER);
CREATE TABLE audit (post_id INTEGER);
CREATE TRIGGER posts_audit AFTER INSERT ON posts
BEGIN
    INSERT INTO audit (post_id) VALUES (NEW.id);
END;
INSERT INTO posts (id) VALUES (1);`;

        const result = await applySqlMigrationFiles(database, [{ name: "trigger.sql", sql }]);

        expect(result.files[0]?.statements).toHaveLength(4);
        expect(result.files[0]?.statements[2]).toMatch(/^CREATE TRIGGER posts_audit[\s\S]*\nEND$/u);
        expect(sqlite.prepare("SELECT post_id FROM audit").all()).toEqual([{ post_id: 1 }]);

        sqlite.close();
    });

    it("reports every file's state and writes nothing on a dry run, even when the run would refuse", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "create.sql", sql: CREATE_FILE }]);

        const plan = await applySqlMigrationFiles(database, [{ name: "drop.sql", sql: DROP_FILE }], { dryRun: true });

        expect(plan.files).toEqual([
            {
                destructive: [DROP_STATEMENT],
                name: "drop.sql",
                skipped: [],
                state: "pending",
                statements: [DROP_STATEMENT],
            },
        ]);
        expect(tables(sqlite)).toContain("emails");
        expect(trackedNames(sqlite)).toEqual(["create.sql"]);

        sqlite.close();
    });

    it("refuses transaction control inside a file", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await expect(applySqlMigrationFiles(database, [{ name: "tx.sql", sql: "BEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;" }])).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        expect(tables(sqlite)).toEqual(["__lunora_sql_migrations"]);

        sqlite.close();
    });

    it("refuses a file name that is not a plain *.sql name, and a name sent twice", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await expect(applySqlMigrationFiles(database, [{ name: "../evil.sql", sql: "SELECT 1;" }])).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        await expect(
            applySqlMigrationFiles(database, [
                { name: "x.sql", sql: "CREATE TABLE x (id INTEGER);" },
                { name: "x.sql", sql: "CREATE TABLE y (id INTEGER);" },
            ]),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        sqlite.close();
    });

    it("refuses a destructive file on a database with no recorded file, even when confirmed", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "emails" ("_id" TEXT)');

        await expect(applySqlMigrationFiles(database, [{ name: "drop_emails.sql", sql: DROP_FILE }], { confirmDestructive: true })).rejects.toMatchObject({
            code: "MIGRATION_DESTRUCTIVE",
        });
        expect(tables(sqlite)).toContain("emails");

        sqlite.close();
    });

    it("baseline records existing files without running them, and a later run applies only what is new", async () => {
        expect.assertions(4);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        const baselined = await applySqlMigrationFiles(
            database,
            [
                { name: "create_emails.sql", sql: CREATE_FILE },
                { name: "drop_emails.sql", sql: DROP_FILE },
            ],
            { baseline: true },
        );

        expect(baselined.files.map((file) => file.state)).toEqual(["baselined", "baselined"]);
        expect(tables(sqlite)).not.toContain("emails");

        const later = await applySqlMigrationFiles(
            database,
            [
                { name: "create_emails.sql", sql: CREATE_FILE },
                { name: "drop_emails.sql", sql: DROP_FILE },
                { name: "notes.sql", sql: "CREATE TABLE notes (id INTEGER);" },
            ],
            { confirmDestructive: true },
        );

        expect(later.files.map((file) => file.state)).toEqual(["applied", "applied", "ran"]);
        expect(tables(sqlite)).toContain("notes");

        sqlite.close();
    });

    it("a dry run on a database without the tracking table reports the plan and creates nothing", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        const plan = await applySqlMigrationFiles(database, [{ name: "create_emails.sql", sql: CREATE_FILE }], { dryRun: true });

        expect(plan.files.map((file) => file.state)).toEqual(["pending"]);
        expect(tables(sqlite)).toEqual([]);

        sqlite.close();
    });

    it("an ADD COLUMN after a DROP COLUMN in the same run is planned against the catalog as it stands then", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT, c TEXT);" }]);

        const result = await applySqlMigrationFiles(
            database,
            [
                { name: "drop_c.sql", sql: "ALTER TABLE t DROP COLUMN c;" },
                { name: "add_c.sql", sql: "ALTER TABLE t ADD COLUMN c TEXT;" },
            ],
            { confirmDestructive: true },
        );

        expect(result.files.map((file) => file.state)).toEqual(["ran", "ran"]);
        expect(result.files[1]?.skipped).toEqual([]);
        expect((sqlite.prepare('PRAGMA table_info("t")').all() as { name: string }[]).map((row) => row.name)).toEqual(["id", "c"]);

        sqlite.close();
    });
});
