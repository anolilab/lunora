import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aggregateTableName } from "../src/aggregate-tally";
import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Outside a transaction (an action) every `insertManyUnsafe` chunk is its own
 * commit, and inside one a mutation that catches the failure commits the
 * earlier chunks too. Whatever lands has to carry its companions and its write
 * notification, or the aggregate, rank and search indexes disagree with the
 * table for good.
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

describe("insertManyUnsafe — a later chunk fails", () => {
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

    it("indexes the committed rows when a mutation catches the failure and its transaction commits", async () => {
        expect.assertions(5);

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

        // The handler swallows the error, so nothing rolls the first chunk back.
        await expect(writer.insertManyUnsafe?.("items", documents, { allowExplicitId: true })).rejects.toThrow('unique constraint violation on "items"');

        harness.sql.exec("COMMIT");

        const onDisk = harness.sql
            .exec("SELECT id FROM items")
            .toArray()
            .map((row) => row["id"] as string);
        const counted = harness.sql.exec(`SELECT SUM(__value__) AS total FROM ${aggregateTableName("items", "count_by_bucket")}`).toArray()[0]?.["total"];

        expect(onDisk).toHaveLength(33);
        expect(Number(counted)).toBe(onDisk.length);

        const ranked = await writer.rankPage("items", "by_score", { take: ROWS });

        expect(sortedIds(ranked.page.map((row) => row["_id"]))).toStrictEqual(sortedIds(onDisk));
        expect(sortedIds(reported)).toStrictEqual(sortedIds(onDisk));
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
