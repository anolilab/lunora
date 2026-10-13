import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSqlGlobalTableMigrations } from "../src/ctx-db-migrations";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Adding a REQUIRED field to a `.global()` table that already holds rows. The ALTER is always nullable (a NOT NULL
 * add is rejected on a populated table), so existing rows must be given the field's declared default or they read
 * NULL for a field the validator says is never null.
 */
const col = (kind: string, column: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const OLD: SchemaLike = { tables: { notes: { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } } } };

const withFields = (fields: Record<string, ValidatorLike>): SchemaLike => {
    return {
        tables: { notes: { indexes: [], shape: { body: col("string"), ...fields }, shardMode: { kind: "global" } } },
    };
};

describe("adding a required field to a populated .global() table", () => {
    let harness: ReturnType<typeof createSqliteHarness>;
    const dialect = makeSqliteDialect();

    /** The named columns of every row, in id order. */
    const pick = async (...fields: string[]): Promise<unknown[][]> => {
        const all = await harness.exec.all('SELECT * FROM "notes" ORDER BY "id"', []);

        return all.map((row) => fields.map((field) => row[field]));
    };

    beforeEach(async () => {
        harness = createSqliteHarness();

        await runSqlGlobalTableMigrations(harness.exec, OLD, dialect);
        await harness.exec.run('INSERT INTO "notes" ("id", "_creationTime", "body") VALUES (?, ?, ?), (?, ?, ?)', ["a", 1, "x", "b", 2, "y"]);
    });

    afterEach(() => {
        harness.close();
        vi.restoreAllMocks();
    });

    it("writes the declared default into the rows that predate the field", async () => {
        expect.assertions(1);

        await runSqlGlobalTableMigrations(
            harness.exec,
            withFields({ priority: col("number", { defaultValue: 3 }), stamp: col("number", { defaultFn: () => 1234 }) }),
            dialect,
        );

        await expect(pick("priority", "stamp")).resolves.toStrictEqual([
            [3, 1234],
            [3, 1234],
        ]);
    });

    it("leaves a field that may hold null alone", async () => {
        expect.assertions(1);

        await runSqlGlobalTableMigrations(
            harness.exec,
            withFields({ maybe: col("number", { defaultValue: 3, notNull: false }), optional: { _meta: { column: { notNull: true } }, kind: "optional" } }),
            dialect,
        );

        await expect(pick("maybe", "optional")).resolves.toStrictEqual([
            [null, null],
            [null, null],
        ]);
    });

    it("warns once, and does not invent a value, for a required field with no default", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await runSqlGlobalTableMigrations(harness.exec, withFields({ title: col("string") }), dialect);

        await expect(pick("title")).resolves.toStrictEqual([[null], [null]]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("notes.title");
    });

    it("does nothing to a field the table already has", async () => {
        expect.assertions(1);

        await runSqlGlobalTableMigrations(harness.exec, withFields({ priority: col("number", { defaultValue: 3 }) }), dialect);
        await harness.exec.run('UPDATE "notes" SET "priority" = ? WHERE "id" = ?', [9, "a"]);
        await runSqlGlobalTableMigrations(harness.exec, withFields({ priority: col("number", { defaultValue: 3 }) }), dialect);

        await expect(pick("priority")).resolves.toStrictEqual([[9], [3]]);
    });
});
