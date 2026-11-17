import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/** Twenty-five required columns: one seek over all of them fits a statement, two do not. */
const FIELDS = Array.from({ length: 25 }, (_, index) => `f${String(index).padStart(2, "0")}`);

const schema: SchemaLike = {
    tables: { wide: { indexes: [], shape: Object.fromEntries(FIELDS.map((field) => [field, { kind: "number" }])) } },
};

describe("findMany with endCursor over a wide orderBy", () => {
    it("refuses an ordering whose two seeks overflow a statement's parameters, with a reason, but pages it open-ended", async () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            runShardMigrations(harness.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            for (let row = 0; row < 3; row += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the fixture deterministic
                await writer.insert("wide", Object.fromEntries(FIELDS.map((field) => [field, row])));
            }

            const orderBy = FIELDS.map((field) => {
                return { [field]: "asc" as const };
            });
            const first = await writer.findMany("wide", { limit: 1, orderBy });
            const second = await writer.findMany("wide", { cursor: first.continueCursor, limit: 1, orderBy });

            expect(second.page).toHaveLength(1);
            await expect(writer.findMany("wide", { cursor: first.continueCursor, endCursor: second.continueCursor, orderBy })).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: expect.stringContaining("order by fewer fields"),
            });
        } finally {
            harness.close();
        }
    });
});
