import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listTables, readTablePage, selectMatchingIds } from "../src/introspect.js";
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
        // Miniflare's local-dev internal table — must not surface in the browser.
        database.raw(`CREATE TABLE "__miniflare_do_name" ("name" TEXT)`);
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

    describe("readTablePage — structured filters", () => {
        beforeEach(() => {
            // A doc-stored table so the json_extract path can be exercised.
            database.raw(`CREATE TABLE "posts" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(`INSERT INTO "posts" VALUES ('p1', 1, '{"title":"Hi","authorId":"u1"}'), ('p2', 2, '{"title":"Yo","authorId":"u2"}')`);
        });

        it("filters a physical column by equality", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { filters: [{ column: "votes", operator: "eq", value: 3 }], table: "messages" });

            expect(page.total).toBe(1);
            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        it("supports numeric comparison operators", () => {
            expect.assertions(2);

            // votes: m1=3, m2=1, m3=0 → `> 1` keeps only m1; `>= 1` keeps m1, m2.
            expect(readTablePage(database.sql, { filters: [{ column: "votes", operator: "gt", value: 1 }], table: "messages" }).total).toBe(1);
            expect(readTablePage(database.sql, { filters: [{ column: "votes", operator: "gte", value: 1 }], table: "messages" }).total).toBe(2);
        });

        it("supports `contains` (substring) on a physical column", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { filters: [{ column: "text", operator: "contains", value: "ell" }], table: "messages" });

            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        it("filters a doc (`__doc__`) field via json_extract with the path bound", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { filters: [{ column: "title", operator: "eq", value: "Hi" }], table: "posts" });

            expect(page.total).toBe(1);
            expect(page.rows).toEqual([{ _creationTime: 1, authorId: "u1", id: "p1", title: "Hi" }]);
        });

        it("aND-combines structured filters with the substring search", () => {
            expect.assertions(1);

            // search "o" → hello, world; votes >= 1 → hello (3), world (1) — both;
            // tighten to votes > 1 so only hello survives the AND.
            const page = readTablePage(database.sql, { filters: [{ column: "votes", operator: "gt", value: 1 }], search: "o", table: "messages" });

            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        it("paginates over the filtered set with an honest total", () => {
            expect.assertions(3);

            const filters = [{ column: "votes", operator: "gte" as const, value: 0 }];
            const first = readTablePage(database.sql, { filters, limit: 1, offset: 0, table: "messages" });
            const second = readTablePage(database.sql, { filters, limit: 1, offset: 1, table: "messages" });

            expect(first.total).toBe(3);
            expect(second.total).toBe(3);
            expect(first.rows[0]).not.toEqual(second.rows[0]);
        });

        it("drops a clause naming a column the table doesn't have", () => {
            expect.assertions(1);

            // `messages` has no __doc__, so an unknown column can't resolve → the
            // clause is skipped and every row comes back.
            const page = readTablePage(database.sql, { filters: [{ column: "nope", operator: "eq", value: "x" }], table: "messages" });

            expect(page.total).toBe(3);
        });

        it("matches a LIKE wildcard in a `contains` value literally", () => {
            expect.assertions(1);

            database.raw(`INSERT INTO "messages" VALUES ('m9', '50%off', 0)`);

            const page = readTablePage(database.sql, { filters: [{ column: "text", operator: "contains", value: "50%" }], table: "messages" });

            expect(page.rows).toEqual([{ __id__: "m9", text: "50%off", votes: 0 }]);
        });
    });

    describe("selectMatchingIds", () => {
        beforeEach(() => {
            // A canonical shard-shaped table (physical `id` PK) so the selected
            // ids line up with what the writer's `delete(id)` expects.
            database.raw(`CREATE TABLE "posts" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                `INSERT INTO "posts" VALUES ('p1', 1, '{"authorId":"u1"}'), ('p2', 2, '{"authorId":"u1"}'), ('p3', 3, '{"authorId":"u2"}'), ('p4', 4, '{"authorId":"u2"}')`,
            );
        });

        it("returns every id with no predicate (the clearTable case)", () => {
            expect.assertions(2);

            const { hasMore, ids } = selectMatchingIds(database.sql, { table: "posts" });

            expect([...ids].toSorted((a, b) => a.localeCompare(b))).toEqual(["p1", "p2", "p3", "p4"]);
            expect(hasMore).toBe(false);
        });

        it("returns only the ids matching a doc-field filter", () => {
            expect.assertions(2);

            const { hasMore, ids } = selectMatchingIds(database.sql, { filters: [{ column: "authorId", operator: "eq", value: "u2" }], table: "posts" });

            expect([...ids].toSorted((a, b) => a.localeCompare(b))).toEqual(["p3", "p4"]);
            expect(hasMore).toBe(false);
        });

        it("is bounded: caps at `limit` and reports hasMore when more remain", () => {
            expect.assertions(2);

            const { hasMore, ids } = selectMatchingIds(database.sql, { limit: 2, table: "posts" });

            expect(ids).toHaveLength(2);
            expect(hasMore).toBe(true);
        });

        it("reports no more when the match count equals `limit` exactly", () => {
            expect.assertions(2);

            const { hasMore, ids } = selectMatchingIds(database.sql, { filters: [{ column: "authorId", operator: "eq", value: "u1" }], limit: 2, table: "posts" });

            expect(ids).toHaveLength(2);
            expect(hasMore).toBe(false);
        });

        it("throws an unknown-table CirrusError for an internal/unknown table", () => {
            expect.assertions(2);

            expect(() => selectMatchingIds(database.sql, { table: "nope" })).toThrow(/unknown table/u);
            expect(() => selectMatchingIds(database.sql, { table: "_cf_KV" })).toThrow(/unknown table/u);
        });
    });
});
