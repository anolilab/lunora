/**
 * Wiring test for the per-transaction meter: a runaway read or write through
 * the real `ctx.db` must be stopped with an attributable error rather than
 * being allowed to exhaust the isolate.
 */
import { isLunoraError } from "@lunora/errors";
import { beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, meterReadBytes, runShardMigrations } from "../../src/ctx-db";
import { isFtsAvailable } from "../../src/do-sql";
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

        it("stops a read on total bytes even when the row count is fine", async () => {
            expect.assertions(1);

            const seed = build({ maxWrittenRows: 100 });

            for (let index = 0; index < 20; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await seed.insert("notes", { body: "x".repeat(200), bucket: "a" });
            }

            const reader = build({ maxReadBytes: 2000, maxReadRows: 1_000_000 });

            await expect(
                codeOf(async () =>
                    reader
                        .query("notes")
                        .withIndex("by_bucket", (q) => q.eq("bucket", "a"))
                        .collect(),
                ),
            ).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
        });

        it("charges a by-id read by its stored size", async () => {
            expect.assertions(2);

            const id = await build({}).insert("notes", { body: "x".repeat(500), bucket: "a" });
            const tracker = new TransactionHeadroomTracker({ maxReadBytes: 100 });
            const reader = createShardContextDatabase({ clock: () => 1_700_000_000_000, headroom: tracker, schema, sql });

            await expect(codeOf(async () => reader.get("notes", id))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            expect(tracker.headroom().readBytes).toBeGreaterThan(500);
        });

        it("does not charge a write's pre-image probe on top of the read that loaded the row", async () => {
            expect.assertions(1);

            const id = await build({}).insert("notes", { body: "x".repeat(500), bucket: "a" });
            const [stored] = sql.exec<{ __doc__: string }>("SELECT __doc__ FROM notes").toArray();
            const writer = build({ maxReadBytes: Math.floor((stored?.__doc__.length ?? 0) * 1.5) });

            await expect(
                codeOf(async () => {
                    await writer.get("notes", id);
                    await writer.patch("notes", id, { bucket: "b" });
                    await writer.delete("notes", id);
                }),
            ).resolves.toBeUndefined();
        });

        it("charges a conditional patch that hands back a row the transaction never read", async () => {
            expect.assertions(1);

            const id = await build({}).insert("notes", { body: "x".repeat(500), bucket: "a" });
            const writer = build({ maxReadBytes: 100 });

            await expect(codeOf(async () => writer.patchIf?.("notes", id, { patch: { bucket: "b" }, where: { bucket: "not-a" } }))).resolves.toBe(
                "TRANSACTION_LIMIT_EXCEEDED",
            );
        });

        it("charges a document read twice in one transaction once", async () => {
            expect.assertions(1);

            const id = await build({}).insert("notes", { body: "x".repeat(300), bucket: "a" });
            const [stored] = sql.exec<{ __doc__: string }>("SELECT __doc__ FROM notes").toArray();
            const tracker = new TransactionHeadroomTracker();
            const reader = createShardContextDatabase({ clock: () => 1_700_000_000_000, headroom: tracker, schema, sql });

            await reader.get("notes", id);
            await reader.get("notes", id);

            expect(tracker.headroom().readBytes).toBe(stored?.__doc__.length);
        });

        it("charges two different documents that share an id", () => {
            expect.assertions(1);

            const sharing: SqlExec = {
                exec: <Row>() => {
                    const rows = [
                        { __doc__: "aaa", id: "same" },
                        { __doc__: "bbbbb", id: "same" },
                    ] as Row[];

                    return { one: () => rows[0] as Row, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
                },
            };
            const tracker = new TransactionHeadroomTracker();

            meterReadBytes(sharing, tracker).exec("SELECT").toArray();

            expect(tracker.headroom().readBytes).toBe(8);
        });

        it("stops pulling rows from a cursor once the read ceiling is crossed", () => {
            expect.assertions(2);

            let pulled = 0;
            const doc = JSON.stringify({ body: "x".repeat(100) });
            const unbounded: SqlExec = {
                exec: <Row>() => {
                    const rows = function* rowsOf(): Generator<Row> {
                        for (let index = 0; index < 1000; index += 1) {
                            pulled += 1;

                            yield { __doc__: doc, id: `row-${String(index)}` } as Row;
                        }
                    };
                    const cursor = {
                        one: () => undefined as Row,
                        [Symbol.iterator]: rows,
                        toArray: () => [...rows()],
                    };

                    return cursor;
                },
            };
            const metered = meterReadBytes(unbounded, new TransactionHeadroomTracker({ maxReadBytes: doc.length * 3 }));

            expect(() => metered.exec("SELECT").toArray()).toThrow(/TRANSACTION_LIMIT_EXCEEDED|limit/iu);
            // The native `toArray` would have pulled all 1000 before any charge landed.
            expect(pulled).toBeLessThan(10);
        });

        it("charges a patched document once, whatever size the patch leaves it", async () => {
            expect.assertions(1);

            const id = await build({}).insert("notes", { body: "x".repeat(100), bucket: "a" });
            const [stored] = sql.exec<{ __doc__: string }>("SELECT __doc__ FROM notes").toArray();
            const tracker = new TransactionHeadroomTracker();
            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, headroom: tracker, schema, sql });

            await writer.get("notes", id);
            await writer.patch("notes", id, { body: "y".repeat(400) });
            await writer.get("notes", id);

            expect(tracker.headroom().readBytes).toBe(stored?.__doc__.length);
        });

        it("charges equal ids held by two tables separately", async () => {
            expect.assertions(1);

            const twoTables: SchemaLike = { tables: { memos: schema.tables["notes"]!, notes: schema.tables["notes"]! } };

            runShardMigrations(sql, twoTables);

            const id = await build({}).insert("notes", { body: "x".repeat(100), bucket: "a" });

            sql.exec("INSERT INTO memos SELECT * FROM notes");

            const [stored] = sql.exec<{ __doc__: string }>("SELECT __doc__ FROM notes").toArray();
            const tracker = new TransactionHeadroomTracker();
            const reader = createShardContextDatabase({ clock: () => 1_700_000_000_000, headroom: tracker, schema: twoTables, sql });

            await reader.get("notes", id);
            await reader.get("memos", id);

            expect(tracker.headroom().readBytes).toBe((stored?.__doc__.length ?? 0) * 2);
        });

        describe("global tables", () => {
            const globalSchema: SchemaLike = {
                tables: { shared: { indexes: [], shape: { body: { kind: "string" } }, shardMode: { kind: "global" } } },
            };
            const rows = Array.from({ length: 5 }, (_unused, index) => {
                return { _id: `g${String(index)}`, body: "x".repeat(100) };
            });
            const fakeGlobal = {
                findFirst: async () => rows[0] ?? null,
                findMany: async () => {
                    return { continueCursor: null, isDone: true, page: rows };
                },
                get: async (_table: string, id: string) => rows.find((row) => row._id === id) ?? null,
                query: () => {
                    return { collect: async () => rows };
                },
            } as unknown as DatabaseWriterLike;
            const buildGlobal = (tracker: TransactionHeadroomTracker): DatabaseWriterLike =>
                createShardContextDatabase({ clock: () => 1_700_000_000_000, globalDb: fakeGlobal, headroom: tracker, schema: globalSchema, sql });

            it("refuses a global read that loads more than the read ceiling", async () => {
                expect.assertions(3);

                const writer = buildGlobal(new TransactionHeadroomTracker({ maxReadBytes: 250 }));

                await expect(codeOf(async () => writer.findMany("shared", {}))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
                await expect(codeOf(async () => writer.query("shared").collect())).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
                await expect(codeOf(async () => writer.get("shared", "g0"))).resolves.toBeUndefined();
            });

            it("sizes a global document that has page, row or document fields as a whole", async () => {
                expect.assertions(2);

                const fat = { _id: "f1", body: "y".repeat(500), document: { n: 1 }, page: [1], row: { n: 1 } };
                const tracker = new TransactionHeadroomTracker();
                const writer = createShardContextDatabase({
                    clock: () => 1_700_000_000_000,
                    globalDb: { get: async () => fat } as unknown as DatabaseWriterLike,
                    headroom: tracker,
                    schema: globalSchema,
                    sql,
                });

                await expect(writer.get("shared", "f1")).resolves.toStrictEqual(fat);
                expect(tracker.headroom().readBytes).toBeGreaterThan(500);
            });

            it("charges documents a global query yields through async iteration", async () => {
                expect.assertions(1);

                const writer = createShardContextDatabase({
                    clock: () => 1_700_000_000_000,
                    globalDb: {
                        query: () => {
                            return {
                                async* [Symbol.asyncIterator]() {
                                    yield* rows;
                                },
                            };
                        },
                    } as unknown as DatabaseWriterLike,
                    headroom: new TransactionHeadroomTracker({ maxReadBytes: 250 }),
                    schema: globalSchema,
                    sql,
                });

                await expect(
                    codeOf(async () => {
                        const seen: unknown[] = [];

                        for await (const row of writer.query("shared") as unknown as AsyncIterable<unknown>) {
                            seen.push(row);
                        }

                        return seen;
                    }),
                ).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            });

            it("charges equal ids held by two global tables separately", async () => {
                expect.assertions(1);

                const twoGlobals: SchemaLike = {
                    tables: {
                        a: { ...globalSchema.tables["shared"]! },
                        b: { ...globalSchema.tables["shared"]! },
                    },
                };
                const tracker = new TransactionHeadroomTracker();
                const writer = createShardContextDatabase({
                    clock: () => 1_700_000_000_000,
                    globalDb: { get: async () => rows[0] } as unknown as DatabaseWriterLike,
                    headroom: tracker,
                    schema: twoGlobals,
                    sql,
                });

                await writer.get("a", "g0");

                const once = tracker.headroom().readBytes;

                await writer.get("b", "g0");

                expect(tracker.headroom().readBytes).toBe(once * 2);
            });

            it("charges a global row once however often it is read", async () => {
                expect.assertions(3);

                const tracker = new TransactionHeadroomTracker();
                const writer = buildGlobal(tracker);

                await writer.get("shared", "g0");
                await writer.get("shared", "g0");

                const once = tracker.headroom().readBytes;

                await writer.findMany("shared", {});

                const all = tracker.headroom().readBytes;

                await writer.findMany("shared", {});

                expect(once).toBeGreaterThan(100);
                expect(all).toBe(once * rows.length);
                expect(tracker.headroom().readBytes).toBe(all);
            });
        });

        it("still meters a read that overlaps an unmetered deleteAll", async () => {
            expect.assertions(2);

            const seed = build({});
            let first = "";

            for (let index = 0; index < 5; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                first = await seed.insert("notes", { body: "x".repeat(200), bucket: "a" });
            }

            const writer = build({ maxReadBytes: 100 });
            const erasing = writer.deleteAll?.("notes");

            // The erase is awaiting; a read on the same writer is not part of it.
            await expect(codeOf(async () => writer.get("notes", first))).resolves.toBe("TRANSACTION_LIMIT_EXCEEDED");
            await expect(erasing).resolves.toStrictEqual({ deleted: 5 });
        });

        describe("deleteAll under .rls('required')", () => {
            const rlsSchema: SchemaLike = {
                rlsMode: "required",
                tables: {
                    notes: { ...schema.tables["notes"]!, isPublic: false },
                    stats: { ...schema.tables["notes"]!, isPublic: true },
                },
            };

            const survivors = (table: string): number => sql.exec(`SELECT id FROM ${table}`).toArray().length;

            it.each([
                ["metered", true],
                ["unmetered", false],
            ])("refuses the protected table and leaves its rows, %s", async (_label, metered) => {
                expect.assertions(3);

                runShardMigrations(sql, rlsSchema);

                const trusted = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: rlsSchema, sql });

                await trusted.insert("notes", { body: "hidden", bucket: "a" });

                const caller = createShardContextDatabase({
                    clock: () => 1_700_000_000_000,
                    enforceRls: true,
                    ...(metered ? { headroom: new TransactionHeadroomTracker() } : {}),
                    schema: rlsSchema,
                    sql,
                });

                await expect(codeOf(async () => caller.deleteAll?.("notes"))).resolves.toBeDefined();
                expect(survivors("notes")).toBe(1);

                // A `.public()` table has no policy to bypass, so the erase proceeds on both paths.
                await trusted.insert("stats", { body: "open", bucket: "a" });
                await caller.deleteAll?.("stats");

                expect(survivors("stats")).toBe(0);
            });
        });

        it("does not charge read bytes inside an unmetered deleteAll", async () => {
            expect.assertions(1);

            const seed = build({ maxWrittenRows: 100 });

            for (let index = 0; index < 10; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await seed.insert("notes", { body: "x".repeat(200), bucket: "a" });
            }

            await expect(build({ maxReadBytes: 100 }).deleteAll?.("notes")).resolves.toStrictEqual({ deleted: 10 });
        });

        it("probes FTS once per database handle, not once per metered writer", () => {
            expect.assertions(1);

            let probes = 0;
            const counting: SqlExec = {
                exec: (query, ...params) => {
                    if (query.includes("CREATE VIRTUAL TABLE") && query.includes("__lunora_fts_probe")) {
                        probes += 1;
                    }

                    return sql.exec(query, ...params);
                },
            };

            for (let writer = 0; writer < 3; writer += 1) {
                isFtsAvailable(meterReadBytes(counting, new TransactionHeadroomTracker()));
            }

            expect(probes).toBe(1);
        });

        it("charges stored documents consumed by iterating the cursor", async () => {
            expect.assertions(2);

            await build({}).insert("notes", { body: "x".repeat(300), bucket: "a" });

            const [stored] = sql.exec<{ __doc__: string }>("SELECT __doc__ FROM notes").toArray();
            const tracker = new TransactionHeadroomTracker();
            const rows = [...meterReadBytes(sql, tracker).exec("SELECT id, __doc__ FROM notes")];

            expect(rows).toHaveLength(1);
            expect(tracker.headroom().readBytes).toBe(stored?.__doc__.length);
        });

        it("charges a materialized row once on a host whose toArray iterates the cursor", () => {
            expect.assertions(1);

            const doc = JSON.stringify({ body: "x".repeat(100) });
            const selfIterating: SqlExec = {
                exec: <Row>() => {
                    const rows = [{ __doc__: doc }] as Row[];
                    const cursor = {
                        one: () => [...cursor][0] as Row,
                        [Symbol.iterator]: () => rows[Symbol.iterator](),
                        toArray: () => [...cursor],
                    };

                    return cursor;
                },
            };
            const tracker = new TransactionHeadroomTracker();
            const metered = meterReadBytes(selfIterating, tracker);

            metered.exec("SELECT").toArray();
            metered.exec("SELECT").one();

            expect(tracker.headroom().readBytes).toBe(doc.length * 2);
        });

        it("does not charge an aggregate companion rebuild to the writing transaction", async () => {
            expect.assertions(1);

            const seed = build({ maxWrittenRows: 100 });

            for (let index = 0; index < 10; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await seed.insert("notes", { body: "x".repeat(200), bucket: "a" });
            }

            const withAggregate: SchemaLike = {
                tables: { notes: { ...schema.tables["notes"]!, aggregateIndexes: [{ by: ["bucket"], name: "count_by_bucket", on: "notes", op: "count" }] } },
            };

            runShardMigrations(sql, withAggregate);

            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                headroom: new TransactionHeadroomTracker({ maxReadBytes: 100 }),
                schema: withAggregate,
                sql,
            });

            await expect(codeOf(async () => writer.insert("notes", { body: "b", bucket: "a" }))).resolves.toBeUndefined();
        });

        it("warns once when a read crosses 80% of a ceiling", async () => {
            expect.assertions(2);

            const seed = build({ maxWrittenRows: 100 });

            for (let index = 0; index < 9; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seed order
                await seed.insert("notes", { body: "b", bucket: "a" });
            }

            const warnings: unknown[] = [];
            const reader = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                headroom: new TransactionHeadroomTracker({ maxReadRows: 10 }, (warning) => {
                    warnings.push(warning);
                }),
                schema,
                sql,
            });
            const read = async (): Promise<unknown> =>
                reader
                    .query("notes")
                    .withIndex("by_bucket", (q) => q.eq("bucket", "a"))
                    .take(9);

            await read();

            expect(warnings).toStrictEqual([{ kind: "readRows", limit: 10, used: 9 }]);

            // Past the ceiling now: it throws, and the warning is not repeated.
            await codeOf(read);

            expect(warnings).toHaveLength(1);
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
