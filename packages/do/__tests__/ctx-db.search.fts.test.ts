import { describe, expect, it } from "vitest";

import type { SchemaLike, SqlCursor, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";

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

const cursor = <Row>(rows: Row[]): SqlCursor<Row> => {
    return {
        one() {
            if (rows.length !== 1) {
                throw new Error(`expected exactly one row, received ${String(rows.length)}`);
            }

            return rows[0]!;
        },
        [Symbol.iterator]() {
            return rows[Symbol.iterator]();
        },
        toArray() {
            return rows;
        },
    };
};

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
        //
        // OCC-guarded patch/delete (finding 40) probes changes() after the
        // write; in this single-writer double the row always matches the CAS
        // snapshot, so report one changed row.
        const routes: { pattern: RegExp; rows: () => Row[] }[] = [
            { pattern: /^SELECT changes\(\) AS changed$/u, rows: () => [{ changed: 1 }] as unknown as Row[] },
            // The migration-time backfill probes whether the shadow already
            // carries rows (always "no" here, so the backfill runs) and then
            // scans the source table — the canned rows stand in for a table that
            // already held data when the search index was declared.
            { pattern: /^SELECT COUNT\(\*\) AS count FROM /u, rows: () => [{ count: 0 }] as unknown as Row[] },
            { pattern: /^SELECT id, _creationTime, "__doc__" FROM "docs" ORDER BY id ASC/u, rows: () => matchRows as unknown as Row[] },
            { pattern: / MATCH /u, rows: () => matchRows as unknown as Row[] },
            // `lookupById` folds every table into one UNION-ALL probe tagged
            // with `AS __t__`; resolve it to the canned rows (more specific
            // than the generic `LIMIT 1` probe below, so it must come first)
            // so the patch/delete table-resolution path reaches the FTS
            // write-sync.
            {
                pattern: / AS __t__,.* WHERE id = \? LIMIT 1$/u,
                rows: () =>
                    matchRows.map((row) => {
                        return { __t__: "docs", ...(row as unknown as Record<string, unknown>) };
                    }) as unknown as Row[],
            },
            { pattern: /WHERE id = \? LIMIT 1$/u, rows: () => (matchRows.length > 0 ? [{ 1: 1 }] : []) as unknown as Row[] },
            { pattern: /^SELECT id, _creationTime, __doc__ FROM .* WHERE id = \?$/u, rows: () => matchRows as unknown as Row[] },
        ];

        const matched = routes.find((route) => route.pattern.test(sql));

        return cursor(matched ? matched.rows() : []);
    };

    return { sql: { exec }, statements };
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
    it("creates one FTS5 virtual table per search index during migration", () => {
        expect.assertions(1);

        const { sql, statements } = createRecordingFts([]);

        runShardMigrations(sql, searchSchema);

        expect(
            statements.some(
                (statement) => statement.sql === 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs__fts_by_body" USING fts5("__text__", "__id__" UNINDEXED)',
            ),
        ).toBe(true);
    });

    it("backfills rows that predate the search index into the fresh shadow", () => {
        expect.assertions(2);

        const { sql, statements } = createRecordingFts([
            { __doc__: JSON.stringify({ body: "hello world", channel: "x", title: "first" }), _creationTime: 1, id: "d1" },
            { __doc__: JSON.stringify({ body: "hello words", channel: "x", title: "second" }), _creationTime: 2, id: "d2" },
        ]);

        runShardMigrations(sql, searchSchema);

        const inserts = statements.filter((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(inserts).toHaveLength(2);
        expect(inserts.map((statement) => statement.params)).toStrictEqual([
            ["hello world", "d1"],
            ["hello words", "d2"],
        ]);
    });

    it("leaves a staged search index empty for an out-of-band backfill", () => {
        expect.assertions(2);

        const stagedSchema: SchemaLike = {
            tables: {
                docs: {
                    ...searchSchema.tables["docs"]!,
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body", staged: true }],
                },
            },
        };
        const { sql, statements } = createRecordingFts([
            { __doc__: JSON.stringify({ body: "hello world", channel: "x", title: "first" }), _creationTime: 1, id: "d1" },
        ]);

        runShardMigrations(sql, stagedSchema);

        expect(
            statements.some(
                (statement) => statement.sql === 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs__fts_by_body" USING fts5("__text__", "__id__" UNINDEXED)',
            ),
        ).toBe(true);
        expect(statements.some((statement) => statement.sql.startsWith('INSERT INTO "docs__fts_by_body"'))).toBe(false);
    });

    it("syncs indexed text on insert via delete-then-insert", async () => {
        expect.assertions(2);

        const { sql, statements } = createRecordingFts([]);

        runShardMigrations(sql, searchSchema);

        const writer = createShardContextDatabase({ idGenerator: () => "d1", schema: searchSchema, sql });

        await writer.insert("docs", { body: "hello world", channel: "x", title: "a" });

        const remove = statements.find((statement) => statement.sql === 'DELETE FROM "docs__fts_by_body" WHERE "__id__" = ?');
        const add = statements.find((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(remove?.params).toStrictEqual(["d1"]);
        expect(add?.params).toStrictEqual(["hello world", "d1"]);
    });

    it("clears the FTS row on delete (no re-insert)", async () => {
        expect.assertions(2);

        const { sql, statements } = createRecordingFts([{ __doc__: JSON.stringify({ body: "bye", title: "a" }), _creationTime: 1, id: "d1" }]);

        runShardMigrations(sql, searchSchema);

        const writer = createShardContextDatabase({ idGenerator: () => "d1", schema: searchSchema, sql });

        await writer.insert("docs", { body: "bye", channel: "x", title: "a" });

        const before = statements.length;

        await writer.delete("d1");

        const ftsWritesAfter = statements.slice(before).filter((statement) => statement.sql.includes("docs__fts_by_body"));

        expect(ftsWritesAfter.map((statement) => statement.sql)).toStrictEqual(['DELETE FROM "docs__fts_by_body" WHERE "__id__" = ?']);
        expect(ftsWritesAfter[0]?.params).toStrictEqual(["d1"]);
    });

    it("emits a MATCH query joined to the document table, ordered by rank", async () => {
        expect.assertions(3);

        const matchRows: MatchRow[] = [
            { __doc__: JSON.stringify({ body: "hello world", channel: "x", title: "first" }), _creationTime: 1, id: "d1" },
            { __doc__: JSON.stringify({ body: "hello words", channel: "x", title: "second" }), _creationTime: 2, id: "d2" },
        ];
        const { sql, statements } = createRecordingFts(matchRows);

        runShardMigrations(sql, searchSchema);

        const writer = createShardContextDatabase({ schema: searchSchema, sql });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello wor").eq("channel", "x"))
            .take(5);

        const matchStatement = statements.find((statement) => statement.sql.includes(" MATCH "));

        expect(matchStatement?.sql).toBe(
            'SELECT m.id, m._creationTime, m."__doc__" FROM "docs__fts_by_body" f JOIN "docs" m ON m.id = f."__id__" WHERE f."__text__" MATCH ? AND json_extract(__doc__, \'$.channel\') = ? ORDER BY f.rank, m._creationTime DESC, m.id ASC LIMIT 5',
        );
        expect(matchStatement?.params).toStrictEqual(['"hello" AND "wor"*', "x"]);

        // The reader preserves the DB's rank ordering and decodes the rows.
        expect(results.map((document) => document["_id"])).toStrictEqual(["d1", "d2"]);
    });
});
