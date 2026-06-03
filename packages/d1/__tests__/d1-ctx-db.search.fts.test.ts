import type { SchemaLike, ValidatorLike } from "@cirrus/do";
import { describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db.js";
import { createD1CtxDb as createD1ContextDatabase, runD1SearchMigrations } from "../src/d1-ctx-db.js";

/**
 * The FTS5 production path can't run under `node:sqlite` (no fts5 module), so
 * this asserts the *emitted SQL* against the D1 column dialect instead of its
 * results: a recording `D1Exec` double that reports FTS5 available (the
 * create/drop probe succeeds), returns canned rows for any MATCH query, and
 * captures every statement + params. We verify the virtual-table DDL, the
 * delete-then-insert write sync, and the MATCH/JOIN/ORDER-BY-rank search query.
 * Behavioral correctness of the query surface is covered by the LIKE-scan suite
 * in `d1-ctx-db.search.test.ts`. The D1 twin of `@cirrus/do`'s
 * `ctx-db.search.fts.test.ts`.
 */

interface Recorded {
    params: ReadonlyArray<unknown>;
    sql: string;
}

/** A canned MATCH/by-id row in the D1 column-per-field shape (no `__doc__` blob). */
interface MatchRow {
    _creationTime: number;
    body: string;
    channel: string;
    id: string;
    title: string;
}

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: {
                body: col("string"),
                channel: col("string"),
                title: col("string"),
            },
        },
    },
};

const normalize = (query: string): string => query.replaceAll(/\s+/gu, " ").trim();

const createRecordingFts = (matchRows: MatchRow[]): { exec: D1Exec; statements: Recorded[] } => {
    const statements: Recorded[] = [];

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => {
        const sql = normalize(query);

        statements.push({ params: parameters, sql });

        // A MATCH search returns the canned result set so the reader can decode
        // and order it. The id-probe and by-id reads resolve to the canned rows
        // so the patch/delete table-resolution path (`tableNameFromId` +
        // `rawRow`) reaches the FTS write-sync. The OCC-guarded UPDATE/DELETE
        // (`RETURNING "id"`) reports one changed row so the CAS passes.
        const routes: { pattern: RegExp; rows: () => Record<string, unknown>[] }[] = [
            { pattern: / MATCH /u, rows: () => matchRows as unknown as Record<string, unknown>[] },
            { pattern: /RETURNING "id"$/u, rows: () => (matchRows.length > 0 ? [{ id: matchRows[0]?.id }] : [{ id: "d1" }]) },
            { pattern: /WHERE "id" = \? LIMIT 1$/u, rows: () => (matchRows.length > 0 ? [{ 1: 1 }] : []) },
            { pattern: /^SELECT \* FROM .* WHERE "id" = \?$/u, rows: () => matchRows as unknown as Record<string, unknown>[] },
        ];

        const matched = routes.find((route) => route.pattern.test(sql));

        return matched ? matched.rows() : [];
    };

    return {
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
        statements,
    };
};

describe("d1 ctx-db search — FTS5 path (emitted SQL)", () => {
    it("creates one FTS5 virtual table per search index during migration", async () => {
        expect.assertions(1);

        const { exec, statements } = createRecordingFts([]);

        await runD1SearchMigrations(exec, searchSchema);

        expect(
            statements.some(
                (statement) => statement.sql === 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs__fts_by_body" USING fts5("__text__", "__id__" UNINDEXED)',
            ),
        ).toBe(true);
    });

    it("syncs indexed text on insert via delete-then-insert", async () => {
        expect.assertions(2);

        const { exec, statements } = createRecordingFts([]);

        await runD1SearchMigrations(exec, searchSchema);

        const writer = createD1ContextDatabase({ exec, idGenerator: () => "d1", schema: searchSchema });

        await writer.insert("docs", { body: "hello world", channel: "x", title: "a" });

        const remove = statements.find((statement) => statement.sql === 'DELETE FROM "docs__fts_by_body" WHERE "__id__" = ?');
        const add = statements.find((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(remove?.params).toStrictEqual(["d1"]);
        expect(add?.params).toStrictEqual(["hello world", "d1"]);
    });

    it("clears the FTS row on delete (no re-insert)", async () => {
        expect.assertions(2);

        const { exec, statements } = createRecordingFts([{ _creationTime: 1, body: "bye", channel: "x", id: "d1", title: "a" }]);

        await runD1SearchMigrations(exec, searchSchema);

        const writer = createD1ContextDatabase({ exec, idGenerator: () => "d1", schema: searchSchema });

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
            { _creationTime: 1, body: "hello world", channel: "x", id: "d1", title: "first" },
            { _creationTime: 2, body: "hello words", channel: "x", id: "d2", title: "second" },
        ];
        const { exec, statements } = createRecordingFts(matchRows);

        await runD1SearchMigrations(exec, searchSchema);

        const writer = createD1ContextDatabase({ exec, schema: searchSchema });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello wor").eq("channel", "x"))
            .take(5);

        const matchStatement = statements.find((statement) => statement.sql.includes(" MATCH "));

        expect(matchStatement?.sql).toBe(
            'SELECT m.* FROM "docs__fts_by_body" f JOIN "docs" m ON m."id" = f."__id__" WHERE f."__text__" MATCH ? AND m."channel" = ? ORDER BY f.rank, m."_creationTime" DESC LIMIT 5',
        );
        expect(matchStatement?.params).toStrictEqual(['"hello" AND "wor"*', "x"]);

        // The reader preserves the DB's rank ordering and decodes the rows.
        expect(results.map((document) => document["_id"])).toStrictEqual(["d1", "d2"]);
    });
});
