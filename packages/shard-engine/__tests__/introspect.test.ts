import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCursor, SqlExec } from "../src/ctx-db";
import {
    createFanoutCounters,
    datePrefixRange,
    facetColumn,
    findStorageReferences,
    listTables,
    readTablePage,
    recordFanoutPass,
    selectMatchingIds,
    summarizeFanoutTopics,
    summarizeSubscriptions,
} from "../src/introspect";
import createSqliteExec from "./_helpers/node-sqlite";

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

        it("omits the total and issues no COUNT when skipCount is set", () => {
            expect.assertions(4);

            // Record every executed statement so we can assert the COUNT is skipped.
            const queries: string[] = [];
            const recordingSql: SqlExec = {
                exec: <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]): SqlCursor<Row> => {
                    queries.push(query);

                    return database.sql.exec<Row>(query, ...parameters);
                },
            };

            const page = readTablePage(recordingSql, { skipCount: true, table: "messages" });

            // Rows + columns still returned; only the count is elided.
            expect(page.total).toBeUndefined();
            expect(page.rows).toHaveLength(3);
            expect(page.columns).toEqual(["__id__", "text", "votes"]);
            // No `SELECT COUNT(*)` was ever executed.
            expect(queries.some((query) => /COUNT\(\*\)/iu.test(query))).toBe(false);
        });

        it("still runs the COUNT and reports the total when skipCount is false", () => {
            expect.assertions(2);

            const queries: string[] = [];
            const recordingSql: SqlExec = {
                exec: <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]): SqlCursor<Row> => {
                    queries.push(query);

                    return database.sql.exec<Row>(query, ...parameters);
                },
            };

            const page = readTablePage(recordingSql, { search: "o", skipCount: false, table: "messages" });

            expect(page.total).toBe(2);
            expect(queries.some((query) => /COUNT\(\*\)/iu.test(query))).toBe(true);
        });

        it("clamps an oversized limit to the 500 ceiling and floors a negative offset", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { limit: 10_000, offset: -5, table: "messages" });

            expect(page.rows).toHaveLength(3);
        });

        it("orders by a physical column ascending and descending", () => {
            expect.assertions(2);

            const asc = readTablePage(database.sql, { orderBy: { column: "text", direction: "asc" }, table: "messages" });
            const desc = readTablePage(database.sql, { orderBy: { column: "votes", direction: "desc" }, table: "messages" });

            expect(asc.rows.map((row) => row["text"])).toEqual(["again", "hello", "world"]);
            expect(desc.rows.map((row) => row["__id__"])).toEqual(["m1", "m2", "m3"]);
        });

        it("orders over the WHOLE table before windowing (sort, then limit/offset)", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { limit: 1, offset: 0, orderBy: { column: "votes", direction: "desc" }, table: "messages" });

            // Highest votes (m1=3) wins the first page even though it's the first
            // physical row only by coincidence — the sort runs before the window.
            expect(page.rows).toEqual([{ __id__: "m1", text: "hello", votes: 3 }]);
        });

        it("ignores an orderBy referencing an unknown column (natural order)", () => {
            expect.assertions(1);

            const page = readTablePage(database.sql, { orderBy: { column: "nope", direction: "asc" }, table: "messages" });

            expect(page.rows.map((row) => row["__id__"])).toEqual(["m1", "m2", "m3"]);
        });

        it("orders by a __doc__ field via json_extract", () => {
            expect.assertions(1);

            database.raw(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER, "__doc__" TEXT)`);
            database.raw(`INSERT INTO "docs" VALUES ('d1', 1, '{"title":"gamma"}'), ('d2', 2, '{"title":"alpha"}'), ('d3', 3, '{"title":"beta"}')`);

            const page = readTablePage(database.sql, { orderBy: { column: "title", direction: "asc" }, table: "docs" });

            expect(page.rows.map((row) => row["title"])).toEqual(["alpha", "beta", "gamma"]);
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
        // A canonical Lunora shard table: id / _creationTime / __doc__ JSON blob.
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

        // The doc blob is written through the wire codec (`encodeDocJson`), so a
        // `v.bigint()` / `v.bytes()` column is stored as a tagged array. Display
        // must go back through the codec, not bare `JSON.parse` — otherwise the
        // data browser shows `["$lunora.wire$","bigint","1000"]` where an amount
        // belongs. The money path (`paymentSessions.amountMinor`) is exactly this.
        it("decodes wire-tagged doc fields rather than surfacing the raw tag", () => {
            expect.assertions(3);

            database.raw(`CREATE TABLE "sessions" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                `INSERT INTO "sessions" VALUES ('s1', 1, '{"amountMinor":["$lunora.wire$","bigint","1000"],"blob":["$lunora.wire$","bytes","AAEC","ArrayBuffer"],"note":"ok"}')`,
            );

            const page = readTablePage(database.sql, { table: "sessions" });
            const row = page.rows[0] as { amountMinor: unknown; blob: unknown; note: unknown };

            expect(row.amountMinor).toBe(1000n);
            expect(row.blob).toBeInstanceOf(ArrayBuffer);
            // Untagged siblings are untouched.
            expect(row.note).toBe("ok");
        });

        // The fidelity guarantee that makes the decode safe to apply everywhere:
        // a document with no tagged leaves must come back exactly as before.
        it("leaves a plain-JSON doc byte-identical through the decode", () => {
            expect.assertions(2);

            const page = readTablePage(database.sql, { table: "posts" });

            expect(page.columns).toEqual(["id", "_creationTime", "title", "authorId"]);
            expect(page.rows).toEqual([
                { _creationTime: 1, authorId: "u1", id: "p1", title: "Hi" },
                { _creationTime: 2, authorId: "u2", id: "p2", title: "Yo" },
            ]);
        });

        // A doc whose ROOT is a tagged value parses as an array but decodes to a
        // Uint8Array / Date / Map — none of which is a document. Under bare
        // `JSON.parse` the `!Array.isArray` check caught this; after decoding it
        // does not, and spreading a Uint8Array would emit junk numeric columns
        // (`{"0":1,"1":2,...}`). The guard is by prototype for exactly this.
        it.each([
            ["bytes", `["$lunora.wire$","bytes","AAEC","ArrayBuffer"]`],
            ["date", `["$lunora.wire$","date",0]`],
            ["map", `["$lunora.wire$","map",[["a",1]]]`],
        ])("refuses to expand a doc whose root decodes to a %s", (kind, doc) => {
            expect.assertions(2);

            database.raw(`CREATE TABLE "root_${kind}" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(`INSERT INTO "root_${kind}" VALUES ('r1', 1, '${doc}')`);

            const page = readTablePage(database.sql, { table: `root_${kind}` });

            // Unexpanded — never a row of numeric byte columns.
            expect(page.columns).toEqual(["id", "_creationTime", "__doc__"]);
            expect(Object.keys(page.rows[0] as object)).toEqual(["id", "_creationTime", "__doc__"]);
        });

        // `decodeWire` throws on a malformed tag (an over-long or non-numeric
        // bigint). `safeParseObject`'s non-throwing contract must hold, so the
        // page degrades to "unexpanded" instead of failing the whole read.
        it("falls back to the unexpanded page when a doc carries a malformed tag", () => {
            expect.assertions(2);

            database.raw(`CREATE TABLE "broken" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(`INSERT INTO "broken" VALUES ('b1', 1, '{"amountMinor":["$lunora.wire$","bigint","not-a-number"]}')`);

            const page = readTablePage(database.sql, { table: "broken" });

            expect(page.columns).toEqual(["id", "_creationTime", "__doc__"]);
            expect(page.total).toBe(1);
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

            const { hasMore, ids } = selectMatchingIds(database.sql, {
                filters: [{ column: "authorId", operator: "eq", value: "u1" }],
                limit: 2,
                table: "posts",
            });

            expect(ids).toHaveLength(2);
            expect(hasMore).toBe(false);
        });

        it("throws an unknown-table LunoraError for an internal/unknown table", () => {
            expect.assertions(2);

            expect(() => selectMatchingIds(database.sql, { table: "nope" })).toThrow(/unknown table/u);
            expect(() => selectMatchingIds(database.sql, { table: "_cf_KV" })).toThrow(/unknown table/u);
        });
    });

    describe("facetColumn", () => {
        beforeEach(() => {
            // A canonical doc-stored table so both physical and __doc__ facet paths
            // can be exercised. `status` skews so ORDER BY count is observable.
            database.raw(`CREATE TABLE "posts" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                `INSERT INTO "posts" VALUES ` +
                    `('p1', 1, '{"status":"open","authorId":"u1"}'), ` +
                    `('p2', 2, '{"status":"open","authorId":"u2"}'), ` +
                    `('p3', 3, '{"status":"open","authorId":"u1"}'), ` +
                    `('p4', 4, '{"status":"closed","authorId":"u2"}'), ` +
                    `('p5', 5, '{"status":"error","authorId":"u1"}')`,
            );
        });

        it("groups a doc field into value/count rows ordered by frequency", () => {
            expect.assertions(2);

            const { truncated, values } = facetColumn(database.sql, { column: "status", table: "posts" });

            // open=3, closed=1, error=1 → open leads; the two singletons follow.
            expect(values[0]).toEqual({ count: 3, value: "open" });
            expect(truncated).toBe(false);
        });

        it("facets a physical column", () => {
            expect.assertions(1);

            const { values } = facetColumn(database.sql, { column: "votes", table: "messages" });

            // messages.votes: 3, 1, 0 — each distinct once.
            expect(values.toSorted((a, b) => Number(a.value) - Number(b.value))).toEqual([
                { count: 1, value: 0 },
                { count: 1, value: 1 },
                { count: 1, value: 3 },
            ]);
        });

        it("reflects the active filters/search (facets over the previewed view)", () => {
            expect.assertions(2);

            const { values } = facetColumn(database.sql, {
                column: "status",
                filters: [{ column: "authorId", operator: "eq", value: "u1" }],
                table: "posts",
            });

            // u1's rows: p1(open), p3(open), p5(error) → open=2, error=1.
            const byValue = Object.fromEntries(values.map((row) => [row.value, row.count]));

            expect(byValue["open"]).toBe(2);
            expect(byValue["error"]).toBe(1);
        });

        it("caps at the limit and reports truncation, over-fetching one extra", () => {
            expect.assertions(3);

            const { truncated, values } = facetColumn(database.sql, { column: "status", limit: 2, table: "posts" });

            // 3 distinct statuses, cap 2 → returns 2 and flags truncated.
            expect(values).toHaveLength(2);
            expect(truncated).toBe(true);
            // The most frequent value is always kept first.
            expect(values[0]).toEqual({ count: 3, value: "open" });
        });

        it("does not flag truncation when distinct values fit exactly under the cap", () => {
            expect.assertions(2);

            const { truncated, values } = facetColumn(database.sql, { column: "status", limit: 3, table: "posts" });

            expect(values).toHaveLength(3);
            expect(truncated).toBe(false);
        });

        it("rejects an unknown column with a LunoraError (never interpolates it)", () => {
            expect.assertions(2);

            // A typo'd doc field that no row has must be rejected, not silently
            // faceted as a column of NULLs.
            expect(() => facetColumn(database.sql, { column: "nope", table: "posts" })).toThrow(/unknown column/u);
            expect(() => facetColumn(database.sql, { column: "alsoNope", table: "messages" })).toThrow(/unknown column/u);
        });

        it("throws an unknown-table LunoraError for an internal/unknown table", () => {
            expect.assertions(2);

            expect(() => facetColumn(database.sql, { column: "x", table: "nope" })).toThrow(/unknown table/u);
            expect(() => facetColumn(database.sql, { column: "k", table: "_cf_KV" })).toThrow(/unknown table/u);
        });
    });

    describe("findStorageReferences", () => {
        beforeEach(() => {
            // Two canonical shard-shaped tables: `avatars` stores its key in the
            // `__doc__` blob, `banners` in a physical column — exercising both
            // resolution paths.
            database.raw(`CREATE TABLE "avatars" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.raw(
                `INSERT INTO "avatars" VALUES ('a1', 1, '{"fileKey":"u/1.png"}'), ('a2', 2, '{"fileKey":"u/2.png"}'), ('a3', 3, '{"fileKey":"u/1.png"}')`,
            );
            database.raw(`CREATE TABLE "banners" ("id" TEXT PRIMARY KEY, "image" TEXT)`);
            database.raw(`INSERT INTO "banners" VALUES ('b1', 'u/2.png')`);
        });

        it("maps each key to every row that references it (doc-stored column)", () => {
            expect.assertions(2);

            const { references } = findStorageReferences(database.sql, { avatars: ["fileKey"] }, ["u/1.png", "u/2.png"]);

            expect((references["u/1.png"] ?? []).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
                { column: "fileKey", id: "a1", table: "avatars" },
                { column: "fileKey", id: "a3", table: "avatars" },
            ]);
            expect(references["u/2.png"]).toEqual([{ column: "fileKey", id: "a2", table: "avatars" }]);
        });

        it("resolves a physical (non-doc) storage column too", () => {
            expect.assertions(1);

            const { references } = findStorageReferences(database.sql, { banners: ["image"] }, ["u/2.png"]);

            expect(references["u/2.png"]).toEqual([{ column: "image", id: "b1", table: "banners" }]);
        });

        it("seeds every requested key, leaving an unreferenced key an empty array (orphan)", () => {
            expect.assertions(2);

            const { references } = findStorageReferences(database.sql, { avatars: ["fileKey"] }, ["u/1.png", "orphan.png"]);

            expect(references["orphan.png"]).toEqual([]);
            expect(Object.keys(references).toSorted((a, b) => a.localeCompare(b))).toEqual(["orphan.png", "u/1.png"]);
        });

        it("echoes the declared storage columns and short-circuits on no keys", () => {
            expect.assertions(2);

            const result = findStorageReferences(database.sql, { avatars: ["fileKey"] }, []);

            expect(result.references).toEqual({});
            expect(result.storageColumns).toEqual({ avatars: ["fileKey"] });
        });

        it("skips unknown/internal tables in the map without throwing", () => {
            expect.assertions(1);

            const { references } = findStorageReferences(database.sql, { _cf_KV: ["image"], avatars: ["fileKey"], nope: ["x"] }, ["u/1.png"]);

            expect(references["u/1.png"]).toEqual([
                { column: "fileKey", id: "a1", table: "avatars" },
                { column: "fileKey", id: "a3", table: "avatars" },
            ]);
        });
    });

    describe("summarizeSubscriptions", () => {
        it("returns an empty result with zeroed totals for no sockets", () => {
            expect.assertions(1);

            expect(summarizeSubscriptions([])).toEqual({ connections: [], totalConnections: 0, totalSubscriptions: 0 });
        });

        it("builds one connection per socket with index ids, admin flags, and subscription details", () => {
            expect.assertions(1);

            const result = summarizeSubscriptions([
                {
                    admin: true,
                    subs: {
                        "sub-1": { args: { room: "general" }, functionPath: "messages:list", table: "messages" },
                    },
                },
                {
                    subs: {
                        "sub-a": { functionPath: "presence:list", table: "presence" },
                        "sub-b": { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                    },
                },
                { subs: {} },
            ]);

            expect(result).toEqual({
                connections: [
                    {
                        admin: true,
                        id: 0,
                        subscriptions: [{ args: { room: "general" }, functionPath: "messages:list", table: "messages" }],
                    },
                    {
                        admin: false,
                        id: 1,
                        subscriptions: [
                            { args: undefined, functionPath: "presence:list", table: "presence" },
                            { args: { since: 5 }, functionPath: "feed:recent", table: "posts" },
                        ],
                    },
                    { admin: false, id: 2, subscriptions: [] },
                ],
                totalConnections: 3,
                totalSubscriptions: 3,
            });
        });

        it("treats a missing subs map as no subscriptions", () => {
            expect.assertions(1);

            expect(summarizeSubscriptions([{ admin: false }])).toEqual({
                connections: [{ admin: false, id: 0, subscriptions: [] }],
                totalConnections: 1,
                totalSubscriptions: 0,
            });
        });
    });

    describe("summarizeFanoutTopics", () => {
        it("returns an empty result with zeroed peak for no sockets", () => {
            expect.assertions(1);

            expect(summarizeFanoutTopics([])).toEqual({ peakSubscribers: 0, topics: [], totalConnections: 0 });
        });

        it("counts shapes by name and whispers by topic, busiest first", () => {
            expect.assertions(1);

            const result = summarizeFanoutTopics([
                { shapes: { "s-1": { name: "roomMessages" } }, whispers: ["cursor:general"] },
                { shapes: { "s-2": { name: "roomMessages" } }, whispers: ["cursor:general"] },
                { shapes: { "s-3": { name: "roomMessages" }, "s-4": { name: "roster" } } },
                { whispers: ["cursor:general", "typing:42"] },
            ]);

            // roomMessages: 3 sockets, cursor:general: 3 sockets, roster: 1, typing:42: 1.
            expect(result).toEqual({
                peakSubscribers: 3,
                topics: [
                    { kind: "whisper", subscribers: 3, topic: "cursor:general" },
                    { kind: "shape", subscribers: 3, topic: "roomMessages" },
                    { kind: "shape", subscribers: 1, topic: "roster" },
                    { kind: "whisper", subscribers: 1, topic: "typing:42" },
                ],
                totalConnections: 4,
            });
        });

        it("falls back to a sentinel name for a shape with no registered name", () => {
            expect.assertions(1);

            expect(summarizeFanoutTopics([{ shapes: { "s-1": {} } }])).toEqual({
                peakSubscribers: 1,
                topics: [{ kind: "shape", subscribers: 1, topic: "(unknown shape)" }],
                totalConnections: 1,
            });
        });

        it("caps the returned topics at the supplied limit while peak still reflects the busiest", () => {
            expect.assertions(3);

            // "a" is joined by both sockets; "b"/"c" by one each. A limit of 2 keeps
            // only the two busiest, but the peak still reflects the global maximum.
            const result = summarizeFanoutTopics([{ whispers: ["a", "b", "c"] }, { whispers: ["a"] }], 2);

            expect(result.topics).toHaveLength(2);
            expect(result.topics[0]).toEqual({ kind: "whisper", subscribers: 2, topic: "a" });
            expect(result.peakSubscribers).toBe(2);
        });
    });

    describe("recordFanoutPass / createFanoutCounters", () => {
        it("starts every counter at zero", () => {
            expect.assertions(1);

            expect(createFanoutCounters()).toEqual({
                maxMs: 0,
                passes: 0,
                peakSocketsIterated: 0,
                socketsDelivered: 0,
                socketsIterated: 0,
                totalMs: 0,
            });
        });

        it("accumulates totals and lifts the peak-width and slowest-pass high-water marks", () => {
            expect.assertions(2);

            let counters = createFanoutCounters();

            counters = recordFanoutPass(counters, 10, 4, 3);
            counters = recordFanoutPass(counters, 25, 25, 1);
            counters = recordFanoutPass(counters, 7, 0, 12);

            expect(counters).toEqual({
                maxMs: 12,
                passes: 3,
                peakSocketsIterated: 25,
                socketsDelivered: 29,
                socketsIterated: 42,
                totalMs: 16,
            });

            // Pure: a single pass returns a fresh object and never mutates its input.
            const base = createFanoutCounters();

            recordFanoutPass(base, 5, 5, 5);

            expect(base).toEqual(createFanoutCounters());
        });
    });
});

describe("datePrefixRange", () => {
    it("turns a year into a whole-year half-open range", () => {
        expect.assertions(2);

        const range = datePrefixRange("2026");

        expect(range?.from).toBe(Date.UTC(2026, 0, 1));
        expect(range?.to).toBe(Date.UTC(2027, 0, 1));
    });

    it("turns a month into that month, and rolls the year at December", () => {
        expect.assertions(3);

        expect(datePrefixRange("2026-07")?.from).toBe(Date.UTC(2026, 6, 1));
        expect(datePrefixRange("2026-07")?.to).toBe(Date.UTC(2026, 7, 1));
        // December must roll into next January, not month 12 of the same year.
        expect(datePrefixRange("2026-12")?.to).toBe(Date.UTC(2027, 0, 1));
    });

    it("turns a full date into a single day", () => {
        expect.assertions(2);

        expect(datePrefixRange("2026-07-04")?.from).toBe(Date.UTC(2026, 6, 4));
        expect(datePrefixRange("2026-07-04")?.to).toBe(Date.UTC(2026, 6, 5));
    });

    it("ignores terms that are not date prefixes", () => {
        expect.assertions(4);

        expect(datePrefixRange("alice")).toBeUndefined();
        expect(datePrefixRange("2026-13")).toBeUndefined();
        expect(datePrefixRange("2026-07-32")).toBeUndefined();
        expect(datePrefixRange("")).toBeUndefined();
    });
});
