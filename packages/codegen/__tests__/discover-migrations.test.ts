import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { discoverMigrations } from "../src/discover-migrations.js";

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-migrate-disco-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

const writeSource = (relative: string, source: string): void => {
    const full = join(workdir, relative);

    mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
    writeFileSync(full, source);
};

const newProject = (): Project => new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });

describe("discoverMigrations", () => {
    test("lifts a top-level defineMigration export into MigrationIR", () => {
        writeSource(
            "migrations.ts",
            `
            import { defineMigration } from "@cirrus/server";
            export const backfill = defineMigration({
                id: "backfill-read-by",
                table: "messages",
                up: (document) => ({ ...document, readBy: [] }),
            });
        `,
        );

        const result = discoverMigrations(newProject(), workdir);

        expect(result).toEqual([{ exportName: "backfill", filePath: "migrations", id: "backfill-read-by", table: "messages" }]);
    });

    test("detects an aliased import — `import { defineMigration as dm }`", () => {
        writeSource(
            "migrations.ts",
            `
            import { defineMigration as dm } from "@cirrus/server";
            export const m = dm({ id: "aliased", table: "users", up: (d) => d });
        `,
        );

        const result = discoverMigrations(newProject(), workdir);

        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("aliased");
    });

    test("ignores a local `defineMigration` not imported from @cirrus/server", () => {
        writeSource(
            "migrations.ts",
            `
            const defineMigration = (definition: { id: string; table: string; up: (d: unknown) => unknown }) => definition;
            export const m = defineMigration({ id: "local", table: "t", up: (d) => d });
        `,
        );

        const result = discoverMigrations(newProject(), workdir);

        expect(result).toHaveLength(0);
    });

    test("leaves table empty when it is not a static string literal", () => {
        writeSource(
            "migrations.ts",
            `
            import { defineMigration } from "@cirrus/server";
            const TABLE = "messages";
            export const m = defineMigration({ id: "dyn-table", table: TABLE, up: (d) => d });
        `,
        );

        const result = discoverMigrations(newProject(), workdir);

        expect(result[0]).toMatchObject({ id: "dyn-table", table: "" });
    });

    test("sorts discovered migrations by id", () => {
        writeSource(
            "a.ts",
            `
            import { defineMigration } from "@cirrus/server";
            export const second = defineMigration({ id: "b-second", table: "t", up: (d) => d });
        `,
        );
        writeSource(
            "z.ts",
            `
            import { defineMigration } from "@cirrus/server";
            export const first = defineMigration({ id: "a-first", table: "t", up: (d) => d });
        `,
        );

        const result = discoverMigrations(newProject(), workdir);

        expect(result.map((migration) => migration.id)).toEqual(["a-first", "b-second"]);
    });

    test("throws MIGRATION_ID_NOT_STATIC when id is not a string literal", () => {
        writeSource(
            "migrations.ts",
            `
            import { defineMigration } from "@cirrus/server";
            const dynamicId = "nope";
            export const m = defineMigration({ id: dynamicId, table: "t", up: (d) => d });
        `,
        );

        const project = newProject();

        expect(() => discoverMigrations(project, workdir)).toThrow(/must declare `id` as a non-empty string literal/u);

        try {
            discoverMigrations(project, workdir);
        } catch (error: unknown) {
            expect(error).toMatchObject({ code: "MIGRATION_ID_NOT_STATIC", name: "CirrusError", status: 500 });
        }
    });

    test("throws DUPLICATE_MIGRATION_ID when two declarations share an id", () => {
        writeSource(
            "one.ts",
            `
            import { defineMigration } from "@cirrus/server";
            export const a = defineMigration({ id: "dup", table: "t", up: (d) => d });
        `,
        );
        writeSource(
            "two.ts",
            `
            import { defineMigration } from "@cirrus/server";
            export const b = defineMigration({ id: "dup", table: "t", up: (d) => d });
        `,
        );

        const project = newProject();

        expect(() => discoverMigrations(project, workdir)).toThrow(/Duplicate migration id "dup"/u);

        try {
            discoverMigrations(project, workdir);
        } catch (error: unknown) {
            expect(error).toMatchObject({ code: "DUPLICATE_MIGRATION_ID", id: "dup", name: "CirrusError", status: 500 });
            expect((error as { paths: string[] }).paths).toEqual(expect.arrayContaining(["one", "two"]));
        }
    });
});
