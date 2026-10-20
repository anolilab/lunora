import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Which indexes a migration may drop is decided by a persisted ledger of the indexes the framework created, not by the
 * shape of their name and SQL. An index added by hand is never in it, however closely it resembles one of ours.
 */
const LEDGER = "__lunora_framework_indexes";

const table = (name: string, shape: Record<string, unknown>, indexes: { fields: string[]; name: string; unique?: boolean }[] = []): SchemaLike =>
    ({ tables: { [name]: { indexes, shape } } }) as SchemaLike;

const plain = table("notes", { slug: { kind: "string" } });
const withIndex = (unique: boolean): SchemaLike => table("notes", { slug: { kind: "string" } }, [{ fields: ["slug"], name: "by_slug", unique }]);

let harness: ReturnType<typeof createSqliteExec>;

const indexNames = (tableName = "notes"): string[] =>
    harness
        .raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}' COLLATE NOCASE AND sql IS NOT NULL ORDER BY name`)
        .map((row) => String(row["name"]));

const writerFor = (schema: SchemaLike) => createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

describe("runShardMigrations — framework index ownership", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps a hand-created expression index even when it is named and shaped like a framework one", () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, withIndex(false));
        harness.raw(`CREATE INDEX "notes_by_hand" ON "notes" (json_extract("__doc__", '$.slug'))`);
        runShardMigrations(harness.sql, plain);

        expect(indexNames()).toContain("notes_by_hand");
        expect(indexNames()).not.toContain("notes_by_slug");
        expect(harness.raw(`SELECT name FROM "${LEDGER}"`).map((row) => row["name"])).not.toContain("notes_by_hand");
    });

    it("records the indexes it creates and forgets one it drops", () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, withIndex(false));

        expect(harness.raw(`SELECT name, table_name FROM "${LEDGER}"`)).toEqual([{ name: "notes_by_slug", table_name: "notes" }]);

        runShardMigrations(harness.sql, plain);

        expect(harness.raw(`SELECT name FROM "${LEDGER}"`)).toStrictEqual([]);
    });

    it("drops a stale framework index on the first migration of a database that predates the ledger", () => {
        expect.assertions(4);

        runShardMigrations(harness.sql, withIndex(false));
        harness.raw(`DROP TABLE IF EXISTS "${LEDGER}"`);
        runShardMigrations(harness.sql, plain);

        expect(indexNames()).not.toContain("notes_by_slug");
        expect(indexNames()).toContain("notes__by_creation");

        // From then on only the ledger decides: a hand-made lookalike survives the next pass.
        harness.raw(`CREATE INDEX "notes_by_hand" ON "notes" (json_extract("__doc__", '$.slug'))`);
        runShardMigrations(harness.sql, plain);

        expect(indexNames()).toContain("notes_by_hand");
        expect(harness.raw(`SELECT 1 FROM sqlite_master WHERE name = '${LEDGER}'`)).toHaveLength(1);
    });

    it("rebuilds a unique index that gained a column after the table name changed only in case", async () => {
        expect.assertions(2);

        const shape = { body: { kind: "string" }, slug: { kind: "string" } };

        runShardMigrations(harness.sql, table("notes", shape, [{ fields: ["slug"], name: "by_slug", unique: true }]));
        runShardMigrations(harness.sql, table("Notes", shape, [{ fields: ["slug", "body"], name: "by_slug", unique: true }]));

        const writer = writerFor(table("Notes", shape, [{ fields: ["slug", "body"], name: "by_slug", unique: true }]));

        await writer.insert("Notes", { body: "one", slug: "dup" });

        // Unique over (slug, body) now: the same slug with another body is fine.
        await expect(writer.insert("Notes", { body: "two", slug: "dup" })).resolves.toBeTypeOf("string");
        await expect(writer.insert("Notes", { body: "two", slug: "dup" })).rejects.toThrow(/unique|conflict/iu);
    });

    it("drops a unique index declared on `_creationTime` once the declaration is removed", async () => {
        expect.assertions(3);

        const unique = table("notes", { slug: { kind: "string" } }, [{ fields: ["_creationTime"], name: "by_time", unique: true }]);

        runShardMigrations(harness.sql, unique);

        await writerFor(unique).insert("notes", { slug: "a" });

        await expect(writerFor(unique).insert("notes", { slug: "b" })).rejects.toThrow(/unique|conflict/iu);

        runShardMigrations(harness.sql, plain);

        expect(indexNames()).not.toContain("notes_by_time");
        await expect(writerFor(plain).insert("notes", { slug: "c" })).resolves.toBeTypeOf("string");
    });

    it("treats an index renamed from `ä` to `Ä` as a rename, since SQLite folds ASCII case only", () => {
        expect.assertions(2);

        const named = (name: string): SchemaLike => table("notes", { slug: { kind: "string" } }, [{ fields: ["slug"], name, unique: false }]);

        runShardMigrations(harness.sql, named("by_ä"));
        runShardMigrations(harness.sql, named("by_Ä"));

        expect(indexNames()).toContain("notes_by_Ä");
        expect(indexNames()).not.toContain("notes_by_ä");
    });

    it("drops a unique index after the table name changed only in case", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, table("notes", { slug: { _meta: { column: { unique: true } }, kind: "string" } }));
        runShardMigrations(harness.sql, table("Notes", { slug: { kind: "string" } }));

        expect(indexNames("notes").filter((name) => name.endsWith("_unique_slug"))).toStrictEqual([]);

        const writer = writerFor(table("Notes", { slug: { kind: "string" } }));

        await writer.insert("Notes", { slug: "dup" });

        await expect(writer.insert("Notes", { slug: "dup" })).resolves.toBeTypeOf("string");
    });
});
