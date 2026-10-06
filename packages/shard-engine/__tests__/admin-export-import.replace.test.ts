import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importShardRows } from "../src/admin-export-import";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Replace mode makes the import the exact contents of its tables: an `_id` that
 * exists is overwritten, one the import does not carry is deleted, and a table
 * outside `replaceTables` is not touched.
 */
const schema: SchemaLike = {
    tables: {
        notes: { indexes: [], shape: { title: { kind: "string" } } },
        tasks: { indexes: [], shape: { label: { kind: "string" } } },
    },
};

let harness: ReturnType<typeof createSqliteExec>;
let writer: DatabaseWriterLike;

const titles = async (): Promise<Record<string, unknown>> => {
    const { page } = await writer.findMany("notes", {});

    return Object.fromEntries(page.map((row) => [row["_id"], row["title"]]));
};

describe("shard admin import — replace mode", () => {
    beforeEach(async () => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

        await writer.insert("notes", { _id: "kept", title: "edited since" }, { allowExplicitId: true });
        await writer.insert("notes", { _id: "created-since", title: "new" }, { allowExplicitId: true });
        await writer.insert("tasks", { _id: "t1", label: "outside the scope" }, { allowExplicitId: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("overwrites existing rows, deletes rows the import does not carry, and leaves other tables alone", async () => {
        expect.assertions(4);

        const result = await importShardRows(writer, schema, {
            replaceTables: ["notes"],
            rows: [
                { doc: { _creationTime: 1, _id: "kept", title: "as snapshotted" }, table: "notes" },
                { doc: { _creationTime: 2, _id: "deleted-since", title: "back" }, table: "notes" },
            ],
        });

        expect(result).toStrictEqual({ conflicts: 0, deleted: { notes: 1 }, errors: [], inserted: { notes: 2 } });
        await expect(titles()).resolves.toStrictEqual({ "deleted-since": "back", kept: "as snapshotted" });
        // The snapshot's creation time is restored, not the overwritten row's.
        await expect(writer.get("kept")).resolves.toMatchObject({ _creationTime: 1 });
        await expect(writer.get("t1")).resolves.toMatchObject({ label: "outside the scope" });
    });

    it("empties a table in scope that the import holds no rows for", async () => {
        expect.assertions(2);

        const result = await importShardRows(writer, schema, { replaceTables: ["notes"], rows: [] });

        expect(result.deleted).toStrictEqual({ notes: 2 });
        await expect(titles()).resolves.toStrictEqual({});
    });

    it("prunes nothing when a row is refused, so the caller's rollback has nothing to undo but the writes", async () => {
        expect.assertions(3);

        const result = await importShardRows(writer, schema, {
            replaceTables: ["notes"],
            rows: [
                { doc: { _id: "kept", title: "as snapshotted" }, table: "notes" },
                { doc: { title: "no id" }, table: "notes" },
                { doc: { _id: "t2", label: "wrong table" }, table: "tasks" },
            ],
        });

        expect(result.errors.map((error) => [error.line, error.code])).toStrictEqual([
            [2, "BAD_ROW"],
            [3, "BAD_ROW"],
        ]);
        expect(result.deleted).toBeUndefined();
        await expect(titles()).resolves.toMatchObject({ "created-since": "new" });
    });

    it("keeps append mode's skip-on-conflict when no `replaceTables` is given", async () => {
        expect.assertions(2);

        const result = await importShardRows(writer, schema, { rows: [{ doc: { _id: "kept", title: "as snapshotted" }, table: "notes" }] });

        expect(result).toStrictEqual({ conflicts: 1, errors: [], inserted: {} });
        await expect(titles()).resolves.toMatchObject({ kept: "edited since" });
    });
});
