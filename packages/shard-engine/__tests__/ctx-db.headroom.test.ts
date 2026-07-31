/**
 * Wiring test for the per-transaction meter: a runaway read or write through
 * the real `ctx.db` must be stopped with an attributable error rather than
 * being allowed to exhaust the isolate.
 */
import { DatabaseSync } from "node:sqlite";

import { isLunoraError } from "@lunora/errors";
import { beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { TransactionHeadroomTracker } from "../src/transaction-headroom";

interface NodeStatement {
    all: (...params: unknown[]) => Record<string, unknown>[];
}

const makeSql = (): SqlExec => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: <Row = Record<string, unknown>>(sqlText: string, ...params: unknown[]) => {
            const stmt = database.prepare(sqlText) as unknown as NodeStatement;
            const rows = stmt.all(...params) as unknown as Row[];

            return {
                one: () => rows[0] as Row,
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                toArray: () => rows,
            };
        },
    };
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [{ fields: ["bucket"], name: "by_bucket" }],
            shape: {
                body: { kind: "string" },
                bucket: { kind: "string" },
            },
        },
    },
};

/**
 * Narrow the writer's optional batch primitive. It is optional on the interface
 * because the global/D1 twin has no batch path; the shard writer always
 * implements it. Lives out here so the guard is not a conditional inside a test.
 */
const batchInsert = (writer: DatabaseWriterLike): NonNullable<DatabaseWriterLike["insertManyUnsafe"]> => {
    const { insertManyUnsafe } = writer;

    if (!insertManyUnsafe) {
        throw new Error("expected the shard writer to implement insertManyUnsafe");
    }

    return insertManyUnsafe;
};

/** The error code from awaiting `act`, or undefined when it resolved. */
const codeOf = async (act: () => Promise<unknown>): Promise<string | undefined> => {
    try {
        await act();
    } catch (error) {
        return isLunoraError(error) ? error.code : "NOT_A_LUNORA_ERROR";
    }

    return undefined;
};

describe("ctx-db transaction headroom", () => {
    let sql: SqlExec;

    const build = (limits: Partial<ConstructorParameters<typeof TransactionHeadroomTracker>[0]>): DatabaseWriterLike =>
        createShardContextDatabase({
            clock: () => 1_700_000_000_000,
            headroom: new TransactionHeadroomTracker(limits),
            schema,
            sql,
        });

    beforeEach(() => {
        sql = makeSql();
        runShardMigrations(sql, schema);
    });

    it("stops a write loop once it crosses the row ceiling", async () => {
        expect.assertions(1);

        const writer = build({ maxWrittenRows: 3 });

        const code = await codeOf(async () => {
            for (let index = 0; index < 100; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- the point is a sequential runaway loop
                await writer.insert("notes", { body: "b", bucket: "a" });
            }
        });

        expect(code).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("stops a write loop on total bytes even when the row count is fine", async () => {
        expect.assertions(1);

        const writer = build({ maxWrittenBytes: 512, maxWrittenRows: 1_000_000 });

        const code = await codeOf(async () => {
            for (let index = 0; index < 100; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design
                await writer.insert("notes", { body: "x".repeat(200), bucket: "a" });
            }
        });

        expect(code).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("charges an indexed fluent read by the rows it returned", async () => {
        expect.assertions(1);

        const seed = build({ maxWrittenRows: 100 });

        for (let index = 0; index < 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic seed order
            await seed.insert("notes", { body: "b", bucket: "a" });
        }

        // The fluent reader stamps one range dep, not one per row, so this is
        // the path a naive dep-counting meter would miss entirely.
        const reader = build({ maxReadRows: 5 });
        const code = await codeOf(async () =>
            reader
                .query("notes")
                .withIndex("by_bucket", (q) => q.eq("bucket", "a"))
                .collect(),
        );

        expect(code).toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("charges a batch insert once, not once per meter hook", async () => {
        expect.assertions(1);

        // Regression: the batch is pre-charged before the multi-row INSERT, and
        // the per-row `onWrite` fan-out used to charge it a SECOND time —
        // halving the effective ceiling and failing legitimate batches.
        const writer = build({ maxWrittenRows: 6 });
        const rows = Array.from({ length: 5 }, () => {
            return { body: "b", bucket: "a" };
        });

        await expect(batchInsert(writer)("notes", rows)).resolves.toHaveLength(5);
    });

    it("charges a full-table scan by the rows it materialized", async () => {
        expect.assertions(1);

        const seed = build({ maxWrittenRows: 100 });

        for (let index = 0; index < 20; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic seed order
            await seed.insert("notes", { body: "b", bucket: "a" });
        }

        // A full scan stamps ONE `*scan` dep rather than a dep per row, so a
        // meter counting dependency stamps would see nothing at all here.
        const reader = build({ maxReadRows: 5 });

        await expect(codeOf(async () => reader.findMany("notes", {}))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
    });

    it("leaves a transaction within its ceilings untouched", async () => {
        expect.assertions(2);

        const writer = build({ maxReadRows: 100, maxWrittenRows: 100 });

        await writer.insert("notes", { body: "b", bucket: "a" });

        const rows = await writer
            .query("notes")
            .withIndex("by_bucket", (q) => q.eq("bucket", "a"))
            .collect();

        expect(rows).toHaveLength(1);
        await expect(writer.insert("notes", { body: "c", bucket: "a" })).resolves.toBeDefined();
    });
});
