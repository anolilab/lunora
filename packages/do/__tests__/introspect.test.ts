import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listTables, readTablePage } from "../src/introspect.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

describe("introspect", () => {
    let db: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        db = createSqliteExec();

        db.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT, "votes" INTEGER)`);
        db.raw(`CREATE TABLE "users" ("__id__" TEXT PRIMARY KEY, "name" TEXT)`);
        // Internal / shadow tables that must never surface in the data browser.
        // The FTS5 virtual table and its shadow siblings all carry the reserved
        // `__fts_` infix; we model them as plain tables of the same name because
        // this Node build's `node:sqlite` ships without the fts5 module, and the
        // exclusion filter keys off the name alone.
        db.raw(`CREATE TABLE "_cf_KV" ("k" TEXT, "v" BLOB)`);
        db.raw(`CREATE TABLE "messages__fts_body" ("__text__" TEXT, "__id__" TEXT)`);
        db.raw(`CREATE TABLE "messages__fts_body_data" ("id" INTEGER, "block" BLOB)`);

        db.raw(`INSERT INTO "messages" VALUES ('m1', 'hello', 3), ('m2', 'world', 1), ('m3', 'again', 0)`);
        db.raw(`INSERT INTO "users" VALUES ('u1', 'ada')`);
    });

    afterEach(() => {
        db.close();
    });

    describe("listTables", () => {
        test("returns user tables with row counts, sorted, excluding internal and FTS tables", () => {
            expect(listTables(db.sql)).toEqual([
                { name: "messages", rowCount: 3 },
                { name: "users", rowCount: 1 },
            ]);
        });

        test("reports an empty table as rowCount 0", () => {
            db.raw(`CREATE TABLE "empty" ("__id__" TEXT PRIMARY KEY)`);

            const empty = listTables(db.sql).find((table) => table.name === "empty");

            expect(empty).toEqual({ name: "empty", rowCount: 0 });
        });
    });

    describe("readTablePage", () => {
        test("returns rows, the column list, and the total row count", () => {
            const page = readTablePage(db.sql, { table: "messages" });

            expect(page.total).toBe(3);
            expect(page.columns).toEqual(["__id__", "text", "votes"]);
            expect(page.rows).toHaveLength(3);
            expect(page.rows[0]).toEqual({ __id__: "m1", text: "hello", votes: 3 });
        });

        test("honours limit and offset while keeping the full total", () => {
            const page = readTablePage(db.sql, { table: "messages", limit: 1, offset: 1 });

            expect(page.total).toBe(3);
            expect(page.rows).toEqual([{ __id__: "m2", text: "world", votes: 1 }]);
        });

        test("clamps an oversized limit to the 500 ceiling and floors a negative offset", () => {
            const page = readTablePage(db.sql, { table: "messages", limit: 10_000, offset: -5 });

            expect(page.rows).toHaveLength(3);
        });

        test("rejects an unknown table", () => {
            expect(() => readTablePage(db.sql, { table: "nope" })).toThrow(/unknown table/u);
        });

        test("refuses to read an internal table even though it exists", () => {
            expect(() => readTablePage(db.sql, { table: "_cf_KV" })).toThrow(/unknown table/u);
        });

        test("refuses to read an FTS shadow table", () => {
            expect(() => readTablePage(db.sql, { table: "messages__fts_body" })).toThrow(/unknown table/u);
        });

        test("search filters across every column, with total reflecting the matched set", () => {
            const page = readTablePage(db.sql, { search: "hello", table: "messages" });

            expect(page.total).toBe(1);
            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        test("search matches non-text columns via CAST (numeric votes)", () => {
            db.raw(`INSERT INTO "messages" VALUES ('z', 'zeta', 42)`);

            // 42 lives only in a numeric column; matching it proves the CAST path.
            const page = readTablePage(db.sql, { search: "42", table: "messages" });

            expect(page.rows).toEqual([{ __id__: "z", text: "zeta", votes: 42 }]);
        });

        test("search is case-insensitive", () => {
            expect(readTablePage(db.sql, { search: "WORLD", table: "messages" }).total).toBe(1);
        });

        test("search paginates over the filtered set", () => {
            // All three messages contain the letter that appears in their text;
            // narrow to the two with an 'o' (hello, world) and page through them.
            const first = readTablePage(db.sql, { limit: 1, offset: 0, search: "o", table: "messages" });
            const second = readTablePage(db.sql, { limit: 1, offset: 1, search: "o", table: "messages" });

            expect(first.total).toBe(2);
            expect(second.total).toBe(2);
            expect(first.rows[0]).not.toEqual(second.rows[0]);
        });

        test("a LIKE wildcard in the search is matched literally, not as a pattern", () => {
            db.raw(`INSERT INTO "messages" VALUES ('m4', '100%', 0)`);

            const page = readTablePage(db.sql, { search: "100%", table: "messages" });

            // Escaped: only the literal "100%" row matches, not every row.
            expect(page.rows).toEqual([{ __id__: "m4", text: "100%", votes: 0 }]);
        });

        test("blank search is treated as no filter", () => {
            expect(readTablePage(db.sql, { search: "   ", table: "messages" }).total).toBe(3);
        });
    });
});
