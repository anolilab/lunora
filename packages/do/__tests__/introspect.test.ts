import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listTables, readTablePage } from "../src/introspect.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

describe("introspect", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();

        database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT, "votes" INTEGER)`);
        database.raw(`CREATE TABLE "users" ("__id__" TEXT PRIMARY KEY, "name" TEXT)`);
        // Internal / shadow tables that must never surface in the data browser.
        // The FTS5 virtual table and its shadow siblings all carry the reserved
        // `__fts_` infix; we model them as plain tables of the same name because
        // this Node build's `node:sqlite` ships without the fts5 module, and the
        // exclusion filter keys off the name alone.
        database.raw(`CREATE TABLE "_cf_KV" ("k" TEXT, "v" BLOB)`);
        database.raw(`CREATE TABLE "messages__fts_body" ("__text__" TEXT, "__id__" TEXT)`);
        database.raw(`CREATE TABLE "messages__fts_body_data" ("id" INTEGER, "block" BLOB)`);

        database.raw(`INSERT INTO "messages" VALUES ('m1', 'hello', 3), ('m2', 'world', 1), ('m3', 'again', 0)`);
        database.raw(`INSERT INTO "users" VALUES ('u1', 'ada')`);
    });

    afterEach(() => {
        database.close();
    });

    describe("listTables", () => {
        it("returns user tables with row counts, sorted, excluding internal and FTS tables", () => {
            expect.assertions(1);

            expect(listTables(database.sql)).toEqual([
                { name: "messages", rowCount: 3 },
                { name: "users", rowCount: 1 },
            ]);
        });

        it("reports an empty table as rowCount 0", () => {
            expect.assertions(1);

            database.raw(`CREATE TABLE "empty" ("__id__" TEXT PRIMARY KEY)`);

            const empty = listTables(database.sql).find((table) => table.name === "empty");

            expect(empty).toEqual({ name: "empty", rowCount: 0 });
        });
    });

    describe("readTablePage", () => {
        it("returns rows, the column list, and the total row count", () => {
            expect.assertions(4);

            const page = readTablePage(database.sql, { table: "messages" });

            expect(page.total).toBe(3);
            expect(page.columns).toEqual(["__id__", "text", "votes"]);
            expect(page.rows).toHaveLength(3);
            expect(page.rows[0]).toEqual({ __id__: "m1", text: "hello", votes: 3 });
        });

        it("honours limit and offset while keeping the full total", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { limit: 1, offset: 1, table: "messages" });

            expect(page.total).toBe(3);
            expect(page.rows).toEqual([{ __id__: "m2", text: "world", votes: 1 }]);
        });

        it("clamps an oversized limit to the 500 ceiling and floors a negative offset", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { limit: 10_000, offset: -5, table: "messages" });

            expect(page.rows).toHaveLength(3);
        });

        it("rejects an unknown table", () => {
            expect.assertions(1);

            expect(() => readTablePage(database.sql, { table: "nope" })).toThrow(/unknown table/u);
        });

        it("refuses to read an internal table even though it exists", () => {
            expect.assertions(1);

            expect(() => readTablePage(database.sql, { table: "_cf_KV" })).toThrow(/unknown table/u);
        });

        it("refuses to read an FTS shadow table", () => {
            expect.assertions(1);

            expect(() => readTablePage(database.sql, { table: "messages__fts_body" })).toThrow(/unknown table/u);
        });

        it("search filters across every column, with total reflecting the matched set", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { search: "hello", table: "messages" });

            expect(page.total).toBe(1);
            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        it("search matches non-text columns via CAST (numeric votes)", () => {
            expect.assertions(1);

            database.raw(`INSERT INTO "messages" VALUES ('z', 'zeta', 42)`);

            // 42 lives only in a numeric column; matching it proves the CAST path.
            const page = readTablePage(database.sql, { search: "42", table: "messages" });

            expect(page.rows).toEqual([{ __id__: "z", text: "zeta", votes: 42 }]);
        });

        it("search is case-insensitive", () => {
            expect.assertions(1);

            expect(readTablePage(database.sql, { search: "WORLD", table: "messages" }).total).toBe(1);
        });

        it("search paginates over the filtered set", () => {
            expect.assertions(3);

            // All three messages contain the letter that appears in their text;
            // narrow to the two with an 'o' (hello, world) and page through them.
            const first = readTablePage(database.sql, { limit: 1, offset: 0, search: "o", table: "messages" });
            const second = readTablePage(database.sql, { limit: 1, offset: 1, search: "o", table: "messages" });

            expect(first.total).toBe(2);
            expect(second.total).toBe(2);
            expect(first.rows[0]).not.toEqual(second.rows[0]);
        });

        it("a LIKE wildcard in the search is matched literally, not as a pattern", () => {
            expect.assertions(1);

            database.raw(`INSERT INTO "messages" VALUES ('m4', '100%', 0)`);

            const page = readTablePage(database.sql, { search: "100%", table: "messages" });

            // Escaped: only the literal "100%" row matches, not every row.
            expect(page.rows).toEqual([{ __id__: "m4", text: "100%", votes: 0 }]);
        });

        it("blank search is treated as no filter", () => {
            expect.assertions(1);

            expect(readTablePage(database.sql, { search: "   ", table: "messages" }).total).toBe(3);
        });
    });

    describe("readTablePage — doc-blob expansion and refs", () => {
        // A canonical Cirrus shard table: id / _creationTime / __doc__ JSON blob.
        beforeEach(() => {
            database.raw(`CREATE TABLE "posts" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(`INSERT INTO "posts" VALUES ('p1', 1, '{"title":"Hi","authorId":"u1"}'), ('p2', 2, '{"title":"Yo","authorId":"u2"}')`);
        });

        it("expands __doc__ into per-field columns, dropping the blob column", () => {
            expect.assertions(3);

            const page = readTablePage(database.sql, { table: "posts" });

            expect(page.columns).toEqual(["id", "_creationTime", "title", "authorId"]);
            expect(page.rows[0]).toEqual({ _creationTime: 1, authorId: "u1", id: "p1", title: "Hi" });
            expect(page.total).toBe(2);
        });

        it("server search matches values inside the doc blob", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { search: "u2", table: "posts" });

            expect(page.total).toBe(1);
            expect(page.rows).toEqual([{ _creationTime: 2, authorId: "u2", id: "p2", title: "Yo" }]);
        });

        it("echoes only the refs whose column surfaces in the page", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { refs: { authorId: "users", missing: "nope" }, table: "posts" });

            expect(page.refs).toEqual({ authorId: "users" });
        });

        it("omits refs entirely when none are supplied", () => {
            expect.assertions(1);

            expect(readTablePage(database.sql, { table: "posts" }).refs).toBeUndefined();
        });

        it("leaves a non-doc (column-per-field) table untouched", () => {
            expect.assertions(1);

            // The `messages` fixture has no __doc__; expansion must be a no-op.
            const page = readTablePage(database.sql, { table: "messages" });

            expect(page.columns).toEqual(["__id__", "text", "votes"]);
        });
    });
});
