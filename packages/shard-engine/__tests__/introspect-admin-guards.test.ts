import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { facetColumn, isInternalTableName, listTables, readTablePage, selectMatchingIds } from "../src/introspect";
import createSqliteExec from "./_helpers/node-sqlite";

describe("admin introspection guards", () => {
    let database: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        database = createSqliteExec();
    });

    afterEach(() => {
        database.close();
    });

    describe("internal tables", () => {
        const schema = {
            tables: {
                messages: {
                    indexes: [],
                    rankIndexes: [{ name: "byChannel", on: "messages", partitionBy: ["channelId"], sortBy: [{ direction: "asc", field: "_creationTime" }] }],
                    shape: { channelId: { kind: "string" } },
                },
                todos: {
                    aggregateIndexes: [{ by: ["projectId"], name: "byProject", on: "todos", op: "count" }],
                    indexes: [],
                    shape: { projectId: { kind: "string" } },
                },
            },
        } as unknown as SchemaLike;

        it("lists only the user tables, not framework bookkeeping or index companions", async () => {
            expect.assertions(1);

            runShardMigrations(database.sql, schema, { cdc: true });

            const writer = createShardContextDatabase({ cdc: true, clock: () => 1, schema, sql: database.sql });

            await writer.insert("todos", { projectId: "p1" });
            await writer.insert("todos", { projectId: "p2" });
            await writer.insert("messages", { channelId: "c1" });

            expect(listTables(database.sql)).toStrictEqual([
                { name: "messages", rowCount: 1 },
                { name: "todos", rowCount: 2 },
            ]);
        });

        it("refuses every table-addressed read on an internal table with a typed 404", async () => {
            expect.assertions(4);

            runShardMigrations(database.sql, schema, { cdc: true });

            const writer = createShardContextDatabase({ cdc: true, clock: () => 1, schema, sql: database.sql });

            await writer.insert("messages", { channelId: "c1" });

            const rankShadow = "messages__rank_byChannel";

            expect(() => readTablePage(database.sql, { table: rankShadow })).toThrow(/unknown table/u);
            // The clearTable/deleteRows id scan — a rank shadow has no `id`, so
            // reaching the SQL at all fails with a bare "no such column".
            expect(() => selectMatchingIds(database.sql, { table: rankShadow })).toThrow(/unknown table/u);
            expect(() => facetColumn(database.sql, { column: "op", table: "__cdc_log" })).toThrow(/unknown table/u);
            expect(() => selectMatchingIds(database.sql, { table: "__cdc_log" })).toThrow(/unknown table/u);
        });

        it("classifies names by the reserved prefixes and companion infixes", () => {
            expect.assertions(1);

            const names = [
                "sqlite_sequence",
                "_cf_KV",
                "__cdc_log",
                "__idempotency",
                "__stream_runs",
                "posts__agg_n",
                "posts__rank_r",
                "posts__geo_g",
                "posts__fts_body",
                "posts",
                "my_table",
                "a__b",
            ];

            expect(names.filter((name) => isInternalTableName(name))).toStrictEqual(names.slice(0, 9));
        });
    });

    describe("facet column validation", () => {
        it("accepts a schema-declared field that appears only in rows past the key sample", async () => {
            expect.assertions(1);

            const schema = {
                tables: { orders: { indexes: [], shape: { coupon: { inner: { kind: "string" }, kind: "optional" }, total: { kind: "number" } } } },
            } as unknown as SchemaLike;

            runShardMigrations(database.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1, schema, sql: database.sql });

            for (let index = 0; index < 500; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential fixture inserts
                await writer.insert("orders", { total: index });
            }

            await writer.insert("orders", { coupon: "SPRING", total: 1 });

            const result = facetColumn(database.sql, { column: "coupon", columnKinds: { coupon: "string", total: "number" }, table: "orders" });

            expect(result.values).toStrictEqual([
                { count: 500, value: null },
                { count: 1, value: "SPRING" },
            ]);
        });
    });

    describe("search", () => {
        it("matches document values, not field names", async () => {
            expect.assertions(2);

            const schema = {
                tables: { tickets: { indexes: [], shape: { meta: { kind: "any" }, note: { kind: "string" }, status: { kind: "string" } } } },
            } as unknown as SchemaLike;

            runShardMigrations(database.sql, schema);

            const writer = createShardContextDatabase({ clock: () => 1, schema, sql: database.sql });

            await writer.insert("tickets", { meta: {}, note: "check status page", status: "open" });
            await writer.insert("tickets", { meta: {}, note: "printer jam", status: "open" });
            await writer.insert("tickets", { meta: { deep: ["needle STATUS"] }, note: "done", status: "closed" });

            // Row 1 by a top-level value, row 3 by a value two levels down; row 2
            // only carries `status` as a KEY and must not match.
            expect(readTablePage(database.sql, { search: "status", table: "tickets" }).total).toBe(2);
            expect(selectMatchingIds(database.sql, { search: "status", table: "tickets" }).ids).toHaveLength(2);
        });

        it("range-matches a date prefix against doc-stored timestamp and date fields", async () => {
            expect.assertions(2);

            const schema = {
                tables: { tasks: { indexes: [], shape: { dueAt: { kind: "timestamp" }, startsOn: { kind: "date" }, title: { kind: "string" } } } },
            } as unknown as SchemaLike;

            runShardMigrations(database.sql, schema);

            const writer = createShardContextDatabase({ clock: () => Date.UTC(2025, 0, 1), schema, sql: database.sql });

            await writer.insert("tasks", { dueAt: Date.UTC(2026, 6, 15), startsOn: Date.UTC(2020, 0, 1), title: "a" });
            await writer.insert("tasks", { dueAt: Date.UTC(2026, 8, 1), startsOn: Date.UTC(2026, 6, 2), title: "b" });
            await writer.insert("tasks", { dueAt: Date.UTC(2026, 8, 1), startsOn: Date.UTC(2020, 0, 1), title: "c" });

            const columnKinds = { dueAt: "timestamp", startsOn: "date", title: "string" };

            expect(readTablePage(database.sql, { columnKinds, search: "2026-07", table: "tasks" }).total).toBe(2);
            expect(readTablePage(database.sql, { columnKinds, search: "2026-07-15", table: "tasks" }).total).toBe(1);
        });

        it("does not match the wire-tagged originals kept for projected fields", () => {
            expect.assertions(3);

            database.sql.exec(`CREATE TABLE "ledger" (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.sql.exec(
                `INSERT INTO "ledger" VALUES ('a', 1, ?), ('b', 1, ?)`,
                JSON.stringify({ __originals__: { amount: ["$lunora.wire$", "bigint", "123"] }, amount: "000123", memo: "rent" }),
                JSON.stringify({ memo: "food" }),
            );

            expect(readTablePage(database.sql, { search: "bigint", table: "ledger" }).total).toBe(0);
            expect(readTablePage(database.sql, { search: "wire", table: "ledger" }).total).toBe(0);
            expect(readTablePage(database.sql, { search: "rent", table: "ledger" }).total).toBe(1);
        });

        it("still finds a term the JSON text only holds escaped", () => {
            expect.assertions(2);

            database.sql.exec(`CREATE TABLE "quotes" (id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            database.sql.exec(
                `INSERT INTO "quotes" VALUES ('a', 1, ?), ('b', 1, ?)`,
                JSON.stringify({ text: 'say "hi"' }),
                JSON.stringify({ text: String.raw`a\b` }),
            );

            expect(readTablePage(database.sql, { search: '"hi"', table: "quotes" }).total).toBe(1);
            expect(readTablePage(database.sql, { search: String.raw`a\b`, table: "quotes" }).total).toBe(1);
        });
    });

    describe("bulk-op id selection", () => {
        beforeEach(() => {
            database.sql.exec(`CREATE TABLE "plain" (id TEXT PRIMARY KEY, name TEXT)`);
            database.sql.exec(`INSERT INTO "plain" VALUES ('a', 'x'), ('b', 'y')`);
        });

        it("refuses a filter on a column the table does not have", () => {
            expect.assertions(1);

            expect(() => selectMatchingIds(database.sql, { filters: [{ column: "nope", operator: "eq", value: "x" }], table: "plain" })).toThrow(
                /unknown column: nope/u,
            );
        });

        it("refuses a predicate that compiles to nothing rather than selecting every row", () => {
            expect.assertions(2);

            expect(() => selectMatchingIds(database.sql, { filters: [{ column: "name", operator: "contains", value: "" }], table: "plain" })).toThrow(
                /constrains no rows/u,
            );
            expect(() => selectMatchingIds(database.sql, { search: "   ", table: "plain" })).not.toThrow();
        });
    });
});
