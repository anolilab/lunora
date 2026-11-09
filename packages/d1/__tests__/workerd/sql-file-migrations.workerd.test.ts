/**
 * Real-D1 tests for `applySqlMigrationFiles`, the path `lunora migrate apply` takes on a deployed worker.
 *
 * The node suite proves the statement splitting and the decisions against an in-memory SQLite. These prove them
 * against D1 itself: the batch that commits a file with its tracking row, the tracking table's `name` uniqueness, and
 * that a refused run leaves the database exactly as it was.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { D1DatabaseLike } from "../../src/d1-client";
import { applySqlMigrationFiles } from "../../src/sql-file-migrations";

const database = (): D1DatabaseLike => env.DB as unknown as D1DatabaseLike;

const tableNames = async (): Promise<string[]> => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();

    return results.map((row) => row.name);
};

const trackedNames = async (): Promise<string[]> => {
    const { results } = await env.DB.prepare("SELECT name FROM __lunora_sql_migrations ORDER BY name").all<{ name: string }>();

    return results.map((row) => row.name);
};

const CREATE_FILE = `-- Lunora migration: create_emails
CREATE TABLE IF NOT EXISTS "emails" ("_id" TEXT PRIMARY KEY, "subject" TEXT);
CREATE INDEX IF NOT EXISTS "emails_subject" ON "emails" ("subject");
`;

const DROP_FILE = `-- Lunora migration: drop_emails
-- lunora:allow-destructive
DROP TABLE IF EXISTS "emails";
`;

describe("applySqlMigrationFiles on D1", () => {
    it("runs a multi-statement file once and records it in the tracking table", async () => {
        expect.assertions(4);

        const first = await applySqlMigrationFiles(database(), [{ name: "create_emails.sql", sql: CREATE_FILE }]);

        expect(first.files.map((file) => file.state)).toEqual(["ran"]);
        await expect(tableNames()).resolves.toEqual(expect.arrayContaining(["__lunora_sql_migrations", "emails"]));
        await expect(trackedNames()).resolves.toEqual(["create_emails.sql"]);

        const second = await applySqlMigrationFiles(database(), [{ name: "create_emails.sql", sql: CREATE_FILE }]);

        expect(second.files.map((file) => file.state)).toEqual(["applied"]);
    });

    it("refuses an applied file whose SQL changed, and leaves the database as it was", async () => {
        expect.assertions(3);

        await applySqlMigrationFiles(database(), [{ name: "widgets.sql", sql: "CREATE TABLE widgets (id TEXT);" }]);

        await expect(
            applySqlMigrationFiles(database(), [
                { name: "widgets.sql", sql: "CREATE TABLE widgets (id TEXT, label TEXT);" },
                { name: "gadgets.sql", sql: "CREATE TABLE gadgets (id TEXT);" },
            ]),
        ).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });

        await expect(tableNames()).resolves.not.toContain("gadgets");
        await expect(trackedNames()).resolves.not.toContain("gadgets.sql");
    });

    it("refuses a destructive file without confirmation, and runs it once confirmed", async () => {
        expect.assertions(4);

        await applySqlMigrationFiles(database(), [{ name: "create_emails.sql", sql: CREATE_FILE }]);

        await expect(applySqlMigrationFiles(database(), [{ name: "drop_emails.sql", sql: DROP_FILE }])).rejects.toMatchObject({
            code: "MIGRATION_DESTRUCTIVE",
        });
        await expect(tableNames()).resolves.toContain("emails");

        const applied = await applySqlMigrationFiles(database(), [{ name: "drop_emails.sql", sql: DROP_FILE }], {
            confirmDestructive: true,
        });

        expect(applied.files.map((file) => file.state)).toEqual(["ran"]);
        await expect(tableNames()).resolves.not.toContain("emails");
    });

    it("runs a file of several statements, including a trigger body with its own `;`s, as one batch", async () => {
        expect.assertions(2);

        const sql = `CREATE TABLE posts (id INTEGER);
CREATE TABLE audit (post_id INTEGER);
CREATE TRIGGER posts_audit AFTER INSERT ON posts
BEGIN
    INSERT INTO audit (post_id) VALUES (NEW.id);
END;
INSERT INTO posts (id) VALUES (7);`;

        const result = await applySqlMigrationFiles(database(), [{ name: "audit.sql", sql }]);

        expect(result.files[0]?.statements).toHaveLength(4);

        const { results } = await env.DB.prepare("SELECT post_id FROM audit").all<{ post_id: number }>();

        expect(results).toEqual([{ post_id: 7 }]);
    });

    it("a dry run reports a file nothing has recorded as pending, and creates nothing", async () => {
        expect.assertions(2);

        const plan = await applySqlMigrationFiles(database(), [{ name: "dry_run_only.sql", sql: "CREATE TABLE dry_run_only (id TEXT);" }], {
            dryRun: true,
        });

        expect(plan.files.map((file) => file.state)).toEqual(["pending"]);
        await expect(tableNames()).resolves.not.toContain("dry_run_only");
    });

    it("checks whether an ADD COLUMN's column exists through the binding, without an authorizer refusal", async () => {
        expect.assertions(3);

        await applySqlMigrationFiles(database(), [{ name: "tags.sql", sql: "CREATE TABLE tags (id TEXT, label TEXT);" }]);

        const result = await applySqlMigrationFiles(database(), [
            { name: "tags_add.sql", sql: 'ALTER TABLE "tags" ADD COLUMN "label" TEXT;\nALTER TABLE tags ADD COLUMN color TEXT;' },
        ]);

        expect(result.files[0]?.skipped).toEqual(['ALTER TABLE "tags" ADD COLUMN "label" TEXT']);
        expect(result.files[0]?.state).toBe("ran");

        const { results } = await env.DB.prepare('PRAGMA table_info("tags")').all<{ name: string }>();

        expect(results.map((row) => row.name)).toEqual(["id", "label", "color"]);
    });
});
