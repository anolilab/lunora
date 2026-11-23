import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrateGenerateCommand } from "../../src/commands/migrate/handler";
import type { Logger } from "../../src/util/logger";

const failSqlWrite = vi.hoisted(() => {
    return { closeFails: false, enabled: false, openFails: false, sqlDescriptors: new Set<number>() };
});

const isSqlPath = (path: unknown): path is string => typeof path === "string" && path.endsWith(".sql");

// Neither failure can be produced on demand: a write that fails after the exclusive open has
// created the file (a full disk), and an open refused before it checks whether the file exists
// (ENFILE). The SQL file's open and write are made to fail that way, whether the code opens it by
// path or through a descriptor.
vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();
    const enfile = (): Error => Object.assign(new Error("ENFILE: file table overflow"), { code: "ENFILE" });
    const enospc = (): Error => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

    return {
        ...actual,
        closeSync: (...args: Parameters<typeof actual.closeSync>) => {
            actual.closeSync(...args);

            if (failSqlWrite.closeFails && failSqlWrite.sqlDescriptors.has(args[0])) {
                throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
            }
        },
        openSync: (...args: Parameters<typeof actual.openSync>) => {
            if (failSqlWrite.openFails && isSqlPath(args[0])) {
                throw enfile();
            }

            const descriptor = actual.openSync(...args);

            if (isSqlPath(args[0])) {
                failSqlWrite.sqlDescriptors.add(descriptor);
            }

            return descriptor;
        },
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
            const [target] = args;

            if (failSqlWrite.openFails && isSqlPath(target)) {
                throw enfile();
            }

            if (failSqlWrite.enabled && isSqlPath(target)) {
                actual.writeFileSync(target, "-- partial", { encoding: "utf8", flag: "wx" });

                throw enospc();
            }

            if (failSqlWrite.enabled && typeof target === "number" && failSqlWrite.sqlDescriptors.has(target)) {
                actual.writeFileSync(target, "-- partial", "utf8");

                throw enospc();
            }

            actual.writeFileSync(...args);
        },
    };
});

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("migrate generate — a failed SQL write", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-migrate-write-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(
            join(workdir, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    users: defineTable({ email: v.string() }).global(),
});
`,
            "utf8",
        );
    });

    afterEach(() => {
        failSqlWrite.enabled = false;
        failSqlWrite.openFails = false;
        failSqlWrite.closeFails = false;
        failSqlWrite.sqlDescriptors.clear();
        rmSync(workdir, { force: true, recursive: true });
    });

    it("removes the migration it wrote when closing it fails, so a retry is not refused or doubled", () => {
        expect.assertions(4);

        const now = (): Date => new Date("2024-04-01T12:34:56.000Z");
        const migrations = join(workdir, "lunora", "migrations");

        failSqlWrite.closeFails = true;

        expect(() => runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now })).toThrow(/EIO/u);
        expect(readdirSync(migrations).filter((name) => name.endsWith(".sql"))).toStrictEqual([]);

        failSqlWrite.closeFails = false;

        const retry = runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now });

        expect(retry.code).toBe(0);
        expect(readFileSync(retry.migrationFile, "utf8")).toContain("CREATE TABLE");
    });

    it("keeps the write error, not a close error, and removes the partial file", () => {
        expect.assertions(2);

        const now = (): Date => new Date("2024-04-01T12:34:56.000Z");

        failSqlWrite.enabled = true;
        failSqlWrite.closeFails = true;

        expect(() => runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now })).toThrow(/ENOSPC/u);
        expect(readdirSync(join(workdir, "lunora", "migrations")).filter((name) => name.endsWith(".sql"))).toStrictEqual([]);
    });

    it("leaves a same-name migration alone when the exclusive open fails before checking it exists", () => {
        expect.assertions(2);

        const now = (): Date => new Date("2024-04-01T12:34:56.000Z");
        const migrations = join(workdir, "lunora", "migrations");
        const existing = join(migrations, "20240401123456_init.sql");

        mkdirSync(migrations, { recursive: true });
        writeFileSync(existing, "-- an earlier run's migration\n", "utf8");
        failSqlWrite.openFails = true;

        expect(() => runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now })).toThrow(/ENFILE/u);
        expect(readFileSync(existing, "utf8")).toBe("-- an earlier run's migration\n");
    });

    it("removes the partial migration it created, so a retry can write it whole", () => {
        expect.assertions(4);

        const now = (): Date => new Date("2024-04-01T12:34:56.000Z");
        const migrations = join(workdir, "lunora", "migrations");

        failSqlWrite.enabled = true;

        expect(() => runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now })).toThrow(/ENOSPC/u);
        expect(readdirSync(migrations).filter((name) => name.endsWith(".sql"))).toStrictEqual([]);

        failSqlWrite.enabled = false;

        const retry = runMigrateGenerateCommand({ cwd: workdir, logger: silentLogger(), name: "init", now });

        expect(retry.code).toBe(0);
        expect(readFileSync(retry.migrationFile, "utf8")).toContain("CREATE TABLE");
    });
});
