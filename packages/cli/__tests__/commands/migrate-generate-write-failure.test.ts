import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrateGenerateCommand } from "../../src/commands/migrate/handler";
import type { Logger } from "../../src/util/logger";

const failSqlWrite = vi.hoisted(() => {
    return { enabled: false };
});

// A write that fails after the exclusive open has created the file (a full disk) cannot be produced
// on demand, so the SQL write is made to leave a partial file and throw.
vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
            const [path] = args;

            if (failSqlWrite.enabled && typeof path === "string" && path.endsWith(".sql")) {
                actual.writeFileSync(path, "-- partial", { encoding: "utf8", flag: "wx" });

                throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
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
        rmSync(workdir, { force: true, recursive: true });
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
