/**
 * Regression: only the TOP-LEVEL `lunora/schema.ts` (loaded separately by
 * discoverSchema) is skipped by the source walker. A nested feature-folder file
 * like `lunora/admin/schema.ts` that exports query/mutation registrations was
 * silently dropped at every depth by the old `entry !== "schema.ts"` filter,
 * producing a runtime FUNCTION_NOT_FOUND with no codegen-time signal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverFunctions } from "../src/discover-functions";

let workdir: string;

describe("nested schema.ts discovery", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-nested-schema-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const writeFile = (relative: string, source: string): void => {
        const full = join(workdir, relative);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, source);
    };

    it("discovers registrations in a nested schema.ts while skipping the top-level one", () => {
        expect.assertions(3);

        // Top-level schema.ts — must NOT be walked for functions (discoverSchema owns it).
        writeFile(
            "schema.ts",
            `
            import { defineSchema, defineTable, v } from "@lunora/server";
            export const schema = defineSchema({ users: defineTable({ name: v.string() }) });
        `,
        );

        // Nested feature-folder schema.ts — an ordinary source file with a registration.
        writeFile(
            "admin/schema.ts",
            `
            import { query } from "@lunora/server";
            export const list = query({ args: {}, handler: () => null });
        `,
        );

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        const result = discoverFunctions(project, workdir);

        // The nested registration is discovered under its folder namespace…
        expect(result).toHaveLength(1);
        expect(result[0]?.exportName).toBe("list");
        expect(result[0]?.filePath).toBe("admin/schema");
    });
});
