import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ColumnMetaLike, SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

/**
 * A column-level server default on `_id` replaces the id a supplied `_id` would have
 * been stored under. The batch preflight must check the id that is stored, as the
 * single-row insert does, so a valid stored id is not refused for an invalid input id.
 */
const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                _id: col("string", { serverDefault: () => "stored-id" }),
                title: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

describe("insertManyUnsafe checks the id each row is stored under", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema);
    });

    afterEach(() => {
        harness.close();
    });

    it("accepts a batch whose supplied id is refused in favour of a valid server-defaulted id", async () => {
        expect.assertions(1);

        const writer = createShardCtxDb({ clock: () => 1, schema, sql: harness.sql });

        const ids = await writer.insertManyUnsafe!("notes", [{ _id: "bad\u0000id", title: "hi" }], { allowExplicitId: true });

        expect(ids).toStrictEqual(["stored-id"]);
    });
});

describe("insertManyUnsafe applies column defaults once per row", () => {
    it("does not run an ordinary server default twice for a trusted batch", async () => {
        expect.assertions(2);

        let calls = 0;
        const countingSchema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    shape: {
                        owner: col("string", {
                            serverDefault: () => {
                                calls += 1;

                                return "owner";
                            },
                        }),
                        title: col("string"),
                    },
                },
            },
        };
        const harness2 = createSqliteExec();

        try {
            runShardMigrations(harness2.sql, countingSchema);

            const writer = createShardCtxDb({ clock: () => 1, schema: countingSchema, sql: harness2.sql });

            await writer.insertManyUnsafe!(
                "notes",
                [
                    { _id: "n1", title: "a" },
                    { _id: "n2", title: "b" },
                ],
                { allowExplicitId: true },
            );

            expect(calls).toBe(2);
            await expect(writer.get("n2")).resolves.toMatchObject({ owner: "owner" });
        } finally {
            harness2.close();
        }
    });
});

describe("insertManyUnsafe checks the id it stores, from one evaluation of its default", () => {
    it("stores the id it checked when the _id default is stateful", async () => {
        expect.assertions(2);

        let calls = 0;
        const statefulSchema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    shape: {
                        _id: col("string", {
                            serverDefault: () => {
                                calls += 1;

                                return calls === 1 ? "good-id" : "bad\u0000id";
                            },
                        }),
                        title: col("string"),
                    },
                },
            },
        };
        const harness3 = createSqliteExec();

        try {
            runShardMigrations(harness3.sql, statefulSchema);

            const writer = createShardCtxDb({ clock: () => 1, schema: statefulSchema, sql: harness3.sql });

            const ids = await writer.insertManyUnsafe!("notes", [{ _id: "x", title: "a" }], { allowExplicitId: true });

            expect(ids).toStrictEqual(["good-id"]);
            expect(calls).toBe(1);
        } finally {
            harness3.close();
        }
    });
});
