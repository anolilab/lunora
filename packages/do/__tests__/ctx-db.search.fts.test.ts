import { describe, expect, test } from "vitest";

import type { SchemaLike, SqlCursor, SqlExec } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";

/**
 * The FTS5 production path can't run under `node:sqlite` (no fts5 module), so
 * this asserts the *emitted SQL* instead of its results: a recording `SqlExec`
 * double that reports FTS5 available (the create/drop probe succeeds), returns
 * canned rows for any MATCH query, and captures every statement + params. We
 * verify the virtual-table DDL, the delete-then-insert write sync, and the
 * MATCH/JOIN/ORDER-BY-rank search query. Behavioral correctness of the query
 * surface is covered by the LIKE-scan suite in `ctx-db.search.test.ts`.
 */

interface Recorded {
    params: unknown[];
    sql: string;
}

interface MatchRow {
    __doc__: string;
    _creationTime: number;
    id: string;
}

const cursor = <Row>(rows: Row[]): SqlCursor<Row> => ({
    [Symbol.iterator]() {
        return rows[Symbol.iterator]();
    },
    one() {
        if (rows.length !== 1) {
            throw new Error(`expected exactly one row, received ${String(rows.length)}`);
        }

        return rows[0]!;
    },
    toArray() {
        return rows;
    },
});

const createRecordingFts = (matchRows: MatchRow[]): { sql: SqlExec; statements: Recorded[] } => {
    const statements: Recorded[] = [];

    const exec = <Row = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<Row> => {
        const sql = query.replaceAll(/\s+/gu, " ").trim();

        statements.push({ params, sql });

        // The FTS5 probe (`CREATE VIRTUAL TABLE … fts5`) and all DDL/DML succeed
        // by returning no rows. A MATCH search returns the canned result set so
        // the reader can decode and order it. The id-probe and by-id reads
        // resolve to the canned rows so the patch/delete table-resolution path
        // (`tableNameFromId` + `get`) reaches the FTS write-sync.
        let rows: Row[] = [];

        if (/^SELECT changes\(\) AS changed$/u.test(sql)) {
            // OCC-guarded patch/delete (finding 40) probes changes() after the
            // write; in this single-writer double the row always matches the
            // CAS snapshot, so report one changed row.
            rows = [{ changed: 1 }] as unknown as Row[];
        } else if (/ MATCH /u.test(sql)) {
            rows = matchRows as unknown as Row[];
        } else if (/WHERE id = \? LIMIT 1$/u.test(sql)) {
            rows = (matchRows.length > 0 ? [{ 1: 1 }] : []) as unknown as Row[];
        } else if (/^SELECT id, _creationTime, __doc__ FROM .* WHERE id = \?$/u.test(sql)) {
            rows = matchRows as unknown as Row[];
        }

        return cursor(rows);
    };

    return { sql: { exec: exec as SqlExec["exec"] }, statements };
};

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: {
                body: { kind: "string" },
                channel: { kind: "string" },
                title: { kind: "string" },
            },
        },
    },
};

describe("ctx-db search — FTS5 path (emitted SQL)", () => {
    test("creates one FTS5 virtual table per search index during migration", () => {
        expect.assertions(1);

        const { sql, statements } = createRecordingFts([]);

        runShardMigrations(sql, searchSchema);

        expect(
            statements.some(
                (statement) => statement.sql === 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs__fts_by_body" USING fts5("__text__", "__id__" UNINDEXED)',
            ),
        ).toBe(true);
    });

    test("syncs indexed text on insert via delete-then-insert", async () => {
        expect.assertions(2);

        const { sql, statements } = createRecordingFts([]);

        runShardMigrations(sql, searchSchema);

        const writer = createShardCtxDb({ idGenerator: () => "d1", schema: searchSchema, sql });

        await writer.insert("docs", { body: "hello world", channel: "x", title: "a" });

        const remove = statements.find((statement) => statement.sql === 'DELETE FROM "docs__fts_by_body" WHERE "__id__" = ?');
        const add = statements.find((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(remove?.params).toStrictEqual(["d1"]);
        expect(add?.params).toStrictEqual(["hello world", "d1"]);
    });

    test("clears the FTS row on delete (no re-insert)", async () => {
        expect.assertions(2);

        const { sql, statements } = createRecordingFts([{ __doc__: JSON.stringify({ body: "bye", title: "a" }), _creationTime: 1, id: "d1" }]);

        runShardMigrations(sql, searchSchema);

        const writer = createShardCtxDb({ idGenerator: () => "d1", schema: searchSchema, sql });

        await writer.insert("docs", { body: "bye", channel: "x", title: "a" });

        const before = statements.length;

        await writer.delete("d1");

        const ftsWritesAfter = statements.slice(before).filter((statement) => statement.sql.includes("docs__fts_by_body"));

        expect(ftsWritesAfter.map((statement) => statement.sql)).toStrictEqual(['DELETE FROM "docs__fts_by_body" WHERE "__id__" = ?']);
        expect(ftsWritesAfter[0]?.params).toStrictEqual(["d1"]);
    });

    test("emits a MATCH query joined to the document table, ordered by rank", async () => {
        expect.assertions(3);

        const matchRows: MatchRow[] = [
            { __doc__: JSON.stringify({ body: "hello world", channel: "x", title: "first" }), _creationTime: 1, id: "d1" },
            { __doc__: JSON.stringify({ body: "hello words", channel: "x", title: "second" }), _creationTime: 2, id: "d2" },
        ];
        const { sql, statements } = createRecordingFts(matchRows);

        runShardMigrations(sql, searchSchema);

        const writer = createShardCtxDb({ schema: searchSchema, sql });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello wor").eq("channel", "x"))
            .take(5);

        const matchStatement = statements.find((statement) => statement.sql.includes(" MATCH "));

        expect(matchStatement?.sql).toBe(
            'SELECT m.id, m._creationTime, m.__doc__ FROM "docs__fts_by_body" f JOIN "docs" m ON m.id = f."__id__" WHERE f."__text__" MATCH ? AND json_extract(__doc__, \'$.channel\') = ? ORDER BY f.rank, m._creationTime DESC LIMIT 5',
        );
        expect(matchStatement?.params).toStrictEqual(['"hello" AND "wor"*', "x"]);

        // The reader preserves the DB's rank ordering and decodes the rows.
        expect(results.map((document) => document["_id"])).toStrictEqual(["d1", "d2"]);
    });
});
