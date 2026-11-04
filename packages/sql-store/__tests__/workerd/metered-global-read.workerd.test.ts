/**
 * An unlimited global `findMany` through the engine's byte meter, against a **real** D1 binding in
 * workerd: the pages are real keyset statements with tied order keys, and the read cap must stop
 * the read at the page that crosses it. Each test owns a table name: D1 storage is shared across
 * the tests in this file.
 */
import { describe, expect, it } from "vitest";

import { openMeteredRead, ROW_COUNT } from "../_helpers/metered-global-read";
import { d1Dialect, d1Exec } from "./_helpers/d1";

describe("an unlimited global findMany under the read meter on D1", () => {
    it("returns every row in the order an unpaged read gives, with none repeated or skipped across tied pages", async () => {
        expect.assertions(4);

        const { selects, store, writer } = await openMeteredRead({ dialect: d1Dialect, exec: d1Exec, table: "metered_read_all" });
        const orderBy = [{ bucket: "asc" as const }];
        const reference = await store.findMany("metered_read_all", { orderBy });
        const metered = await writer.findMany("metered_read_all", { orderBy });
        const ids = metered.page.map((row) => row["_id"]);

        expect(ids).toStrictEqual(reference.page.map((row) => row["_id"]));
        expect(new Set(ids).size).toBe(ROW_COUNT);
        expect(metered).toMatchObject({ continueCursor: null, isDone: true });
        expect(selects()).toBeGreaterThan(1);
    });

    it("stops at the page that crosses the read cap instead of loading the table", async () => {
        expect.assertions(3);

        const { fetchedRows, selects, writer } = await openMeteredRead({ capRows: 300, dialect: d1Dialect, exec: d1Exec, table: "metered_read_capped" });

        await expect(writer.findMany("metered_read_capped", { orderBy: [{ bucket: "asc" }] })).rejects.toMatchObject({ code: "TRANSACTION_LIMIT_EXCEEDED" });

        expect(selects()).toBe(2);
        expect(fetchedRows()).toBeLessThan(ROW_COUNT);
    });
});
