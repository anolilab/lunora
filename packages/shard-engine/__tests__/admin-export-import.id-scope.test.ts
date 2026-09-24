import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importShardRows } from "../src/admin-export-import";
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
