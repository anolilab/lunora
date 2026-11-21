import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregateTableName } from "../src/aggregate-tally";
import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Outside a transaction (an action) every `insertManyUnsafe` chunk is its own
 * commit, so a later chunk failing cannot take the earlier ones back. Whatever
 * did land has to carry its companions and its write notification, or the
 * aggregate, rank and search indexes disagree with the table for good.
 */
const schema: SchemaLike = {
    tables: {
        items: {
            aggregateIndexes: [{ by: ["bucket"], name: "count_by_bucket", on: "items", op: "count" }],
            indexes: [],
            rankIndexes: [{ name: "by_score", on: "items", sortBy: [{ direction: "desc", field: "score" }] }],
            searchIndexes: [{ field: "body", name: "by_body" }],
            shape: { body: { kind: "string" }, bucket: { kind: "string" }, score: { kind: "number" } },
        },
    },
} as unknown as SchemaLike;

/** More rows than one multi-row INSERT carries (`INSERT_CHUNK_ROWS` is 33), with a duplicate `_id` in the second chunk. */
const ROWS = 40;
const DUPLICATE_AT = 35;

const sortedIds = (ids: ReadonlyArray<unknown>): string[] => ids.map(String).toSorted((left, right) => left.localeCompare(right));

describe("insertManyUnsafe — a later chunk fails outside a transaction", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("leaves every committed row with its companions and its write report", async () => {
        expect.assertions(6);

        runShardMigrations(harness.sql, schema);

        const reported: string[] = [];
        const writer = createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            onWrite: (event) => {
                reported.push(event.id);
            },
            schema,
            sql: harness.sql,
        });

        const documents = Array.from({ length: ROWS }, (_, index) => {
            return { _id: index === DUPLICATE_AT ? "r0" : `r${String(index)}`, body: "hello", bucket: "b", score: index };
        });

        await expect(writer.insertManyUnsafe?.("items", documents, { allowExplicitId: true })).rejects.toThrow('unique constraint violation on "items"');

        const onDisk = harness.sql
            .exec("SELECT id FROM items")
            .toArray()
            .map((row) => row["id"] as string);
        const counted = harness.sql.exec(`SELECT SUM(__value__) AS total FROM ${aggregateTableName("items", "count_by_bucket")}`).toArray()[0]?.["total"];
        const ranked = await writer.rankPage("items", "by_score", { take: ROWS });
        const found = await writer
            .query("items")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .collect();

        // The first chunk committed on its own; the failing one wrote nothing.
        expect(onDisk).toHaveLength(33);
        expect(Number(counted)).toBe(onDisk.length);
        expect(sortedIds(ranked.page.map((row) => row["_id"]))).toStrictEqual(sortedIds(onDisk));
        expect(sortedIds(found.map((row) => row["_id"]))).toStrictEqual(sortedIds(onDisk));
        expect(sortedIds(reported)).toStrictEqual(sortedIds(onDisk));
    });

    it("leaves a transaction's failed batch to the rollback: nothing is caught up or reported", async () => {
        expect.assertions(4);

        runShardMigrations(harness.sql, schema);

        const reported: string[] = [];
        const writer = createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            inTransaction: () => true,
            onWrite: (event) => {
                reported.push(event.id);
            },
            schema,
            sql: harness.sql,
        });

        const documents = Array.from({ length: ROWS }, (_, index) => {
            return { _id: index === DUPLICATE_AT ? "r0" : `r${String(index)}`, body: "hello", bucket: "b", score: index };
        });

        harness.sql.exec("BEGIN");

        await expect(writer.insertManyUnsafe?.("items", documents, { allowExplicitId: true })).rejects.toThrow('unique constraint violation on "items"');

        harness.sql.exec("ROLLBACK");

        // The storage transaction undoes the first chunk; the writer must not have announced it.
        expect(reported).toStrictEqual([]);
        expect(harness.sql.exec("SELECT COUNT(*) AS n FROM items").toArray()[0]?.["n"]).toBe(0);
        expect(harness.sql.exec(`SELECT COUNT(*) AS n FROM ${aggregateTableName("items", "count_by_bucket")}`).toArray()[0]?.["n"]).toBe(0);
    });

    it("keeps the insert error and catches up every committed row when one row's catch-up fails", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, schema);

        const reported: string[] = [];
        const writer = createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            onWrite: (event) => {
                if (event.id === "r1") {
                    throw new Error("write hook failed");
                }

                reported.push(event.id);
            },
            schema,
            sql: harness.sql,
        });

        const documents = Array.from({ length: ROWS }, (_, index) => {
            return { _id: index === DUPLICATE_AT ? "r0" : `r${String(index)}`, body: "hello", bucket: "b", score: index };
        });

        await expect(writer.insertManyUnsafe?.("items", documents, { allowExplicitId: true })).rejects.toThrow('unique constraint violation on "items"');

        // Every committed row but the one whose hook threw was still reported.
        expect(reported).toHaveLength(32);
    });
});
