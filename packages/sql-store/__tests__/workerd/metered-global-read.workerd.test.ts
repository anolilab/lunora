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

    it("reads a bounded (endCursor) range in one statement, whole, with its cursors", async () => {
        expect.assertions(4);

        const table = "metered_read_bounded";
        const { selects, store, writer } = await openMeteredRead({ dialect: d1Dialect, exec: d1Exec, table });
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany(table, { limit: 600, orderBy });
        const bounded = await writer.findMany(table, { endCursor: head.continueCursor, orderBy, select: ["label"] });

        expect(bounded.page.map((row) => row["_id"])).toStrictEqual(head.page.map((row) => row["_id"]));
        expect(bounded).toMatchObject({ continueCursor: head.continueCursor, isDone: true });
        expect(typeof bounded.splitCursor).toBe("string");
        expect(selects()).toBe(1);
    });

    // Without a `limit` a bounded range is capped at one page (4096 rows) rather than read whole
    // before the meter sees it; the capped page's splitCursor lets the client recover the rest.
    it("caps a bounded range with no limit at one page, split inside what it returned", async () => {
        expect.assertions(4);

        const table = "metered_read_bounded_wide";
        const { selects, store, writer } = await openMeteredRead({ dialect: d1Dialect, exec: d1Exec, table });
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany(table, { limit: 5000, orderBy });
        const ids = head.page.map((row) => row["_id"]);
        const capped = await writer.findMany(table, { endCursor: head.continueCursor, orderBy });

        expect(capped.page.map((row) => row["_id"])).toStrictEqual(ids.slice(0, 4096));
        expect(capped).toMatchObject({ continueCursor: head.continueCursor, isDone: true, splitRequired: true });

        const rest = await writer.findMany(table, { cursor: capped.splitCursor, endCursor: head.continueCursor, orderBy });

        expect(rest.page.map((row) => row["_id"])).toStrictEqual(ids.slice(2048));
        expect(selects()).toBe(2);
    });

    it("charges a bounded range against the read cap", async () => {
        expect.assertions(1);

        const table = "metered_read_bounded_capped";
        const { store, writer } = await openMeteredRead({ capRows: 300, dialect: d1Dialect, exec: d1Exec, table });
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany(table, { limit: 600, orderBy });

        await expect(writer.findMany(table, { endCursor: head.continueCursor, orderBy })).rejects.toMatchObject({ code: "TRANSACTION_LIMIT_EXCEEDED" });
    });
});
