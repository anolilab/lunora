import { describe, expect, it } from "vitest";

import type { SchemaSnapshot } from "../../src/util/migration-diff.js";
import {
    diffSnapshots,
    renderAddColumn,
    renderCreateIndex,
    renderCreateTable,
    renderDropIndex,
    renderDropTable,
    renderMigrationFile,
    validatorKindToSqlType,
} from "../../src/util/migration-diff.js";

const snapshot = (tables: SchemaSnapshot["tables"]): SchemaSnapshot => {
    return { tables, version: 1 };
};

describe("validatorKindToSqlType", () => {
    it("maps boolean to INTEGER", () => {
        expect.assertions(1);

        expect(validatorKindToSqlType("boolean")).toBe("INTEGER");
    });

    it("maps number/timestamp/date to REAL (matching the @cirrus/d1 dialect)", () => {
        expect.assertions(3);

        expect(validatorKindToSqlType("number")).toBe("REAL");
        expect(validatorKindToSqlType("timestamp")).toBe("REAL");
        expect(validatorKindToSqlType("date")).toBe("REAL");
    });

    it("maps bytes to BLOB", () => {
        expect.assertions(1);

        expect(validatorKindToSqlType("bytes")).toBe("BLOB");
    });

    it("maps string/id/literal/bigint to TEXT (bigint is serialized as a decimal string)", () => {
        expect.assertions(4);

        expect(validatorKindToSqlType("string")).toBe("TEXT");
        expect(validatorKindToSqlType("id")).toBe("TEXT");
        expect(validatorKindToSqlType("literal")).toBe("TEXT");
        expect(validatorKindToSqlType("bigint")).toBe("TEXT");
    });

    it("falls back to TEXT for compound kinds", () => {
        expect.assertions(3);

        expect(validatorKindToSqlType("object")).toBe("TEXT");
        expect(validatorKindToSqlType("array")).toBe("TEXT");
        expect(validatorKindToSqlType("union")).toBe("TEXT");
    });
});

describe("sQL renderers", () => {
    it("renderCreateTable emits the `id` + `_creationTime` framework columns + fields", () => {
        expect.assertions(7);

        const sql = renderCreateTable({
            columns: {
                age: { nullable: true, sqlType: "REAL" },
                email: { nullable: false, sqlType: "TEXT" },
            },
            indexes: {},
            name: "users",
        });

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
        // Physical framework columns the @cirrus/d1 runtime reads/writes.
        expect(sql).toContain('"id" TEXT PRIMARY KEY');
        expect(sql).toContain('"_creationTime" REAL NOT NULL');
        expect(sql).toContain('"email" TEXT NOT NULL');
        expect(sql).toContain('"age" REAL');
        expect(sql).not.toMatch(/"age"\s+REAL\s+NOT NULL/u);
        expect(sql.trim().endsWith(";")).toBe(true);
    });

    it("renderAddColumn produces ALTER TABLE", () => {
        expect.assertions(1);

        const sql = renderAddColumn("users", "nickname", { nullable: true, sqlType: "TEXT" });

        expect(sql).toBe('ALTER TABLE "users" ADD COLUMN "nickname" TEXT;');
    });

    it("renderDropTable emits DROP TABLE IF EXISTS", () => {
        expect.assertions(1);

        expect(renderDropTable("users")).toBe('DROP TABLE IF EXISTS "users";');
    });

    it("renderCreateIndex emits a `<table>_<name>` index over the physical columns", () => {
        expect.assertions(1);

        const sql = renderCreateIndex("users", { fields: ["email"], name: "by_email", unique: true });

        expect(sql).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "users_by_email" ON "users" ("email");');
    });

    it("renderCreateIndex maps `_id`/`_creationTime` index fields to their physical columns", () => {
        expect.assertions(1);

        const sql = renderCreateIndex("posts", { fields: ["_creationTime"], name: "by_created", unique: false });

        expect(sql).toBe('CREATE INDEX IF NOT EXISTS "posts_by_created" ON "posts" ("_creationTime");');
    });

    it("renderDropIndex emits DROP INDEX IF EXISTS for the physical index name", () => {
        expect.assertions(1);

        expect(renderDropIndex("users", "by_email")).toBe('DROP INDEX IF EXISTS "users_by_email";');
    });
});

describe("diffSnapshots", () => {
    it("cREATE TABLE when a table appears", () => {
        expect.assertions(5);

        const previous = snapshot({});
        const next = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" } },
                indexes: {},
                name: "users",
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.empty).toBe(false);
        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("createTable");
        expect(diff.entries[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS");
        expect(diff.unsupported).toHaveLength(0);
    });

    it("cREATE TABLE includes its CREATE INDEX statements", () => {
        expect.assertions(4);

        const previous = snapshot({});
        const next = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" } },
                indexes: {
                    by_email: { fields: ["email"], name: "by_email", unique: true },
                },
                name: "users",
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(2);
        expect(diff.entries[0]?.kind).toBe("createTable");
        expect(diff.entries[1]?.kind).toBe("createIndex");
        expect(diff.entries[1]?.sql).toContain("by_email");
    });

    it("dROP TABLE when a table is removed", () => {
        expect.assertions(3);

        const previous = snapshot({
            users: { columns: {}, indexes: {}, name: "users" },
        });
        const next = snapshot({});

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("dropTable");
        expect(diff.entries[0]?.sql).toBe('DROP TABLE IF EXISTS "users";');
    });

    it("aDD COLUMN when a column appears on an existing table", () => {
        expect.assertions(3);

        const previous = snapshot({
            users: { columns: { email: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });
        const next = snapshot({
            users: {
                columns: {
                    email: { nullable: false, sqlType: "TEXT" },
                    nickname: { nullable: true, sqlType: "TEXT" },
                },
                indexes: {},
                name: "users",
            },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("addColumn");
        expect(diff.entries[0]?.sql).toContain('ADD COLUMN "nickname" TEXT');
    });

    it("cREATE INDEX / DROP INDEX on column-stable tables", () => {
        expect.hasAssertions();

        const previous = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" } },
                indexes: { by_email_old: { fields: ["email"], name: "by_email_old", unique: false } },
                name: "users",
            },
        });
        const next = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" } },
                indexes: { by_email: { fields: ["email"], name: "by_email", unique: false } },
                name: "users",
            },
        });

        const diff = diffSnapshots(previous, next);
        const kinds = diff.entries.map((entry) => entry.kind);

        expect(kinds).toEqual(expect.arrayContaining(["createIndex", "dropIndex"]));
    });

    it("dROP COLUMN is unsupported", () => {
        expect.assertions(4);

        const previous = snapshot({
            users: {
                columns: {
                    email: { nullable: false, sqlType: "TEXT" },
                    legacyColumn: { nullable: true, sqlType: "TEXT" },
                },
                indexes: {},
                name: "users",
            },
        });
        const next = snapshot({
            users: { columns: { email: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported.length).toBeGreaterThan(0);
        expect(diff.unsupported[0]?.kind).toBe("dropColumn");
        expect(diff.unsupported[0]?.summary).toMatch(/legacyColumn/u);
    });

    it("column type change is unsupported", () => {
        expect.assertions(3);

        const previous = snapshot({
            users: { columns: { age: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });
        const next = snapshot({
            users: { columns: { age: { nullable: false, sqlType: "INTEGER" } }, indexes: {}, name: "users" },
        });

        const diff = diffSnapshots(previous, next);

        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported).toHaveLength(1);
        expect(diff.unsupported[0]?.kind).toBe("columnTypeChange");
    });

    it("empty diff when snapshots are identical", () => {
        expect.assertions(3);

        const equal = snapshot({
            users: { columns: { email: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });

        const diff = diffSnapshots(equal, equal);

        expect(diff.empty).toBe(true);
        expect(diff.entries).toHaveLength(0);
        expect(diff.unsupported).toHaveLength(0);
    });

    it("treats missing previous snapshot as initial migration", () => {
        expect.assertions(2);

        const next = snapshot({
            users: { columns: { email: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });

        const diff = diffSnapshots(undefined, next);

        expect(diff.entries).toHaveLength(1);
        expect(diff.entries[0]?.kind).toBe("createTable");
    });
});

describe("renderMigrationFile", () => {
    it("includes per-entry SQL + comments and a header", () => {
        expect.assertions(3);

        const next = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" } },
                indexes: {},
                name: "users",
            },
        });

        const diff = diffSnapshots(undefined, next);
        const body = renderMigrationFile("init", diff, "2024-01-01T00:00:00.000Z");

        expect(body).toContain("Cirrus migration: init");
        expect(body).toContain("2024-01-01T00:00:00.000Z");
        expect(body).toContain('CREATE TABLE IF NOT EXISTS "users"');
    });

    it("appends a manual-SQL comment block for unsupported deltas", () => {
        expect.assertions(2);

        const previous = snapshot({
            users: {
                columns: { email: { nullable: false, sqlType: "TEXT" }, legacy: { nullable: true, sqlType: "TEXT" } },
                indexes: {},
                name: "users",
            },
        });
        const next = snapshot({
            users: { columns: { email: { nullable: false, sqlType: "TEXT" } }, indexes: {}, name: "users" },
        });

        const diff = diffSnapshots(previous, next);
        const body = renderMigrationFile("drop_legacy", diff, "2024-01-01T00:00:00.000Z");

        expect(body).toContain("NOT auto-generated");
        expect(body).toContain("legacy");
    });
});
