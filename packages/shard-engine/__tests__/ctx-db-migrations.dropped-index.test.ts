import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Removing an index declaration must remove the SQLite index it created.
 * `CREATE INDEX IF NOT EXISTS` only ever adds, so a `.unique()` that was taken
 * off a column kept rejecting duplicates (as `ConflictError`) for good, and an
 * index dropped from a table's declarations kept costing every write.
 */
const table = (shape: Record<string, unknown>, indexes: { fields: string[]; name: string; unique?: boolean }[] = []): SchemaLike =>
    ({ tables: { notes: { indexes, shape } } }) as SchemaLike;

const uniqueColumn = table({ slug: { _meta: { column: { unique: true } }, kind: "string" } });
const plainColumn = table({ slug: { kind: "string" } });
const withIndex = (unique: boolean): SchemaLike => table({ slug: { kind: "string" } }, [{ fields: ["slug"], name: "by_slug", unique }]);

let harness: ReturnType<typeof createSqliteExec>;

const indexNames = (): string[] =>
    harness
        .raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL ORDER BY name`)
        .map((row) => String(row["name"]));

describe("runShardMigrations — an index that is no longer declared", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops the unique index when `.unique()` is removed from a column", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, uniqueColumn);

        expect(indexNames()).toContain("notes_unique_slug");

        runShardMigrations(harness.sql, plainColumn);

        expect(indexNames()).not.toContain("notes_unique_slug");

        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: plainColumn, sql: harness.sql });

        await writer.insert("notes", { slug: "dup" });

        await expect(writer.insert("notes", { slug: "dup" })).resolves.toBeTypeOf("string");
    });

    it("drops a declared index that is removed from the table", () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, withIndex(true));

        expect(indexNames()).toContain("notes_by_slug");

        runShardMigrations(harness.sql, plainColumn);

        expect(indexNames()).not.toContain("notes_by_slug");
    });

    it("keeps the indexes that are still declared, and ones the framework did not create", () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, withIndex(false));
        harness.raw(`CREATE INDEX "notes_by_hand" ON "notes" ("_creationTime")`);
        runShardMigrations(harness.sql, withIndex(false));

        expect(indexNames()).toContain("notes_by_slug");
        expect(indexNames()).toContain("notes_by_hand");
        expect(indexNames()).toContain("notes__by_creation");
    });
});

describe("runShardMigrations — an index whose name starts with an underscore", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops a declared `_x` index when it is removed, and stops enforcing it", async () => {
        expect.assertions(3);

        const underscored = table({ slug: { kind: "string" } }, [{ fields: ["slug"], name: "_x", unique: true }]);

        runShardMigrations(harness.sql, underscored);

        expect(indexNames()).toContain("notes__x");

        runShardMigrations(harness.sql, plainColumn);

        expect(indexNames()).not.toContain("notes__x");

        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: plainColumn, sql: harness.sql });

        await writer.insert("notes", { slug: "dup" });

        await expect(writer.insert("notes", { slug: "dup" })).resolves.toBeTypeOf("string");
    });
});

/**
 * SQLite folds ASCII case in an identifier, so `By_Slug` and `by_slug` are ONE index name: the `CREATE ... IF NOT EXISTS`
 * for the new spelling finds the old index and does nothing. Dropping "the old name" as undeclared then removed the only
 * index the table had.
 */
describe("runShardMigrations — an index renamed to a name that differs only in case", () => {
    const shape = { body: { kind: "string" }, slug: { kind: "string" } };
    const declared = (name: string, fields: string[]): SchemaLike => table(shape, [{ fields, name, unique: true }]);

    const insertTwice = async (schema: SchemaLike, document: Record<string, unknown>): Promise<unknown> => {
        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

        await writer.insert("notes", document);

        return writer.insert("notes", document);
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps the index, and the constraint it enforces", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, declared("by_slug", ["slug"]));
        runShardMigrations(harness.sql, declared("By_Slug", ["slug"]));

        expect(indexNames().filter((name) => name.toLowerCase() === "notes_by_slug")).toHaveLength(1);
        await expect(insertTwice(declared("By_Slug", ["slug"]), { body: "b", slug: "dup" })).rejects.toThrow(/unique|conflict/iu);
    });

    it("rebuilds it to the new definition when the columns changed too", () => {
        expect.assertions(1);

        runShardMigrations(harness.sql, declared("by_slug", ["slug"]));
        runShardMigrations(harness.sql, declared("BY_SLUG", ["slug", "body"]));

        const [held] = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'notes_by_slug' COLLATE NOCASE`);

        expect(String(held?.["sql"])).toContain("$.body");
    });

    it("enforces a `.unique()` that moved to a field differing only in case", async () => {
        expect.assertions(1);

        const column = (name: string): SchemaLike => table({ [name]: { _meta: { column: { unique: true } }, kind: "string" } });

        runShardMigrations(harness.sql, column("slug"));
        runShardMigrations(harness.sql, column("Slug"));

        await expect(insertTwice(column("Slug"), { Slug: "dup" })).rejects.toThrow(/unique|conflict/iu);
    });
});
