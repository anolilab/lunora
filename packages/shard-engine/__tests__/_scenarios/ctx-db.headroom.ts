/**
 * Wiring test for the per-transaction meter: a runaway read or write through
 * the real `ctx.db` must be stopped with an attributable error rather than
 * being allowed to exhaust the isolate.
 */
import { isLunoraError } from "@lunora/errors";
import { beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../../src/ctx-db";
import { TransactionHeadroomTracker } from "../../src/transaction-headroom";
import type { SqlHarness } from "../_helpers/sql-harness";

/** The harness factory of the project running this scenario — see {@link runHeadroomScenarios}. */
let createHarness: () => SqlHarness;

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

/**
 * The `ctx-db.headroom` suite, over whichever SQLite the caller's harness opens:
 * `node:sqlite` from `../ctx-db.headroom.test.ts`, a Durable Object's `state.storage.sql`
 * from `../workerd/ctx-db.headroom.workerd.test.ts`.
 */
const runHeadroomScenarios = (factory: () => SqlHarness): void => {
    createHarness = factory;

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
            sql = createHarness().sql;
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

        it("charges a filtered page by the rows it scanned, not the page it returned", async () => {
            expect.assertions(1);

            const seed = build({ maxWrittenRows: 100 });

            for (let index = 0; index < 30; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await seed.insert("notes", { body: index === 0 ? "keep" : "drop", bucket: "a" });
            }

            // A filtered page skips the SQL LIMIT, so it scans the whole table to
            // fill one row — the meter must see the scan, not the page.
            const reader = build({ maxReadRows: 5 });

            await expect(
                codeOf(async () =>
                    reader
                        .query("notes")
                        .withIndex("by_bucket", (q) => q.eq("bucket", "a"))
                        .filter((row) => row["body"] === "keep")
                        .paginate({ numItems: 1 }),
                ),
            ).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
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

    describe("the .global() branches", () => {
        // These return before `onWrite`, so each charges the meter itself. They also
        // write into D1, which the DO's transaction cannot roll back — so the charge
        // has to land BEFORE the boundary or a breach commits the row it refused.
        const globalSchema: SchemaLike = {
            tables: {
                profiles: {
                    indexes: [],
                    shape: { name: { kind: "string" } },
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        /** A D1 double that records which writes actually crossed the boundary. */
        const globalDouble = (crossed: string[], gate?: Promise<void>): DatabaseWriterLike =>
            ({
                delete: async () => {
                    crossed.push("delete");
                },
                insert: async (_table: string, document: Record<string, unknown>) => {
                    // Optionally hold the write open, so a test can interleave another
                    // operation on the same writer while this one is mid-await.
                    await gate;
                    crossed.push(`insert:${String(document["name"])}`);

                    return `p_${String(crossed.length)}`;
                },
                patch: async () => {
                    crossed.push("patch");
                },
                replace: async () => {
                    crossed.push("replace");
                },
            }) as unknown as DatabaseWriterLike;

        const writerWithCeiling = (crossed: string[], maxWrittenRows: number, globalDb = globalDouble(crossed)): DatabaseWriterLike => {
            const { sql } = createHarness();

            runShardMigrations(sql, globalSchema);

            return createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb,
                headroom: new TransactionHeadroomTracker({ maxWrittenRows }),
                schema: globalSchema,
                sql,
            });
        };

        it.each(["patch", "replace", "delete"] as const)("charges %s and refuses past the ceiling before D1 sees it", async (operation) => {
            expect.assertions(3);

            const crossed: string[] = [];
            // A one-row ceiling: the first write spends it, the second must be refused.
            const writer = writerWithCeiling(crossed, 1);
            const call = async (): Promise<unknown> =>
                operation === "delete" ? writer.delete("profiles", "p_absent") : writer[operation]("profiles", "p_absent", { name: "n" });

            await call();

            expect(crossed).toStrictEqual([operation]);
            await expect(codeOf(call)).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            // Refused before the boundary: D1 never saw the second write.
            expect(crossed).toStrictEqual([operation]);
        });

        it("charges a global insertMany once per row, up front, before any row crosses", async () => {
            expect.assertions(3);

            const crossed: string[] = [];
            // Room for two rows; the batch asks for three.
            const writer = writerWithCeiling(crossed, 2);
            const rows = [{ name: "a" }, { name: "b" }, { name: "c" }];

            await expect(codeOf(async () => writer.insertMany!("profiles", rows))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            // The whole batch is charged before the loop, so nothing reached D1 —
            // which the DO's storage transaction could not have rolled back.
            expect(crossed).toStrictEqual([]);

            // And a batch that fits is charged exactly once per row, not twice: two
            // rows against a two-row ceiling must pass.
            const fits: string[] = [];

            await expect(writerWithCeiling(fits, 2).insertMany!("profiles", [{ name: "a" }, { name: "b" }])).resolves.toHaveLength(2);
        });

        it.each(["per id", "batch"] as const)("charges a global deleteWhere (%s) once per row, up front, before any row crosses", async (path) => {
            expect.assertions(3);

            /** Three matching rows, deleted one id at a time or through the D1 writer's batch delete. */
            const matching = (crossed: string[]): DatabaseWriterLike => {
                const deleteMany = async (_table: string, ids: ReadonlyArray<string>): Promise<{ deleted: number }> => {
                    crossed.push(`deleteMany:${String(ids.length)}`);

                    return { deleted: ids.length };
                };

                return {
                    ...globalDouble(crossed),
                    ...(path === "batch" ? { deleteMany } : {}),
                    findMany: async () => {
                        return { continueCursor: null, isDone: true, page: [{ _id: "p1" }, { _id: "p2" }, { _id: "p3" }] };
                    },
                };
            };
            const crossed: string[] = [];
            // Room for two rows; the match is three.
            const writer = writerWithCeiling(crossed, 2, matching(crossed));

            await expect(codeOf(async () => writer.deleteWhere!("profiles", {}))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            // The whole match is charged before the first delete, so nothing reached D1.
            expect(crossed).toStrictEqual([]);

            // And a match that fits is charged exactly once per row: three rows against a three-row ceiling pass.
            const fits: string[] = [];

            await expect(writerWithCeiling(fits, 3, matching(fits)).deleteWhere!("profiles", {})).resolves.toStrictEqual({ deleted: 3 });
        });

        it("keeps a concurrent write metered while a global insert is in flight", async () => {
            expect.assertions(2);

            // The batch pre-charges its rows and suppresses the per-row charge on the
            // way out. Done with a writer-wide flag, that suppression would also
            // exempt anything interleaved into the await — so a sibling write on the
            // same writer would slip past the ceiling entirely.
            let release = (): void => undefined;
            const gate = new Promise<void>((resolve) => {
                release = () => {
                    resolve();
                };
            });
            const crossed: string[] = [];
            const { sql } = createHarness();

            runShardMigrations(sql, globalSchema);

            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                globalDb: globalDouble(crossed, gate),
                // One row of room: the batch's single row spends it, so the sibling
                // write racing alongside it must be refused.
                headroom: new TransactionHeadroomTracker({ maxWrittenRows: 1 }),
                schema: globalSchema,
                sql,
            });

            const batch = writer.insertMany!("profiles", [{ name: "a" }]);
            const sibling = codeOf(async () => writer.insert("profiles", { name: "sibling" }));

            release();

            await batch;

            await expect(sibling).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            // The refused sibling never crossed; only the batch's row did.
            expect(crossed).toStrictEqual(["insert:a"]);
        });
    });
};

export default runHeadroomScenarios;
