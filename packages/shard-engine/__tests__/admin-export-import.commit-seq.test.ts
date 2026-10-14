import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportShardRows, importShardRows } from "../src/admin-export-import";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `.commitOrdered()` injects a `_commitSeq` system field into the stored
 * document. It is neither a framework field the importer re-applies nor a column
 * declared in `defineTable`, so an exported row carrying it failed the importer's
 * "unexpected field" check — every row of a commit-ordered table was rejected on
 * restore, while the request still returned 200 with an `errors` array.
 */
const schema: SchemaLike = {
    tables: {
        events: {
            commitOrderedMode: true,
            indexes: [],
            shape: { kind: { kind: "string" } },
        },
    },
};

let source: ReturnType<typeof createSqliteExec>;
let target: ReturnType<typeof createSqliteExec>;

const writerFor = (harness: ReturnType<typeof createSqliteExec>): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

describe("shard admin export/import — commit-ordered tables", () => {
    beforeEach(() => {
        source = createSqliteExec();
        target = createSqliteExec();
    });

    afterEach(() => {
        source.close();
        target.close();
    });

    it("restores every row of a `.commitOrdered()` table", async () => {
        expect.assertions(4);

        const writer = writerFor(source);

        await writer.insert("events", { _id: "e1", kind: "created" }, { allowExplicitId: true });
        await writer.insert("events", { _id: "e2", kind: "updated" }, { allowExplicitId: true });

        const rows: { doc: Record<string, unknown>; table: string }[] = [];

        for await (const row of exportShardRows(writer, schema, {})) {
            rows.push(row);
        }

        // The field really is on the wire — this test is worthless if the export
        // ever stops emitting it.
        expect(rows[0]?.doc).toHaveProperty("_commitSeq");

        const restored = writerFor(target);
        const result = await importShardRows(restored, schema, { rows });

        expect(result.errors).toStrictEqual([]);
        expect(result.inserted).toStrictEqual({ events: 2 });

        // Re-minted from the TARGET shard's own counter, not replayed: the
        // sequence is per-shard, and `_commitSeq > cursor` changefeed reads
        // depend on it being monotonic there.
        const reloaded = await restored.get("e1");

        expect(typeof reloaded?.["_commitSeq"]).toBe("number");
    });
});
