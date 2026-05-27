import { describe, expect, test } from "vitest";

import {
    diffSnapshots,
    renderAddColumn,
    renderCreateIndex,
    renderCreateTable,
    renderDropIndex,
    renderDropTable,
    renderMigrationFile,
    type SchemaSnapshot,
    validatorKindToSqlType,
} from "../../src/util/migration-diff.js";

const snapshot = (tables: SchemaSnapshot["tables"]): SchemaSnapshot => ({ tables, version: 1 });

describe("validatorKindToSqlType", () => {
    test("maps boolean/number/bigint to INTEGER", () => {
        expect(validatorKindToSqlType("boolean")).toBe("INTEGER");
        expect(validatorKindToSqlType("number")).toBe("INTEGER");
        expect(validatorKindToSqlType("bigint")).toBe("INTEGER");
    });

    test("maps bytes to BLOB", () => {
        expect(validatorKindToSqlType("bytes")).toBe("BLOB");
    });

    test("maps string/id/literal to TEXT", () => {
        expect(validatorKindToSqlType("string")).toBe("TEXT");
        expect(validatorKindToSqlType("id")).toBe("TEXT");
        expect(validatorKindToSqlType("literal")).toBe("TEXT");
    });

    test("falls back to TEXT for compound kinds", () => {
        expect(validatorKindToSqlType("object")).toBe("TEXT");
        expect(validatorKindToSqlType("array")).toBe("TEXT");
        expect(validatorKindToSqlType("union")).toBe("TEXT");
    });
});

describe("SQL renderers", () => {
    test("renderCreateTable emits an `_id` primary key + columns", () => {
        const sql = renderCreateTable({
            name: "users",
            columns: {
                email: { sqlType: "TEXT", nullable: false },
                age: { sqlType: "INTEGER", nullable: true },
            },
            indexes: {},
        });

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
        expect(sql).toContain('"_id" TEXT PRIMARY KEY');
        expect(sql).toContain('"email" TEXT NOT NULL');
        expect(sql).toContain('"age" INTEGER');
        expect(sql).not.toMatch(/"age"\s+INTEGER\s+NOT NULL/u);
        expect(sql.trim().endsWith(";")).toBe(true);
    });

    test("renderAddColumn produces ALTER TABLE", () => {
        const sql = renderAddColumn("users", "nickname", { sqlType: "TEXT", nullable: true });

        expect(sql).toBe('ALTER TABLE "users" ADD COLUMN "nickname" TEXT;');
    });

    test("renderDropTable emits DROP TABLE IF EXISTS", () => {
        expect(renderDropTable("users")).toBe('DROP TABLE IF EXISTS "users";');
    });

    test("renderCreateIndex emits the named index", () => {
        const sql = renderCreateIndex("users", { name: "by_email", fields: ["email"], unique: true });

        expect(sql).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "by_email" ON "users" ("email");');
    });

    test("renderDropIndex emits DROP INDEX IF EXISTS", () => {
        expect(renderDropIndex("by_email")).toBe('DROP INDEX IF EXISTS "by_email";');
    });
});

describe("diffSnapshots", () => {
    test("CREATE TABLE when a table appears", () => {
        const previous = snapshot({});
        const next = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false } },
                indexes: {},
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.empty).toBe(false);
        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("createTable");
        expect(diff.entries[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS");
        expect(diff.unsupported).toHaveLength(0);
    });

    test("CREATE TABLE includes its CREATE INDEX statements", () => {
        const previous = snapshot({});
        const next = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false } },
                indexes: {
                    by_email: { name: "by_email", fields: ["email"], unique: true },
                },
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(2);
        expect(diff.entries[0]?.kind).toBe("createTable");
        expect(diff.entries[1]?.kind).toBe("createIndex");
        expect(diff.entries[1]?.sql).toContain("by_email");
    });

    test("DROP TABLE when a table is removed", () => {
        const previous = snapshot({
            users: { name: "users", columns: {}, indexes: {} },
        });
        const next = snapshot({});

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("dropTable");
        expect(diff.entries[0]?.sql).toBe('DROP TABLE IF EXISTS "users";');
    });

    test("ADD COLUMN when a column appears on an existing table", () => {
        const previous = snapshot({
            users: { name: "users", columns: { email: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });
        const next = snapshot({
            users: {
                name: "users",
                columns: {
                    email: { sqlType: "TEXT", nullable: false },
                    nickname: { sqlType: "TEXT", nullable: true },
                },
                indexes: {},
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("addColumn");
        expect(diff.entries[0]?.sql).toContain('ADD COLUMN "nickname" TEXT');
    });

    test("CREATE INDEX / DROP INDEX on column-stable tables", () => {
        const previous = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false } },
                indexes: { by_email_old: { name: "by_email_old", fields: ["email"], unique: false } },
            },
        });
        const next = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false } },
                indexes: { by_email: { name: "by_email", fields: ["email"], unique: false } },
            },
        });

        const diff = diffSnapshots(previous, next);
        const kinds = diff.entries.map((entry) => entry.kind);

        expect(kinds).toEqual(expect.arrayContaining(["createIndex", "dropIndex"]));
    });

    test("DROP COLUMN is unsupported", () => {
        const previous = snapshot({
            users: {
                name: "users",
                columns: {
                    email: { sqlType: "TEXT", nullable: false },
                    legacyColumn: { sqlType: "TEXT", nullable: true },
                },
                indexes: {},
            },
        });
        const next = snapshot({
            users: { name: "users", columns: { email: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported.length).toBeGreaterThan(0);
        expect(diff.unsupported[0]?.kind).toBe("dropColumn");
        expect(diff.unsupported[0]?.summary).toMatch(/legacyColumn/u);
    });

    test("column type change is unsupported", () => {
        const previous = snapshot({
            users: { name: "users", columns: { age: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });
        const next = snapshot({
            users: { name: "users", columns: { age: { sqlType: "INTEGER", nullable: false } }, indexes: {} },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported).toHaveLength(1);
        expect(diff.unsupported[0]?.kind).toBe("columnTypeChange");
    });

    test("empty diff when snapshots are identical", () => {
        const equal = snapshot({
            users: { name: "users", columns: { email: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });

        const diff = diffSnapshots(equal, equal);

        expect(diff.empty).toBe(true);
        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported).toHaveLength(0);
    });

    test("treats missing previous snapshot as initial migration", () => {
        const next = snapshot({
            users: { name: "users", columns: { email: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });

        const diff = diffSnapshots(undefined, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("createTable");
    });
});

describe("renderMigrationFile", () => {
    test("includes per-entry SQL + comments and a header", () => {
        const next = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false } },
                indexes: {},
            },
        });

        const diff = diffSnapshots(undefined, next);
        const body = renderMigrationFile("init", diff, "2024-01-01T00:00:00.000Z");

        expect(body).toContain("Cirrus migration: init");
        expect(body).toContain("2024-01-01T00:00:00.000Z");
        expect(body).toContain('CREATE TABLE IF NOT EXISTS "users"');
    });

    test("appends a manual-SQL comment block for unsupported deltas", () => {
        const previous = snapshot({
            users: {
                name: "users",
                columns: { email: { sqlType: "TEXT", nullable: false }, legacy: { sqlType: "TEXT", nullable: true } },
                indexes: {},
            },
        });
        const next = snapshot({
            users: { name: "users", columns: { email: { sqlType: "TEXT", nullable: false } }, indexes: {} },
        });

        const diff = diffSnapshots(previous, next);
        const body = renderMigrationFile("drop_legacy", diff, "2024-01-01T00:00:00.000Z");

        expect(body).toContain("NOT auto-generated");
        expect(body).toContain("legacy");
    });
});
