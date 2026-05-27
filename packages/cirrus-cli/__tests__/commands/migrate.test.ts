import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runMigrateGenerateCommand } from "../../src/commands/migrate.js";
import type { Logger } from "../../src/util/logger.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-migrate-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

const writeSchema = (source: string): void => {
    const cirrus = join(workdir, "cirrus");

    mkdirSync(cirrus, { recursive: true });
    writeFileSync(join(cirrus, "schema.ts"), source, "utf8");
};

const fixedNow = (): Date => new Date("2024-04-01T12:34:56.000Z");

describe("cirrus migrate generate", () => {
    test("errors when schema.ts is missing", () => {
        const errors: string[] = [];
        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: { ...silentLogger(), error: (m) => errors.push(m) },
        });

        expect(result.code).toBe(1);
        expect(errors.join("\n")).toContain("schema not found");
    });

    test("first run on a global table emits CREATE TABLE", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }).global().index("by_email", ["email"], { unique: true }),
});
`,
        );

        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "init",
            now: fixedNow,
        });

        expect(result.code).toBe(0);
        expect(result.empty).toBe(false);
        expect(result.migrationFile).toMatch(/20240401123456_init\.sql$/u);

        const sql = readFileSync(result.migrationFile, "utf8");

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
        expect(sql).toContain('"email" TEXT NOT NULL');
        expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "by_email"');

        // Snapshot file is written next to the migration.
        const snapshotPath = join(workdir, "cirrus", "migrations", ".snapshot.json");

        expect(existsSync(snapshotPath)).toBe(true);

        const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { tables: Record<string, unknown> };

        expect(Object.keys(snapshot.tables)).toEqual(["users"]);
    });

    test("ignores sharded (non-global) tables", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        text: v.string(),
    }).shardBy("text"),
});
`,
        );

        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "init",
            now: fixedNow,
        });

        expect(result.code).toBe(0);
        expect(result.empty).toBe(true);
        expect(result.migrationFile).toBe("");
    });

    test("second run on identical schema is a no-op", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
        );

        const first = runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

        expect(first.code).toBe(0);
        expect(first.empty).toBe(false);

        const second = runMigrateGenerateCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "noop",
            now: () => new Date("2024-04-02T00:00:00.000Z"),
        });

        expect(second.code).toBe(0);
        expect(second.empty).toBe(true);
    });

    test("adding a column produces ALTER TABLE ADD COLUMN", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
        );

        runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
        nickname: v.optional(v.string()),
    }).global(),
});
`,
        );

        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "add_nickname",
            now: () => new Date("2024-04-02T00:00:00.000Z"),
        });

        expect(result.code).toBe(0);
        expect(result.empty).toBe(false);

        const sql = readFileSync(result.migrationFile, "utf8");

        expect(sql).toContain('ADD COLUMN "nickname" TEXT');
        expect(sql).not.toContain("NOT NULL"); // v.optional → nullable
    });

    test("removed table produces DROP TABLE", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    sessions: defineTable({ token: v.string() }).global(),
});
`,
        );

        runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

        writeSchema(
            `import { defineSchema, defineTable } from "@cirrus/server";

export const schema = defineSchema({});
`,
        );

        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: silentLogger(),
            name: "drop_sessions",
            now: () => new Date("2024-04-02T00:00:00.000Z"),
        });

        expect(result.code).toBe(0);

        const sql = readFileSync(result.migrationFile, "utf8");

        expect(sql).toContain('DROP TABLE IF EXISTS "sessions"');
    });

    test("emits a manual-SQL comment block for unsupported diffs (drop column)", () => {
        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
        legacy: v.optional(v.string()),
    }).global(),
});
`,
        );

        runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now: fixedNow });

        writeSchema(
            `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
        );

        const warnings: string[] = [];

        const result = runMigrateGenerateCommand({
            cwd: workdir,
            logger: { ...silentLogger(), warn: (m) => warnings.push(m) },
            name: "drop_legacy",
            now: () => new Date("2024-04-02T00:00:00.000Z"),
        });

        expect(result.code).toBe(0);

        const sql = readFileSync(result.migrationFile, "utf8");

        expect(sql).toContain("NOT auto-generated");
        expect(sql).toContain("legacy");
        expect(warnings.join("\n")).toMatch(/unsupported diff/u);
    });
});
