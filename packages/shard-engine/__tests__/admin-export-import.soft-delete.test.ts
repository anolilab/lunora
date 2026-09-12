import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportShardRows, importShardRows } from "../src/admin-export-import";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A `.softDelete()` row is a tombstone, not an absent row: `restore()` brings it
 * back, and a changefeed consumer reads it as the event that the row went away.
 * The export walks tables with the same list read a user query uses, whose
 * default scope hides tombstones — so a snapshot dropped every one of them and a
 * restored deployment had nothing left to `restore()`.
 */
const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { deletedAt: { kind: "optional" }, title: { kind: "string" } },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let source: ReturnType<typeof createSqliteExec>;
let target: ReturnType<typeof createSqliteExec>;

const writerFor = (harness: ReturnType<typeof createSqliteExec>): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

describe("shard admin export/import — soft-deleted rows", () => {
    beforeEach(() => {
        source = createSqliteExec();
        target = createSqliteExec();
    });

    afterEach(() => {
        source.close();
        target.close();
    });

    it("exports tombstones and round-trips them as restorable rows", async () => {
        expect.assertions(5);

        const writer = writerFor(source);

        await writer.insert("notes", { _id: "n1", title: "live" }, { allowExplicitId: true });
        await writer.insert("notes", { _id: "n2", title: "gone" }, { allowExplicitId: true });
        await writer.delete("n2", "notes");

        const rows: { doc: Record<string, unknown>; table: string }[] = [];

        for await (const row of exportShardRows(writer, schema, {})) {
            rows.push(row);
        }

        expect(rows.map((row) => String(row.doc["_id"])).toSorted((a, b) => (a < b ? -1 : Number(a > b)))).toStrictEqual(["n1", "n2"]);
        expect(rows.find((row) => row.doc["_id"] === "n2")?.doc["deletedAt"]).toBe(1_700_000_000_000);

        const restored = writerFor(target);
        const result = await importShardRows(restored, schema, { rows });

        expect(result.errors).toStrictEqual([]);
        expect(result.inserted).toStrictEqual({ notes: 2 });

        // The tombstone survived as a tombstone — so `restore()` still has
        // something to bring back on the restored deployment.
        await restored.restore?.("n2", "notes");

        const reloaded = await restored.get("n2", "notes");

        expect(reloaded?.["deletedAt"]).toBeNull();
    });
});
