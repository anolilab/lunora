/**
 * The aggregate/rank companion rebuild, the pinned by-id write path and the changed-tables poll, against a
 * **real** D1 binding in workerd.
 *
 * What is under test is which statements reach D1, where each is a network round trip from the Worker: a
 * rebuild (a scan of the table plus a rewrite of the companion) runs once per `provisionScope`, not once per
 * writer, and a pinned write reads the row without a `SELECT 1` probe ahead of it. The poll's plan is asked of
 * D1 itself, which plans without statistics like `node:sqlite` but is the engine that bills the rows read.
 * Each test owns its table names: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import { col, d1Dialect, d1Exec } from "./_helpers/d1";

const recording = (): { exec: SqlCtxExec; statements: string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: (query, parameters) => {
                statements.push(query);

                return d1Exec.all(query, parameters);
            },
            run: (query, parameters) => {
                statements.push(query);

                return d1Exec.run(query, parameters);
            },
        },
        statements,
    };
};

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: {
                aggregateIndexes: [{ by: ["org"], name: "by_org", on: table, op: "count" }],
                indexes: [],
                rankIndexes: [{ name: "by_score", on: table, partitionBy: ["org"], sortBy: [{ direction: "desc", field: "score" }] }],
                shape: { org: col("string"), score: col("number") },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

/** A whole-companion truncate: the first step of a rebuild, and only of a rebuild. */
const isRebuild = (statement: string): boolean => /^DELETE FROM "[^"]+"$/u.test(statement.trim());

describe("companion rebuilds and pinned writes on D1", () => {
    it("rebuilds once per scope, and a later writer's deltas keep the companions exact", async () => {
        expect.assertions(4);

        const table = "rebuild_scope_notes";
        const schema = schemaFor(table);
        const provisionScope = {};
        const first = createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec: d1Exec, provisionScope, schema });

        await first.insert(table, { org: "a", score: 1 });

        const { exec, statements } = recording();
        const second = createSqlCtxDb({ clock: () => 2, dialect: d1Dialect, exec, provisionScope, schema });
        const id = await second.insert(table, { org: "a", score: 5 });

        await expect(second.count(table, { org: "a" })).resolves.toBe(2);
        await expect(second.rank(table, "by_score", { row: id })).resolves.toStrictEqual({ position: 1, total: 2 });

        expect(statements.filter((statement) => isRebuild(statement))).toStrictEqual([]);
        expect(statements.filter((statement) => statement.startsWith("SELECT 1 FROM"))).toStrictEqual([]);
    });

    it("single-flights concurrent first callers onto one rebuild", async () => {
        expect.assertions(2);

        const table = "rebuild_flight_notes";
        const schema = schemaFor(table);

        await createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec: d1Exec, schema }).insert(table, { org: "a", score: 1 });

        const provisionScope = {};
        const { exec, statements } = recording();
        const writers = [0, 1].map(() => createSqlCtxDb({ clock: () => 2, dialect: d1Dialect, exec, provisionScope, schema }));

        await expect(Promise.all(writers.map((writer) => writer.count(table, { org: "a" })))).resolves.toStrictEqual([1, 1]);

        expect(statements.filter((statement) => isRebuild(statement))).toHaveLength(1);
    });

    it("patches and deletes a pinned row without probing for its id first", async () => {
        expect.assertions(2);

        const table = "pinned_write_notes";
        const schema = { tables: { [table]: { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } } } } as never;
        const { exec, statements } = recording();
        const writer = createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec, schema });
        const id = await writer.insert(table, { body: "a" });

        await writer.patch(table, id, { body: "b" });
        await writer.delete(table, id);

        expect(statements.filter((statement) => statement.startsWith("SELECT 1 FROM"))).toStrictEqual([]);
        await expect(writer.get(table, id)).resolves.toBeNull();
    });

    it("polls changed tables with one index seek per table, not a walk of the whole log", async () => {
        expect.assertions(3);

        const tables = ["poll_alpha", "poll_beta"];
        const schema = {
            tables: Object.fromEntries(tables.map((table) => [table, { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } }])),
        } as never;

        await createSqlCtxDb({ cdc: true, clock: () => 1, dialect: d1Dialect, exec: d1Exec, schema }).count("poll_alpha");

        const append = env.DB.prepare(`INSERT INTO "__cdc_log" ("ts", "table", "id", "op", "doc") VALUES (?, ?, ?, 'insert', '{}')`);

        await env.DB.batch(Array.from({ length: 400 }, (_, index) => append.bind(index, tables[index % tables.length] as string, `x${String(index)}`)));

        const head = await env.DB.prepare(`SELECT MAX(seq) AS seq FROM "__cdc_log"`).first<{ seq: number }>();
        const since = (head?.seq ?? 0) - 3;
        const { exec, statements } = recording();
        const changed = await createSqlCtxDb({ cdc: true, clock: () => 1, dialect: d1Dialect, exec, schema }).cdcChangedTables?.(since);
        const poll = statements.find((statement) => statement.includes("WITH RECURSIVE")) as string;
        const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${poll}`).bind(since).all<{ detail: string }>();
        const grouped = await env.DB.prepare(`SELECT "table", MAX(seq) AS seq FROM "__cdc_log" WHERE seq > ? GROUP BY "table"`)
            .bind(since)
            .all<{ table: string }>();

        expect(changed?.tables).toStrictEqual(grouped.results.map((row) => row.table));
        expect(plan.results.some((step) => step.detail.includes("(table=? AND seq>?)"))).toBe(true);
        expect(plan.results.filter((step) => step.detail.startsWith("SCAN __cdc_log"))).toStrictEqual([]);
    });
});
