import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import { backfillD1SearchIndexes, createD1CtxDb as createD1ContextDatabase, runD1SearchMigrations } from "../src/d1-ctx-db";

/**
 * The FTS5 production path can't run under `node:sqlite` (no fts5 module), so
 * this asserts the *emitted SQL* against the D1 column dialect instead of its
 * results: a recording `D1Exec` double that reports FTS5 available (the
 * create/drop probe succeeds), returns canned rows for the vocabulary read, and
 * captures every statement + params. We verify the virtual-table DDL, the
 * delete-then-insert write sync, and the MATCH/JOIN/ORDER-BY-rank search query.
 * Behavioral correctness of the query surface is covered by the LIKE-scan suite
 * in `d1-ctx-db.search.test.ts`. The D1 twin of `@lunora/do`'s
 * `ctx-db.search.fts.test.ts`.
 */

interface Recorded {
    params: ReadonlyArray<unknown>;
    sql: string;
}

/** A canned MATCH/by-id row in the D1 column-per-field shape (no `__doc__` blob). */
interface MatchRow {
    /** The analyzed token stream the fts5 shadow stores, which the reader re-scores. */
    __text__?: string;
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

        // A vocabulary-scored search returns the canned result set so the reader can decode
        // and order it. The id-probe and by-id reads resolve to the canned rows
        // so the patch/delete table-resolution path (`tableNameFromId` +
        // `rawRow`) reaches the FTS write-sync. The OCC-guarded UPDATE/DELETE
        // (`RETURNING "id"`) reports one changed row so the CAS passes.
        const routes: { pattern: RegExp; rows: () => Record<string, unknown>[] }[] = [
            { pattern: /__fts_by_body__vocab/u, rows: () => matchRows as unknown as Record<string, unknown>[] },
            // The read path refuses an index that is still backfilling, and this
            // double answers every unrouted SELECT with `[]` — so without a row
            // here the progress table reads as "nothing recorded" and every
            // search below is refused. These tests are about the emitted SQL,
            // not about backfill progress: report the index as complete.
            { pattern: /FROM "__lunora_search_state"/u, rows: () => [{ covered: 1, cursor: null, done: 1, profile: null }] },
            // The migration-time backfill probes for the source table and then
            // pages through it; the canned rows stand in for a table that
            // already held data when the search index was declared.
            { pattern: /^SELECT name FROM sqlite_master WHERE type = 'table' AND name = \?$/u, rows: () => [{ name: "docs" }] },
            // "Does the table hold rows?" — a `staged` index is only skipped by
            // the migration pass when it does; over an empty table the pass
            // walks it (finding nothing) so the index records coverage instead
            // of refusing every search forever.
            { pattern: /^SELECT 1 FROM "docs" LIMIT 1$/u, rows: () => (matchRows.length > 0 ? [{ 1: 1 }] : []) },
            { pattern: /^SELECT \* FROM "docs" ORDER BY/u, rows: () => matchRows as unknown as Record<string, unknown>[] },
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
        // The last shadow INSERT is the write sync; earlier ones belong to the
        // migration-time backfill (here just its "backfilled" sentinel).
        const add = statements.findLast((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(remove?.params).toStrictEqual(["d1"]);
        expect(add?.params).toStrictEqual(["hello world", "d1"]);
    });

    it("backfills rows that predate the search index", async () => {
        expect.assertions(1);

        const { exec, statements } = createRecordingFts([
            { _creationTime: 1, body: "hello world", channel: "x", id: "d1", title: "first" },
            { _creationTime: 2, body: "hello words", channel: "x", id: "d2", title: "second" },
        ]);

        await runD1SearchMigrations(exec, searchSchema);

        const inserts = statements.filter((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(inserts.map((statement) => statement.params)).toStrictEqual([
            ["hello world", "d1"],
            ["hello words", "d2"],
        ]);
    });

    it("leaves a staged search index empty until the out-of-band backfill runs", async () => {
        expect.assertions(3);

        const stagedSchema: SchemaLike = {
            tables: {
                docs: {
                    ...searchSchema.tables["docs"]!,
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body", staged: true }],
                },
            },
        };
        const { exec, statements } = createRecordingFts([{ _creationTime: 1, body: "hello world", channel: "x", id: "d1", title: "first" }]);

        await runD1SearchMigrations(exec, stagedSchema);

        expect(
            statements.some(
                (statement) => statement.sql === 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs__fts_by_body" USING fts5("__text__", "__id__" UNINDEXED)',
            ),
        ).toBe(true);
        expect(statements.some((statement) => statement.sql.startsWith('INSERT INTO "docs__fts_by_body"'))).toBe(false);

        // …until the host runs the explicit backfill.
        await backfillD1SearchIndexes(exec, stagedSchema);

        const inserts = statements.filter((statement) => statement.sql === 'INSERT INTO "docs__fts_by_body" ("__text__", "__id__") VALUES (?, ?)');

        expect(inserts.map((statement) => statement.params)).toStrictEqual([["hello world", "d1"]]);
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

    it("scores in SQL from the vocabulary view, bounded by the caller's limit", async () => {
        expect.assertions(4);

        const matchRows: MatchRow[] = [
            { __text__: "hello world", _creationTime: 1, body: "hello world", channel: "x", id: "d1", title: "first" },
            { __text__: "hello words wordy world", _creationTime: 2, body: "hello words wordy world", channel: "x", id: "d2", title: "second" },
        ];
        const { exec, statements } = createRecordingFts(matchRows);

        await runD1SearchMigrations(exec, searchSchema);

        const writer = createD1ContextDatabase({ exec, schema: searchSchema });

        await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello wor").eq("channel", "x"))
            .take(5);

        const read = statements.find((statement) => statement.sql.includes("__vocab") && statement.sql.startsWith("SELECT"));

        // One branch per term — exact for every term but the last, a half-open
        // range for the one still being typed — UNION'd rather than OR'd,
        // because SQLite silently drops a range OR'd with an equality here.
        expect(read?.sql).toContain('FROM "docs__fts_by_body__vocab" WHERE "term" = ?');
        expect(read?.sql).toContain('WHERE "term" >= ? AND "term" < ?');
        // The caller's limit bounds the read directly — no bm25 window, nothing
        // re-ranked in memory — because the score is summed per term in SQL.
        expect(read?.sql).toContain('ORDER BY s."__score__" DESC, m."_creationTime" DESC, m."id" ASC LIMIT 5');
        expect(read?.params).toStrictEqual(["hello", "wor", "wos", "x"]);
    });
});
