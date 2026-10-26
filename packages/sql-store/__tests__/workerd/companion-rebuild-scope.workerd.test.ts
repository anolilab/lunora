/**
 * The aggregate/rank companion rebuild and the pinned by-id write path, against a **real** D1 binding in workerd.
 *
 * What is under test is which statements reach D1, where each is a network round trip from the Worker: a
 * rebuild (a scan of the table plus a rewrite of the companion) runs once per `provisionScope`, not once per
 * writer, and a pinned write reads the row without a `SELECT 1` probe ahead of it. Each test owns its table
 * names: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike } from "@lunora/shard-engine";
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

        await writer.patch(id, { body: "b" }, table);
        await writer.delete(id, table);

        expect(statements.filter((statement) => statement.startsWith("SELECT 1 FROM"))).toStrictEqual([]);
        await expect(writer.get(table, id)).resolves.toBeNull();
    });
});
