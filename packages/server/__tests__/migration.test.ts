import { describe, expect, it } from "vitest";

import type { MigrationCtx } from "../src/migration";
import { defineMigration } from "../src/migration";

/**
 * A transform receives a shard-scoped reader alongside the row. These tests
 * exercise the declaration shape, not a cross-table read, so the reader is never
 * touched — but the runner always supplies one, so the call sites do too.
 */
const NO_READS = { db: {} } as unknown as MigrationCtx;

/**
 * `defineMigration` is a thin shape constructor: it brands the declaration with
 * `__lunoraMigration` (so codegen discovers it through the type checker) and
 * rejects a blank `id` at module load (run-state is tracked under that id, so a
 * blank one would collide across migrations).
 */
describe("defineMigration", () => {
    it("brands the declaration and preserves every field", () => {
        expect.assertions(5);

        const up = (document: Record<string, unknown>): Record<string, unknown> => {
            return { ...document, migrated: true };
        };
        const down = (document: Record<string, unknown>): Record<string, unknown> => document;

        const migration = defineMigration({ batchSize: 100, down, id: "add-migrated-flag", table: "documents", up });

        expect((migration as unknown as Record<string, unknown>)["__lunoraMigration"]).toBe(true);
        expect(migration.id).toBe("add-migrated-flag");
        expect(migration.table).toBe("documents");
        expect(migration.batchSize).toBe(100);
        expect(migration.up({ _id: "d1" }, NO_READS)).toStrictEqual({ _id: "d1", migrated: true });
    });

    it("keeps optional fields absent when not supplied", () => {
        expect.assertions(2);

        const migration = defineMigration({ id: "noop", table: "t", up: () => undefined });

        expect(migration.down).toBeUndefined();
        expect(migration.batchSize).toBeUndefined();
    });

    it("throws when the id is empty", () => {
        expect.assertions(1);

        expect(() => defineMigration({ id: "", table: "t", up: () => undefined })).toThrow("`id` must be a non-empty string");
    });

    it("throws when the id is whitespace only", () => {
        expect.assertions(1);

        expect(() => defineMigration({ id: "   ", table: "t", up: () => undefined })).toThrow("`id` must be a non-empty string");
    });
});
