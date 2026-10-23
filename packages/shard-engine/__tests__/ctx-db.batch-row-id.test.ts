import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

/**
 * A column-level server default on `_id` replaces the id a supplied `_id` would have
 * been stored under. The batch preflight must check the id that is stored, as the
 * single-row insert does, so a valid stored id is not refused for an invalid input id.
 */
const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                _id: col("string", { serverDefault: () => "stored-id" }),
                title: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

describe("insertManyUnsafe checks the id each row is stored under", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
    });

    afterEach(() => {
        harness.close();
    });

    it("accepts a batch whose supplied id is refused in favour of a valid server-defaulted id", async () => {
        expect.assertions(1);

        const writer = createShardCtxDb({ clock: () => 1, schema, sql: harness.sql });

        const ids = await writer.insertManyUnsafe!("notes", [{ _id: "bad\u0000id", title: "hi" }], { allowExplicitId: true });

        expect(ids).toStrictEqual(["stored-id"]);
    });
});
