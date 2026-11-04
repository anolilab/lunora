import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeteredRead, ROW_COUNT } from "./_helpers/metered-global-read";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * An unlimited global `findMany` through the engine's byte meter, over `node:sqlite`. The workerd
 * twin, against a real D1 binding, is `workerd/metered-global-read.workerd.test.ts`.
 */
describe("an unlimited global findMany under the read meter", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const open = async (capRows?: number) => openMeteredRead({ capRows, dialect: makeSqliteDialect(), exec: harness.exec, table: "items" });

    it("returns every row in the order an unpaged read gives, with none repeated or skipped across tied pages", async () => {
        expect.assertions(4);

        const { selects, store, writer } = await open();
        const orderBy = [{ bucket: "asc" as const }];
        const reference = await store.findMany("items", { orderBy });
        const metered = await writer.findMany("items", { orderBy });
        const ids = metered.page.map((row) => row["_id"]);

        expect(ids).toStrictEqual(reference.page.map((row) => row["_id"]));
        expect(new Set(ids).size).toBe(ROW_COUNT);
        expect(metered).toMatchObject({ continueCursor: null, isDone: true });
        expect(selects()).toBeGreaterThan(1);
    });

    it("stops at the page that crosses the read cap instead of loading the table", async () => {
        expect.assertions(3);

        const { fetchedRows, selects, writer } = await open(300);

        await expect(writer.findMany("items", { orderBy: [{ bucket: "asc" }] })).rejects.toMatchObject({ code: "TRANSACTION_LIMIT_EXCEEDED" });

        expect(selects()).toBe(2);
        expect(fetchedRows()).toBeLessThan(ROW_COUNT);
    });

    // Every page of a fixed range answers `isDone: true`, so walked like an unlimited read it stopped
    // at the walk's first 256 rows and dropped its `continueCursor` and `splitCursor`.
    it("reads a bounded (endCursor) range in one statement, whole, with its cursors", async () => {
        expect.assertions(4);

        const { selects, store, writer } = await open();
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany("items", { limit: 600, orderBy });
        const bounded = await writer.findMany("items", { endCursor: head.continueCursor, orderBy, select: ["label"] });

        expect(bounded.page.map((row) => row["_id"])).toStrictEqual(head.page.map((row) => row["_id"]));
        expect(bounded).toMatchObject({ continueCursor: head.continueCursor, isDone: true });
        expect(typeof bounded.splitCursor).toBe("string");
        expect(selects()).toBe(1);
    });

    // Without a `limit` a bounded range is capped at one page (4096 rows) rather than read whole
    // before the meter sees it; the capped page's splitCursor lets the client recover the rest.
    it("caps a bounded range with no limit at one page, split inside what it returned", async () => {
        expect.assertions(4);

        const { selects, store, writer } = await open();
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany("items", { limit: 5000, orderBy });
        const ids = head.page.map((row) => row["_id"]);
        const capped = await writer.findMany("items", { endCursor: head.continueCursor, orderBy });

        expect(capped.page.map((row) => row["_id"])).toStrictEqual(ids.slice(0, 4096));
        expect(capped).toMatchObject({ continueCursor: head.continueCursor, isDone: true });

        const rest = await writer.findMany("items", { cursor: capped.splitCursor, endCursor: head.continueCursor, orderBy });

        expect(rest.page.map((row) => row["_id"])).toStrictEqual(ids.slice(2048));
        expect(selects()).toBe(2);
    });

    it("charges a bounded range against the read cap", async () => {
        expect.assertions(1);

        const { store, writer } = await open(300);
        const orderBy = [{ bucket: "asc" as const }];
        const head = await store.findMany("items", { limit: 600, orderBy });

        await expect(writer.findMany("items", { endCursor: head.continueCursor, orderBy })).rejects.toMatchObject({ code: "TRANSACTION_LIMIT_EXCEEDED" });
    });
});
