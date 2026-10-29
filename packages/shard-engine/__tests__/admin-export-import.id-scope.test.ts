import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importShardRows, parseImportShardArgs } from "../src/admin-export-import";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Append-mode import skips a row whose `_id` is already taken. "Already taken"
 * has to mean "in the row's own table": the probe reached every table, so an id
 * that happened to exist anywhere in the shard silently consumed the inbound row
 * and reported it as a conflict the caller could not distinguish from a real one.
 */
const schema: SchemaLike = {
    tables: {
        notes: { indexes: [], shape: { title: { kind: "string" } } },
        tasks: { indexes: [], shape: { label: { kind: "string" } } },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const writerFor = (source: ReturnType<typeof createSqliteExec>): DatabaseWriterLike => {
    runShardMigrations(source.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: source.sql });
};

describe("shard admin import — `_id` conflict probe", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("inserts a row whose `_id` is free in its own table", async () => {
        expect.assertions(3);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "shared-1", title: "taken over here" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "fresh-1", label: "todo" }, table: "tasks" }] });

        expect(result.errors).toStrictEqual([]);
        expect(result.conflicts).toBe(0);
        expect(result.inserted).toStrictEqual({ tasks: 1 });
    });

    it("counts a same-table `_id` collision as a conflict", async () => {
        expect.assertions(3);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "n1", title: "original" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "n1", title: "incoming" }, table: "notes" }] });

        expect(result.errors).toStrictEqual([]);
        expect(result.conflicts).toBe(1);
        expect(result.inserted).toStrictEqual({});
    });

    it('removes the row an `op: "delete"` row names, hard, and removes nothing on a re-run', async () => {
        expect.assertions(4);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "n1", title: "stale" }, { allowExplicitId: true });
        await writer.insert("notes", { _id: "n2", title: "kept" }, { allowExplicitId: true });

        const prune = async (): Promise<Awaited<ReturnType<typeof importShardRows>>> =>
            importShardRows(writer, schema, { rows: [{ doc: { _id: "n1", title: "stale" }, op: "delete", table: "notes" }] });

        await expect(prune()).resolves.toStrictEqual({ conflicts: 0, deleted: 1, errors: [], inserted: {}, replaced: 0 });
        await expect(writer.get("notes", "n1")).resolves.toBeNull();
        await expect(writer.get("notes", "n2")).resolves.toMatchObject({ title: "kept" });
        await expect(prune()).resolves.toStrictEqual({ conflicts: 0, deleted: 0, errors: [], inserted: {}, replaced: 0 });
    });

    it("refuses a delete row whose `_id` belongs to another table, and keeps that row", async () => {
        expect.assertions(2);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "shared-1", title: "not a task" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "shared-1" }, op: "delete", table: "tasks" }] });

        expect(result.errors).toStrictEqual([
            { code: "ID_COLLISION", line: 1, message: '_id "shared-1" belongs to table "notes", not "tasks"', table: "tasks" },
        ]);
        await expect(writer.get("notes", "shared-1")).resolves.toMatchObject({ title: "not a task" });
    });

    it("prunes a delete row without the schema's onDelete cascade, so tables the import never names keep their rows", async () => {
        expect.assertions(3);

        const related: SchemaLike = {
            tables: {
                notes: { indexes: [], shape: { title: { kind: "string" } } },
                tasks: {
                    indexes: [],
                    relationMap: { note: { field: "noteId", kind: "one", onDelete: "cascade", references: "_id", table: "notes" } },
                    shape: { label: { kind: "string" }, noteId: { kind: "string" } },
                },
            },
        };

        runShardMigrations(harness.sql, related);

        const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: related, sql: harness.sql });

        await writer.insert("notes", { _id: "n1", title: "stale" }, { allowExplicitId: true });
        await writer.insert("tasks", { _id: "t1", label: "kept", noteId: "n1" }, { allowExplicitId: true });

        const result = await importShardRows(writer, related, { rows: [{ doc: { _id: "n1" }, op: "delete", table: "notes" }] });

        expect(result).toMatchObject({ deleted: 1, errors: [] });
        await expect(writer.get("notes", "n1")).resolves.toBeNull();
        await expect(writer.get("tasks", "t1")).resolves.toMatchObject({ label: "kept" });
    });

    it('refuses a direct shard import row whose `op` is not "delete", and writes nothing for it', async () => {
        expect.assertions(2);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "n1", title: "stored" }, { allowExplicitId: true });

        const result = await importShardRows(
            writer,
            schema,
            parseImportShardArgs({ rows: [{ doc: { _id: "n2", title: "typo" }, op: "deleet", table: "notes" }] }),
        );

        expect(result.errors).toStrictEqual([{ code: "BAD_ROW", line: 1, message: 'row `op` must be "delete" when set, got "deleet"', table: "notes" }]);
        await expect(writer.get("notes", "n2")).resolves.toBeNull();
    });

    it("reports a delete whose ownership probe fails as an error, never as an absent row", async () => {
        expect.assertions(2);

        const base = writerFor(harness);

        await base.insert("notes", { _id: "n1", title: "stored" }, { allowExplicitId: true });

        const writer: DatabaseWriterLike = {
            ...base,
            lookupById: async () => {
                throw new Error("storage unavailable");
            },
        };
        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "n1" }, op: "delete", table: "notes" }] });

        expect(result.errors).toHaveLength(1);
        await expect(base.get("notes", "n1")).resolves.toMatchObject({ title: "stored" });
    });

    it('overwrites a same-table `_id` under onConflict: "replace", keeping the row\'s `_creationTime`', async () => {
        expect.assertions(2);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "n1", title: "original" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, {
            onConflict: "replace",
            rows: [{ doc: { _creationTime: 42, _id: "n1", title: "incoming" }, table: "notes" }],
        });

        expect(result).toStrictEqual({ conflicts: 0, deleted: 0, errors: [], inserted: {}, replaced: 1 });
        await expect(writer.get("notes", "n1")).resolves.toMatchObject({ _creationTime: 42, title: "incoming" });
    });

    it('still refuses a cross-table `_id` under onConflict: "replace"', async () => {
        expect.assertions(2);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "shared-1", title: "taken over here" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, { onConflict: "replace", rows: [{ doc: { _id: "shared-1", label: "todo" }, table: "tasks" }] });

        expect(result.replaced).toBe(0);
        expect(result.errors).toStrictEqual([expect.objectContaining({ code: "ID_COLLISION" })]);
    });

    it("reports a cross-table `_id` collision per row instead of skipping it silently", async () => {
        expect.assertions(3);

        const writer = writerFor(harness);

        await writer.insert("notes", { _id: "shared-1", title: "taken over here" }, { allowExplicitId: true });

        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "shared-1", label: "todo" }, table: "tasks" }] });

        expect(result.conflicts).toBe(0);
        expect(result.inserted).toStrictEqual({});
        expect(result.errors).toStrictEqual([expect.objectContaining({ code: "ID_COLLISION", line: 1, table: "tasks" })]);
    });
});
