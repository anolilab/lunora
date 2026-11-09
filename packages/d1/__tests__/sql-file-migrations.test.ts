import { DatabaseSync } from "node:sqlite";

import type { SchemaLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/d1-client";
import { applySqlMigrationFiles } from "../src/sql-file-migrations";

/**
 * A {@link D1DatabaseLike} over a real `node:sqlite` connection, so the statements run through SQLite itself. `beforeBatch`
 * runs first on every batch, so a test can make a concurrent write, or a failure, land between the plan and the batch.
 */
const createSqliteDatabase = (sqlite: DatabaseSync, beforeBatch: () => void = () => {}): D1DatabaseLike => {
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
            beforeBatch();

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

/** A schema holding one `.global()` table. Validators are the `_meta.column` shape the sql-store provisioning tests build. */
const globalSchema = (table: unknown): SchemaLike => ({ tables: { notes: table } }) as unknown as SchemaLike;

const notesWithSlug = {
    indexes: [],
    shape: { slug: { _meta: { column: { defaultValue: "untitled", notNull: true } }, kind: "string" } },
    shardMode: { kind: "global" },
};

const optionalWithDefault = { _meta: { column: { defaultValue: "untitled" } }, inner: { kind: "string" }, kind: "optional" };

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

        // A file must already be recorded: on a fresh database a row write is refused, and this test is about splitting.
        await applySqlMigrationFiles(database, [{ name: "setup.sql", sql: "CREATE TABLE seed (id INTEGER);" }]);

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
                rootOnly: [DROP_STATEMENT],
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

    it("refuses a file whose SQL moved to another name, instead of replaying it under the new one", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "old_name.sql", sql: "CREATE TABLE a (id INTEGER);" }]);

        await expect(applySqlMigrationFiles(database, [{ name: "new_name.sql", sql: "CREATE TABLE a (id INTEGER);" }])).rejects.toMatchObject({
            code: "MIGRATION_DRIFT",
            message: expect.stringContaining("renamed"),
        });
        expect(tables(sqlite)).toEqual(["__lunora_sql_migrations", "a"]);

        sqlite.close();
    });

    it("skips an ADD COLUMN whose column is already there under a different capitalisation", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (Sender TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [{ name: "add_sender.sql", sql: "ALTER TABLE t ADD COLUMN sender TEXT;" }]);

        expect(result.files[0]?.state).toBe("ran");
        expect(result.files[0]?.skipped).toHaveLength(1);

        sqlite.close();
    });

    it("runs an ADD COLUMN that follows a DROP COLUMN of the same name earlier in its own file", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT, c TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [{ name: "swap_c.sql", sql: "ALTER TABLE t DROP COLUMN c;\nALTER TABLE t ADD COLUMN c TEXT;" }], {
            confirmDestructive: true,
        });

        expect(result.files[0]?.skipped).toEqual([]);
        expect((sqlite.prepare('PRAGMA table_info("t")').all() as { name: string }[]).map((row) => row.name)).toEqual(["id", "c"]);

        sqlite.close();
    });

    it("reports transaction control in a dry run and a baseline, and refuses it when the file would run", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const sql = "BEGIN;\nCREATE TABLE t (id INTEGER);\nCOMMIT;";

        const plan = await applySqlMigrationFiles(database, [{ name: "tx.sql", sql }], { dryRun: true });

        expect(plan.files[0]?.statements).toHaveLength(3);

        await expect(applySqlMigrationFiles(database, [{ name: "tx.sql", sql }])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        const baselined = await applySqlMigrationFiles(database, [{ name: "tx.sql", sql }], { baseline: true });

        expect(baselined.files[0]?.state).toBe("baselined");

        sqlite.close();
    });

    it("baselines only the files up to the named one, and a later run applies the rest", async () => {
        expect.assertions(5);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [
            { name: "a.sql", sql: "CREATE TABLE a (id INTEGER);" },
            { name: "b.sql", sql: "CREATE TABLE b (id INTEGER);" },
            { name: "drop_a.sql", sql: DROP_FILE },
        ];

        const baselined = await applySqlMigrationFiles(database, files, { baselineThrough: "b.sql" });

        expect(baselined.files.map((file) => file.state)).toEqual(["baselined", "baselined", "pending"]);
        expect(tables(sqlite)).not.toContain("a");

        await expect(applySqlMigrationFiles(database, files)).rejects.toMatchObject({ code: "MIGRATION_DESTRUCTIVE" });

        const later = await applySqlMigrationFiles(database, files, { confirmDestructive: true });

        expect(later.files.map((file) => file.state)).toEqual(["applied", "applied", "ran"]);
        expect(trackedNames(sqlite)).toEqual(["a.sql", "b.sql", "drop_a.sql"]);

        sqlite.close();
    });

    it("refuses baseline and baselineThrough together, and a baselineThrough that names no file", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [{ name: "a.sql", sql: "CREATE TABLE a (id INTEGER);" }];

        await expect(applySqlMigrationFiles(database, files, { baseline: true, baselineThrough: "a.sql" })).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        await expect(applySqlMigrationFiles(database, files, { baselineThrough: "missing.sql" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        sqlite.close();
    });

    it("refuses a row write on a database with no recorded file, even when confirmed", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "emails" ("_id" TEXT, "seen" INTEGER)');
        sqlite.exec('INSERT INTO "emails" ("_id", "seen") VALUES (\'1\', 0)');

        await expect(
            applySqlMigrationFiles(database, [{ name: "backfill.sql", sql: 'UPDATE "emails" SET "seen" = 1;' }], { confirmDestructive: true }),
        ).rejects.toMatchObject({ code: "MIGRATION_DESTRUCTIVE" });
        expect((sqlite.prepare('SELECT "seen" FROM "emails"').all() as { seen: number }[])[0]?.seen).toBe(0);

        sqlite.close();
    });

    it("fills the rows a column a file adds predates with the declared default, in the same batch", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "notes" ("id" TEXT, "body" TEXT)');
        sqlite.exec(`INSERT INTO "notes" ("id", "body") VALUES ('n1', 'hello'), ('n2', 'world')`);

        await applySqlMigrationFiles(database, [{ name: "add_slug.sql", sql: 'ALTER TABLE "notes" ADD COLUMN "slug" TEXT;' }], {
            schema: globalSchema(notesWithSlug),
        });

        expect(sqlite.prepare('SELECT "slug" FROM "notes" ORDER BY "id"').all()).toEqual([{ slug: "untitled" }, { slug: "untitled" }]);
        expect(sqlite.prepare("SELECT name FROM __lunora_sql_migrations").all()).toHaveLength(1);

        sqlite.close();
    });

    it("leaves a column the runtime added before the file alone, since the runtime already filled it", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "notes" ("id" TEXT, "body" TEXT, "slug" TEXT)');
        sqlite.exec(`INSERT INTO "notes" ("id", "body") VALUES ('n1', 'hello')`);

        await applySqlMigrationFiles(database, [{ name: "add_slug.sql", sql: 'ALTER TABLE "notes" ADD COLUMN "slug" TEXT;' }], {
            schema: globalSchema(notesWithSlug),
        });

        expect(sqlite.prepare('SELECT "slug" FROM "notes"').all()).toEqual([{ slug: null }]);

        sqlite.close();
    });

    it("writes no backfill for a column that may hold null", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "notes" ("id" TEXT)');
        sqlite.exec(`INSERT INTO "notes" ("id") VALUES ('n1')`);

        const optionalSlug = { indexes: [], shape: { slug: optionalWithDefault }, shardMode: { kind: "global" } };

        await applySqlMigrationFiles(database, [{ name: "add_slug.sql", sql: 'ALTER TABLE "notes" ADD COLUMN "slug" TEXT;' }], {
            schema: globalSchema(optionalSlug),
        });

        expect(sqlite.prepare('SELECT "slug" FROM "notes"').all()).toEqual([{ slug: null }]);

        sqlite.close();
    });

    it("keeps a migrations-scoped run from disarming the fresh-database guard", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        sqlite.exec('CREATE TABLE "emails" ("_id" TEXT, "seen" INTEGER)');
        sqlite.exec('INSERT INTO "emails" ("_id", "seen") VALUES (\'1\', 0)');

        await applySqlMigrationFiles(database, [{ name: "create_tags.sql", sql: "CREATE TABLE tags (id TEXT);" }], { additiveOnly: true });

        await expect(
            applySqlMigrationFiles(
                database,
                [
                    { name: "create_tags.sql", sql: "CREATE TABLE tags (id TEXT);" },
                    { name: "backfill.sql", sql: 'UPDATE "emails" SET "seen" = 1;' },
                ],
                { confirmDestructive: true },
            ),
        ).rejects.toMatchObject({ code: "MIGRATION_DESTRUCTIVE" });
        expect((sqlite.prepare('SELECT "seen" FROM "emails"').all() as { seen: number }[])[0]?.seen).toBe(0);

        sqlite.close();
    });

    it("lets a root run replace the row a migrations-scoped run recorded under the same name", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "007.sql", sql: "CREATE TABLE squat (id TEXT);" }], { additiveOnly: true });

        const result = await applySqlMigrationFiles(database, [{ name: "007.sql", sql: "CREATE TABLE real (id TEXT);" }]);

        expect(result.files[0]?.state).toBe("ran");
        expect(tables(sqlite)).toContain("real");
        expect((sqlite.prepare("SELECT written_by FROM __lunora_sql_migrations WHERE name = '007.sql'").get() as { written_by: string }).written_by).toBe(
            "root",
        );

        sqlite.close();
    });

    it("refuses a replacement whose squatted row a concurrent run changed before the batch", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");

        await applySqlMigrationFiles(createSqliteDatabase(sqlite), [{ name: "007.sql", sql: "CREATE TABLE squat (id TEXT);" }], { additiveOnly: true });

        let raced = false;
        const database = createSqliteDatabase(sqlite, () => {
            // The plan read the squatted hash. A concurrent scoped run changes it before this batch.
            if (!raced) {
                raced = true;
                sqlite.exec("UPDATE __lunora_sql_migrations SET sha256 = 'changed-again' WHERE name = '007.sql'");
            }
        });

        await expect(applySqlMigrationFiles(database, [{ name: "007.sql", sql: "CREATE TABLE real (id TEXT);" }])).rejects.toMatchObject({
            code: "MIGRATION_DRIFT",
        });
        expect(tables(sqlite)).not.toContain("real");

        sqlite.close();
    });

    it("does not read a file as renamed from a row a migrations-scoped run recorded", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "old.sql", sql: "CREATE TABLE IF NOT EXISTS a (id TEXT);" }], { additiveOnly: true });

        const result = await applySqlMigrationFiles(database, [{ name: "new.sql", sql: "CREATE TABLE IF NOT EXISTS a (id TEXT);" }]);

        expect(result.files[0]?.state).toBe("ran");

        sqlite.close();
    });

    it("keeps a mismatch that a migrations-scoped run meets as drift, since a scoped run never replaces a row", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "a.sql", sql: "CREATE TABLE IF NOT EXISTS a (id TEXT);" }], { additiveOnly: true });

        await expect(
            applySqlMigrationFiles(database, [{ name: "a.sql", sql: "CREATE TABLE IF NOT EXISTS b (id TEXT);" }], { additiveOnly: true }),
        ).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });

        sqlite.close();
    });

    it("records a file a concurrent run recorded first with the same SQL, and refuses one recorded with other SQL", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        // A concurrent run records a.sql with other SQL after this run has planned it as pending.
        const database = createSqliteDatabase(sqlite, () => {
            sqlite.prepare("INSERT INTO __lunora_sql_migrations (name, sha256, applied_at) VALUES ('a.sql', 'other-sql', 0)").run();
        });

        await expect(applySqlMigrationFiles(database, [{ name: "a.sql", sql: "CREATE TABLE a (id INTEGER);" }])).rejects.toMatchObject({
            code: "MIGRATION_DRIFT",
        });
        expect(tables(sqlite)).not.toContain("a");

        sqlite.close();
    });

    it("refuses a file that a concurrent baseline recorded between the plan and the batch, since its SQL never ran", async () => {
        expect.assertions(2);

        // The hash a baseline would record for CREATE_FILE, taken from a database that records it without running it.
        const probe = new DatabaseSync(":memory:");

        await applySqlMigrationFiles(createSqliteDatabase(probe), [{ name: "create_emails.sql", sql: CREATE_FILE }], { baseline: true });
        const { sha256 } = probe.prepare("SELECT sha256 FROM __lunora_sql_migrations").get() as { sha256: string };
        probe.close();

        const sqlite = new DatabaseSync(":memory:");
        let raced = false;
        const database = createSqliteDatabase(sqlite, () => {
            // The tracking table exists by the first batch. The baseline lands once, after the plan, before the batch.
            if (!raced) {
                raced = true;
                sqlite.exec(`INSERT INTO __lunora_sql_migrations (name, sha256, applied_at, baselined) VALUES ('create_emails.sql', '${sha256}', 0, 1)`);
            }
        });

        await expect(applySqlMigrationFiles(database, [{ name: "create_emails.sql", sql: CREATE_FILE }], {})).rejects.toMatchObject({
            code: "CONFLICT",
        });
        expect(tables(sqlite)).not.toContain("emails");

        sqlite.close();
    });

    it("runs a file of many short statements, each one applied and recorded", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const count = 2000;
        const sql = Array.from({ length: count }, (_, index) => `CREATE TABLE t_${String(index)} (id TEXT);`).join("\n");

        await applySqlMigrationFiles(database, [{ name: "many.sql", sql }], {});

        expect(tables(sqlite).filter((name) => name.startsWith("t_"))).toHaveLength(count);
        expect(trackedNames(sqlite)).toStrictEqual(["many.sql"]);

        sqlite.close();
    });

    it("re-plans once when the runtime added the column between the catalog read and the batch", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT);" }]);

        let raced = false;
        const racing = createSqliteDatabase(sqlite, () => {
            if (raced) {
                return;
            }

            raced = true;
            // The runtime's first-use ADD COLUMN lands here, so the batch's own ADD fails on the duplicate.
            sqlite.exec("ALTER TABLE t ADD COLUMN extra TEXT");

            throw new Error("D1_ERROR: duplicate column name: extra");
        });

        const result = await applySqlMigrationFiles(racing, [{ name: "add_extra.sql", sql: "ALTER TABLE t ADD COLUMN extra TEXT;" }]);

        expect(result.files[0]?.state).toBe("ran");
        expect(result.files[0]?.skipped).toHaveLength(1);
        expect(trackedNames(sqlite)).toEqual(["add_extra.sql", "base.sql"]);

        sqlite.close();
    });

    it("an additive-only run applies a new table, a new index and an added column", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT);" }]);

        const result = await applySqlMigrationFiles(
            database,
            [{ name: "grow.sql", sql: 'CREATE TABLE IF NOT EXISTS "u" (id TEXT);\nCREATE INDEX u_id ON "u" (id);\nALTER TABLE t ADD COLUMN c TEXT;' }],
            { additiveOnly: true },
        );

        expect(result.files[0]?.state).toBe("ran");
        expect(result.files[0]?.rootOnly).toEqual([]);
        expect(tables(sqlite)).toEqual(["__lunora_sql_migrations", "t", "u"]);

        sqlite.close();
    });

    it("an additive-only run treats a statement in the temp schema as root-only, since it persists nothing", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE users (id TEXT);" }]);

        const files = [
            { name: "temp_bare.sql", sql: "CREATE TABLE temp.x (id INTEGER);" },
            { name: "temp_quoted.sql", sql: 'CREATE TABLE "temp".y (id INTEGER);' },
            { name: "temp_alter.sql", sql: "ALTER TABLE temp.users ADD COLUMN note TEXT;" },
        ];
        const plan = await applySqlMigrationFiles(database, files, { additiveOnly: true, dryRun: true });

        expect(plan.files.map((file) => file.rootOnly.length)).toStrictEqual([1, 1, 1]);

        sqlite.close();
    });

    it("an additive-only run refuses any file with a DROP, a row write or a trigger, before running anything", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT);" }]);

        await expect(
            applySqlMigrationFiles(
                database,
                [
                    { name: "new_table.sql", sql: "CREATE TABLE fresh (id TEXT);" },
                    { name: "drop_t.sql", sql: 'drop table "t";' },
                ],
                { additiveOnly: true, confirmDestructive: true },
            ),
        ).rejects.toMatchObject({ code: "MIGRATION_ROOT_REQUIRED" });
        expect(tables(sqlite)).not.toContain("fresh");

        await expect(applySqlMigrationFiles(database, [{ name: "rows.sql", sql: "update t set id = 'x';" }], { additiveOnly: true })).rejects.toMatchObject({
            code: "MIGRATION_ROOT_REQUIRED",
        });

        sqlite.close();
    });

    it("a dry run reports the root-only statements without refusing, for an additive-only caller", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [{ name: "trig.sql", sql: "CREATE TRIGGER t_audit AFTER INSERT ON t BEGIN SELECT 1; END;" }];

        const plan = await applySqlMigrationFiles(database, files, { additiveOnly: true, dryRun: true });

        expect(plan.files[0]?.rootOnly).toHaveLength(1);
        expect(plan.refused).toStrictEqual(["trig.sql"]);

        await expect(applySqlMigrationFiles(database, files, { additiveOnly: true, baseline: true })).rejects.toMatchObject({
            code: "MIGRATION_ROOT_REQUIRED",
        });

        sqlite.close();
    });

    it("skips an ADD COLUMN on a schema-qualified table whose column is already there", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (sender TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [{ name: "add.sql", sql: "ALTER TABLE main.t ADD COLUMN sender TEXT;" }]);

        expect(result.files[0]?.state).toBe("ran");
        expect(result.files[0]?.skipped).toHaveLength(1);
        expect(result.files[0]?.statements).toEqual([]);

        sqlite.close();
    });

    it("skips an ADD COLUMN after a CREATE TABLE IF NOT EXISTS that changes nothing, when the column is already there", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT, c TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [
            { name: "grow.sql", sql: "CREATE TABLE IF NOT EXISTS t (id TEXT);\nALTER TABLE t ADD COLUMN c TEXT;" },
        ]);

        expect(result.files[0]?.state).toBe("ran");
        expect(result.files[0]?.skipped).toHaveLength(1);

        sqlite.close();
    });

    it("refuses a CTE-prefixed row write on a database with no recorded file, and names the statement", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await expect(
            applySqlMigrationFiles(database, [{ name: "cte.sql", sql: "WITH x AS (SELECT 1) DELETE FROM t WHERE id IN x;" }], { confirmDestructive: true }),
        ).rejects.toMatchObject({ code: "MIGRATION_DESTRUCTIVE", message: expect.stringContaining("WITH x AS (SELECT 1) DELETE FROM t WHERE id IN x") });

        sqlite.close();
    });

    it("refuses a file that changes foreign-key enforcement when it would run, and reports it in a dry run", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [{ name: "fk.sql", sql: "PRAGMA foreign_keys = OFF;" }];

        const plan = await applySqlMigrationFiles(database, files, { dryRun: true });

        expect(plan.files[0]?.state).toBe("pending");
        await expect(applySqlMigrationFiles(database, files)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        sqlite.close();
    });

    it("reports, in a dry run, the pending files a real run would refuse for a reason --yes cannot lift", async () => {
        expect.assertions(4);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        const fresh = await applySqlMigrationFiles(database, [{ name: "delete.sql", sql: "DELETE FROM t WHERE id = 1;" }], { dryRun: true });

        expect(fresh.refused).toStrictEqual(["delete.sql"]);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (id TEXT);" }]);

        const scoped = await applySqlMigrationFiles(database, [{ name: "drop.sql", sql: "DROP TABLE t;" }], { additiveOnly: true, dryRun: true });
        const plain = await applySqlMigrationFiles(database, [{ name: "drop.sql", sql: "DROP TABLE t;" }], { dryRun: true });
        const confirmed = await applySqlMigrationFiles(database, [{ name: "drop.sql", sql: "DROP TABLE t;" }], {
            confirmDestructive: true,
            dryRun: true,
        });

        expect(scoped.refused).toStrictEqual(["drop.sql"]);
        expect(plain.refused).toStrictEqual([]);
        expect(confirmed.refused).toStrictEqual([]);

        sqlite.close();
    });

    it("skips an ADD COLUMN whose keywords are split by comments, when the column is already there", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (sender TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [
            { name: "add.sql", sql: "ALTER /* added by hand */ TABLE t\n-- the column\nADD COLUMN sender TEXT;" },
        ]);

        expect(result.files[0]?.skipped).toHaveLength(1);
        expect(result.files[0]?.statements).toStrictEqual([]);

        sqlite.close();
    });

    it("reports as a file's statements only the ones that ran, not an ADD COLUMN that was skipped", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (c TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [{ name: "mixed.sql", sql: "ALTER TABLE t ADD COLUMN c TEXT;\nCREATE TABLE u (id TEXT);" }]);

        expect(result.files[0]?.statements).toStrictEqual(["CREATE TABLE u (id TEXT)"]);

        sqlite.close();
    });

    it("refuses a baseline from an additive-only caller, and writes no tracking row for a file it could not run", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await expect(
            applySqlMigrationFiles(database, [{ name: "drop.sql", sql: "DROP TABLE t;" }], { additiveOnly: true, baseline: true }),
        ).rejects.toMatchObject({ code: "MIGRATION_ROOT_REQUIRED" });
        expect(trackedNames(sqlite)).toStrictEqual([]);

        sqlite.close();
    });

    it("refuses a table copied from a query for an additive-only caller, and for the root token on a fresh database", async () => {
        expect.assertions(4);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const copy = [{ name: "copy.sql", sql: "CREATE TABLE copied AS SELECT 1 AS id;" }];

        await expect(applySqlMigrationFiles(database, copy, { additiveOnly: true })).rejects.toMatchObject({ code: "MIGRATION_ROOT_REQUIRED" });
        expect(tables(sqlite)).not.toContain("copied");

        await expect(applySqlMigrationFiles(database, copy, { confirmDestructive: true })).rejects.toMatchObject({ code: "MIGRATION_DESTRUCTIVE" });
        expect(trackedNames(sqlite)).toStrictEqual([]);

        sqlite.close();
    });

    it("skips an ADD COLUMN on a qualified table written with spaces around the dot", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE t (sender TEXT);" }]);

        const result = await applySqlMigrationFiles(database, [{ name: "add.sql", sql: "ALTER TABLE main . t ADD COLUMN sender TEXT;" }]);

        expect(result.files[0]?.skipped).toHaveLength(1);
        expect(result.files[0]?.statements).toStrictEqual([]);

        sqlite.close();
    });

    it("refuses a schema-qualified foreign-key pragma, and reports it in a dry run", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [{ name: "fk.sql", sql: "PRAGMA main.foreign_keys = OFF;" }];

        const plan = await applySqlMigrationFiles(database, files, { dryRun: true });

        expect(plan.refused).toStrictEqual(["fk.sql"]);
        await expect(applySqlMigrationFiles(database, files)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(trackedNames(sqlite)).toStrictEqual([]);

        sqlite.close();
    });

    it("lets a file read foreign-key enforcement, since a read changes nothing", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);
        const files = [{ name: "read.sql", sql: "PRAGMA foreign_keys;" }];

        const plan = await applySqlMigrationFiles(database, files, { dryRun: true });

        expect(plan.refused).toStrictEqual([]);
        await expect(applySqlMigrationFiles(database, files)).resolves.toMatchObject({ files: [{ state: "ran" }] });

        sqlite.close();
    });

    it("refuses a column added with a DEFAULT for an additive-only caller, and allows one without", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE users (id TEXT);" }]);

        await expect(
            applySqlMigrationFiles(database, [{ name: "role.sql", sql: "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin';" }], {
                additiveOnly: true,
            }),
        ).rejects.toMatchObject({ code: "MIGRATION_ROOT_REQUIRED" });
        await expect(
            applySqlMigrationFiles(database, [{ name: "note.sql", sql: "ALTER TABLE users ADD COLUMN note TEXT;" }], { additiveOnly: true }),
        ).resolves.toMatchObject({ files: [{ state: "ran" }] });
        await expect(
            applySqlMigrationFiles(database, [{ name: "fresh.sql", sql: "CREATE TABLE fresh (id TEXT DEFAULT 'x');" }], { additiveOnly: true }),
        ).resolves.toMatchObject({ files: [{ state: "ran" }] });

        sqlite.close();
    });

    it("refuses a generated column for an additive-only caller, since its expression fills every existing row", async () => {
        expect.assertions(4);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE users (id TEXT);" }]);

        const shadow = [{ name: "shadow.sql", sql: "ALTER TABLE users ADD COLUMN role TEXT GENERATED ALWAYS AS ('admin') VIRTUAL;" }];
        const alias = [{ name: "alias.sql", sql: "ALTER TABLE users ADD COLUMN role TEXT AS ('admin');" }];

        await expect(applySqlMigrationFiles(database, shadow, { additiveOnly: true })).rejects.toMatchObject({
            code: "MIGRATION_ROOT_REQUIRED",
        });
        await expect(applySqlMigrationFiles(database, alias, { additiveOnly: true })).rejects.toMatchObject({
            code: "MIGRATION_ROOT_REQUIRED",
        });

        const named = await applySqlMigrationFiles(database, [{ name: "named.sql", sql: "ALTER TABLE users ADD COLUMN default_note TEXT;" }], {
            additiveOnly: true,
        });

        expect(named.files[0]?.state).toBe("ran");
        expect(named.files[0]?.rootOnly).toStrictEqual([]);

        sqlite.close();
    });

    it("refuses a constraint that writes must satisfy, and a name the framework owns, for an additive-only caller", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE users (id TEXT);" }]);

        const refusals = [
            "CREATE UNIQUE INDEX users_name ON users (id);",
            "CREATE INDEX users_live ON users (id) WHERE id > 0;",
            "ALTER TABLE users ADD COLUMN z TEXT CHECK (z <> 'admin');",
            "CREATE TABLE child (uid TEXT REFERENCES users(id));",
            "ALTER TABLE __lunora_sql_migrations ADD COLUMN x TEXT;",
            "ALTER TABLE users ADD COLUMN blocked TEXT NOT NULL;",
            'ALTER TABLE "__drizzle_migrations" ADD COLUMN note TEXT;',
            "CREATE INDEX users_json ON users (json_extract(id, '$'));",
        ];
        const codes = await Promise.all(
            refusals.map((sql, index) =>
                applySqlMigrationFiles(database, [{ name: `refused_${String(index)}.sql`, sql }], { additiveOnly: true }).then(
                    () => "ran",
                    (error: unknown) => (error as { code?: string }).code,
                ),
            ),
        );

        expect(codes).toStrictEqual(refusals.map(() => "MIGRATION_ROOT_REQUIRED"));

        const plain = await applySqlMigrationFiles(database, [{ name: "index.sql", sql: "CREATE INDEX users_id ON users (id);" }], {
            additiveOnly: true,
        });

        expect(plain.files[0]?.state).toBe("ran");

        sqlite.close();
    });

    it("refuses an index or column that hides an expression or a clause behind a comment, a quoted name or a JSON operator", async () => {
        expect.assertions(2);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await applySqlMigrationFiles(database, [{ name: "base.sql", sql: "CREATE TABLE users (id TEXT, note TEXT);" }]);

        const refusals = [
            "CREATE INDEX users_arrow ON users (note ->> '$.a');",
            "CREATE INDEX users_plain_arrow ON users (note->'$.a');",
            "CREATE INDEX users_call ON/**/users(json_extract(note, '$'));",
            "CREATE INDEX \"users(\" ON users (json_extract(note, '$'));",
            "CREATE INDEX users_quoted ON users (\"note\" ->> '$.a');",
            "CREATE INDEX users_where ON users (id) /**/ WHERE id > 0;",
            "ALTER TABLE users ADD COLUMN blocked TEXT NOT/**/NULL;",
            "ALTER TABLE users ADD COLUMN blocked TEXT DEFAULT/**/'x';",
        ];
        const codes = await Promise.all(
            refusals.map((sql, index) =>
                applySqlMigrationFiles(database, [{ name: `hidden_${String(index)}.sql`, sql }], { additiveOnly: true }).then(
                    () => "ran",
                    (error: unknown) => (error as { code?: string }).code,
                ),
            ),
        );

        expect(codes).toStrictEqual(refusals.map(() => "MIGRATION_ROOT_REQUIRED"));

        // The plain forms, with comments between their tokens and quoted names, are still additive.
        const plain = [
            "CREATE INDEX users_note ON/**/users (note COLLATE NOCASE DESC);",
            'CREATE INDEX IF NOT EXISTS "users_id" ON "users" ("id" ASC, note);',
            "CREATE INDEX users_pair ON users (id, /* sort */ note);",
        ];
        const ran = await applySqlMigrationFiles(
            database,
            plain.map((sql, index) => {
                return { name: `plain_${String(index)}.sql`, sql };
            }),
            { additiveOnly: true },
        );

        expect(ran.files.map((file) => file.state)).toStrictEqual(plain.map(() => "ran"));

        sqlite.close();
    });

    it("names a multi-line refused statement on one line, so the refusal shows all of it", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const database = createSqliteDatabase(sqlite);

        await expect(
            applySqlMigrationFiles(database, [{ name: "multi.sql", sql: "DELETE FROM t -- keep the id filter\nWHERE id = 1;" }], {
                confirmDestructive: true,
            }),
        ).rejects.toMatchObject({ message: expect.stringContaining("multi.sql: DELETE FROM t WHERE id = 1") });

        sqlite.close();
    });
});
