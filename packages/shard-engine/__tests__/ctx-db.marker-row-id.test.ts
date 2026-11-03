import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { TransactionHeadroomTracker } from "../src/transaction-headroom";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A row whose id spells a dependency marker must be charged like any other row. The read
 * meter must not mistake the id for the marker it is named after.
 */
describe("the read meter with a row id that matches a dependency marker", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    const schema: SchemaLike = {
        tables: {
            items: { indexes: [], shape: { label: { kind: "string" } }, shardMode: { kind: "root" } },
        },
    } as never;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(["*primary", "*scan"])("charges every point read of a row whose id is %s", async (rowId) => {
        expect.assertions(1);

        runShardMigrations(harness.sql, schema);

        const tracker = new TransactionHeadroomTracker({ maxReadRows: 1000 });
        const writer = createShardContextDatabase({ clock: () => 1, headroom: tracker, schema, sql: harness.sql });

        await writer.insert("items", { _id: rowId, label: "x" }, { allowExplicitId: true });
        const before = tracker.headroom().readRows;

        await writer.get("items", rowId);
        await writer.get("items", rowId);

        expect(tracker.headroom().readRows - before).toBe(2);
    });
});
