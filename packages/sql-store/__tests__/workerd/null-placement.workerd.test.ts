/**
 * `orderBy: [{ score: { sort, nulls } }]` on a `.global()` table, paged through the keyset cursor
 * against a **real** D1 binding in workerd.
 *
 * D1 is SQLite behind an authorizer, so whether it accepts `NULLS FIRST/LAST` is a question for D1
 * itself, and the cursor seek only works if the ORDER BY it pairs with really puts NULLs where the
 * seek expects. Each test owns a table name: D1 storage is shared across the tests in this file.
 */
import { describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../../src/ctx-db";
import { COMBOS, expected, labelsOf, nullPlacementSchema, pagedLabels, ROWS } from "../_helpers/null-placement";
import { d1Dialect, d1Exec } from "./_helpers/d1";

describe("orderBy null placement on D1", () => {
    it("orders and pages every direction and placement exactly like the reference", async () => {
        expect.assertions(8);

        const table = "null_placement_items";
        let now = 1_700_000_000_000;
        const writer = createSqlCtxDb({
            clock: () => {
                now += 1000;

                return now;
            },
            dialect: d1Dialect,
            exec: d1Exec,
            schema: nullPlacementSchema(table),
        });

        for (const [label, score] of ROWS) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in input order
            await writer.insert(table, score === null ? { label } : { label, score });
        }

        for (const combo of COMBOS) {
            // eslint-disable-next-line no-await-in-loop -- one ordering at a time
            const all = await writer.findMany(table, { orderBy: [{ score: combo }] });
            // eslint-disable-next-line no-await-in-loop -- one ordering at a time
            const paged = await pagedLabels((cursor) => writer.findMany(table, { cursor, limit: 2, orderBy: [{ score: combo }] }));

            expect(labelsOf(all.page)).toStrictEqual(expected(combo));
            expect(paged).toStrictEqual(expected(combo));
        }
    });
});
