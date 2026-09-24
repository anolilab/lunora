import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { backfillAggregateIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { AggregateIndexDefinitionLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises the aggregate-index runtime — trigger-maintained counters, indexed
 * vs scan planning, the RLS coupling seam, and the lazy/explicit backfill paths
 * — against a real SQLite engine.
 */

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const byProjectArchived: AggregateIndexDefinitionLike = {
    by: ["projectId", "archived"],
    name: "byProjectArchived",
    on: "todos",
    op: "count",
};

/** Whole-table aggregate (no `by`). */
const totalTodos: AggregateIndexDefinitionLike = {
    by: [],
    name: "total",
    on: "todos",
    op: "count",
};

const activeByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "activeByProject",
    on: "todos",
    op: "count",
    where: { archived: false },
};

const sumSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "sumSeqByProject",
    on: "todos",
    op: "sum",
};

const avgSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "avgSeqByProject",
    on: "todos",
    op: "avg",
};

const minSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "minSeqByProject",
    on: "todos",
    op: "min",
};

const maxSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "maxSeqByProject",
    on: "todos",
    op: "max",
};

/** Whole-table sum (no `by`). */
const sumSeqTotal: AggregateIndexDefinitionLike = {
    by: [],
    field: "seq",
    name: "sumSeqTotal",
    on: "todos",
    op: "sum",
};

const activeSumSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "activeSumSeqByProject",
    on: "todos",
    op: "sum",
    where: { archived: false },
};

const makeSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => {
    return {
        tables: {
            todos: {
                aggregateIndexes: indexes,
                indexes: [{ fields: ["projectId"], name: "by_project" }],
                shape: {
                    archived: { kind: "boolean" },
                    // Declared but never seeded: the tombstone-marker shape a
                    // filtered index most often keys on, where a live row simply
                    // has no such key at all.
                    deletedAt: { kind: "optional" },
                    projectId: { kind: "string" },
                    seq: { kind: "number" },
                },
            },
        },
    };
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

describe("ctx-db aggregates", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("aggregateIndex trigger maintenance", () => {
        it("insert/update/delete keep the counter in step with row writes", async () => {
            expect.assertions(5);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            // Indexed counters now visible.
            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(1);

            await writer.patch("t4", { projectId: "p1" });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(5);
            await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(0);

            await writer.delete("t1");

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("replace updates the counter when the `by`-key changes", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await writer.replace("t1", { archived: false, projectId: "p3", seq: 99 });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { projectId: "p3" })).resolves.toBe(1);
        });

        it("filtered aggregateIndex (.where) only counts matching rows", async () => {
            expect.assertions(3);

            const writer = setupWriter(makeSchema(activeByProject));

            await seed(writer);

            // The request DOES carry `{ archived: false }`, which is exactly the
            // index's static `where` — so it asks the counter's own question and
            // routes to it (`archived` is not a `by`-key; being fixed by the
            // index's filter is what makes it acceptable). A request without that
            // filter is a broader question and falls to the scan; that half is
            // pinned in "sum > honors the index static `where` when the request
            // carries it".
            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { archived: false, projectId: "p2" })).resolves.toBe(1);

            await writer.patch("t1", { archived: true });

            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(2);
        });

        it("whole-table aggregate (empty `by`) keys on the empty tuple", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(totalTodos));

            await seed(writer);

            await expect(writer.count("todos")).resolves.toBe(5);

            await writer.delete("t3");

            await expect(writer.count("todos")).resolves.toBe(4);
        });
    });

    describe("aggregateIndex planning", () => {
        it("matching by-key request hits the counter (no scan)", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProjectArchived));

            await seed(writer);

            // Drop the source rows behind the writer's back; if the counter is
            // routed correctly the read still returns the cached value.
            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
        });

        it("non-equality filter falls back to a scan", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            // `seq > 1` isn't on a `by`-key — the planner must fall through to
            // SCAN even though `byProject` is declared.
            await expect(writer.count("todos", { seq: { gt: 1 } })).resolves.toBe(3);
        });

        it("partial by-key falls back when more-specific index is missing", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProjectArchived));

            await seed(writer);

            // Index is by (projectId, archived); request asks for only projectId.
            // Without a single-key index we must scan.
            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("prefers narrower aggregateIndex when multiple match", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject, byProjectArchived));

            await seed(writer);

            harness.raw(`DELETE FROM "todos"`);

            // Both indexes match; the planner picks `byProjectArchived` (longer by).
            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
        });

        it("refuses a filtered counter for a request that does not carry its filter", async () => {
            expect.assertions(3);

            // `activeByProject` is `by: ["projectId"], where: { archived: false }`,
            // so its counter holds the ACTIVE p1 count (3) and the table holds 4.
            // Routing `{ projectId: "p1" }` to it answered the narrower question
            // the caller did not ask — `{ projectId }` does not imply
            // `archived === false`.
            const writer = setupWriter(makeSchema(activeByProject));

            await seed(writer);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);

            // Carrying the filter DOES route: the source rows are gone, so a
            // non-zero answer can only have come from the counter.
            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(0);
        });

        it("counts documents that simply OMIT a field the index filters on `null`", async () => {
            expect.assertions(3);

            // The dominant filtered-index shape is a tombstone marker the live
            // rows never carry at all. The read path renders `{ deletedAt: null }`
            // as `IS NULL` and an absent key extracts to SQL NULL, so the scan
            // counts those rows; the companion's predicate test used a strict
            // `undefined !== null` and counted NONE of them. Every read routed to
            // the counter answered 0 while the table held rows.
            const liveByProject: AggregateIndexDefinitionLike = {
                by: ["projectId"],
                name: "liveByProject",
                on: "todos",
                op: "count",
                where: { deletedAt: null },
            };
            const writer = setupWriter(makeSchema(liveByProject));

            // `deletedAt` is absent on every seeded row except the last.
            await seed(writer);
            await writer.patch("t5", { deletedAt: 1 });

            await expect(writer.count("todos", { deletedAt: null, projectId: "p1" })).resolves.toBe(3);

            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { deletedAt: null, projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { deletedAt: null, projectId: "p2" })).resolves.toBe(1);
        });

        it("does not route an UNFILTERED groupBy to a filtered index's counter", async () => {
            expect.assertions(3);

            // The index's static `where` used to be folded into the "partial key"
            // the caller counts against the `by` arity. For a groupBy with no
            // `where` at all that made a 0-key partial look like a fully-pinned
            // 1-key one, so the read took the single-row lookup with a `by`-tuple
            // of NULLs — which matches no counter row — and returned no groups.
            // Even had it matched, `activeByProject` excludes archived rows and
            // this request asked for all of them.
            const writer = setupWriter(makeSchema(activeByProject));

            await seed(writer);

            const byProjectId = (groups: ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>): Record<string, null | number> =>
                Object.fromEntries(groups.map((group) => [String(group.key["projectId"]), group.value]));
            const all = await writer.groupBy("todos", { by: ["projectId"] });

            expect(byProjectId(all)).toStrictEqual({ p1: 4, p2: 1 });

            // No group key ever carries a field the caller did not group by.
            expect(all.every((group) => Object.keys(group.key).length === 1)).toBe(true);

            // Carrying the index's own filter asks the counter's question.
            expect(byProjectId(await writer.groupBy("todos", { by: ["projectId"], where: { archived: false } }))).toStrictEqual({ p1: 3, p2: 1 });
        });
    });

    describe("rLS coupling seam", () => {
        it("aND-merges baseWhere into the scan predicate", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            await expect(writer.count("todos", { baseWhere: { archived: false }, where: { projectId: "p1" } })).resolves.toBe(3);
        });

        it("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await expect(writer.count("todos", { restrictsCounts: true, where: { projectId: "p1" } })).rejects.toMatchObject({
                code: "COUNT_RLS_UNSUPPORTED",
                name: "LunoraError",
            });
        });

        it("legacy bare where keeps working (no breakage)", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.count("todos")).resolves.toBe(5);
        });
    });

    describe("aggregate + groupBy", () => {
        it("aggregate(sum, field) reduces matching rows", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
            await expect(writer.aggregate("todos", { field: "seq", op: "max" })).resolves.toBe(4);
        });

        it("aggregate({ op: count }) defers to count() and uses the index", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.aggregate("todos", { op: "count", where: { projectId: "p1" } })).resolves.toBe(4);
        });

        it("groupBy(by, agg=count) tallies per group", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            const groups = await writer.groupBy("todos", { by: ["projectId"] });
            const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

            expect(tally).toEqual({ p1: 4, p2: 1 });
        });

        it("groups a boolean column on `false`/`true`, whether or not an index covers it", async () => {
            expect.assertions(2);

            // The scan groups on `json_extract(__doc__, '$.archived')`, and SQLite
            // has no boolean — a stored JSON `true` extracts as the INTEGER 1. The
            // companion-indexed path decodes its key tuple and hands back a real
            // `true`, so the same query answered two different TYPES depending on
            // whether an aggregate index happened to cover it, and a caller's
            // `groups.find((group) => group.key.archived === true)` was
            // `undefined` on the scan. Asserting both paths together is the point.
            const countByArchived: AggregateIndexDefinitionLike = {
                by: ["archived"],
                name: "countByArchived",
                on: "todos",
                op: "count",
            };
            const byKey = (groups: ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>): Record<string, null | number> =>
                Object.fromEntries(groups.map((group) => [String(group.key["archived"]), group.value]));

            const scanned = setupWriter(makeSchema());

            await seed(scanned);

            const scanGroups = await scanned.groupBy("todos", { by: ["archived"] });

            expect(scanGroups.filter((group) => group.key["archived"] === true)).toStrictEqual([{ key: { archived: true }, value: 1 }]);

            // Same rows, same harness — only the declared index differs, so the
            // reader lazily backfills the companion and takes the indexed path.
            const indexed = setupWriter(makeSchema(countByArchived));

            expect(byKey(await indexed.groupBy("todos", { by: ["archived"] }))).toStrictEqual(byKey(scanGroups));
        });

        it("does not answer a PARTIALLY-pinned groupBy from the companion", async () => {
            expect.assertions(2);

            // An index keyed on the full `by` tuple, with the request pinning
            // only part of it. The companion cannot serve this: the single-row
            // lookup needs the whole tuple, and the full walk reads every
            // companion row — so the unpinned groups came back too and the
            // `where` was silently ignored. It now falls to the scan, which
            // compiles the predicate.
            const countByProjectSeq: AggregateIndexDefinitionLike = {
                by: ["projectId", "seq"],
                name: "countByProjectSeq",
                on: "todos",
                op: "count",
            };
            const writer = setupWriter(makeSchema(countByProjectSeq));

            await seed(writer);

            const groups = await writer.groupBy("todos", { by: ["projectId", "seq"], where: { projectId: "p1" } });

            // p2's row (seq 4) must not appear; p1 has four rows, all distinct seq.
            expect(groups.every((group) => group.key["projectId"] === "p1")).toBe(true);
            expect(groups.map((group) => group.key["seq"]).toSorted((a, b) => Number(a) - Number(b))).toStrictEqual([0, 1, 2, 3]);
        });

        it("groupBy(by, agg=sum) reduces per group with a where", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            const groups = await writer.groupBy("todos", {
                agg: { field: "seq", op: "sum" },
                by: ["projectId"],
                where: { archived: false },
            });
            const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

            expect(tally).toEqual({ p1: 3, p2: 4 });
        });

        it("drops a group from the indexed groupBy once it empties (matches SQL GROUP BY)", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byProject, sumSeqByProject));

            await seed(writer);
            await writer.delete("t4"); // p2's only row → the group empties

            // Force the indexed walk: with the source table gone, only the
            // companion can answer — so a surviving phantom row would show up.
            harness.raw(`DELETE FROM "todos"`);

            const counts = await writer.groupBy("todos", { by: ["projectId"] });

            expect(counts.map((g) => g.key["projectId"])).toEqual(["p1"]);

            const sums = await writer.groupBy("todos", { agg: { field: "seq", op: "sum" }, by: ["projectId"] });

            expect(sums.map((g) => g.key["projectId"])).toEqual(["p1"]);
        });
    });

    describe("reducer-aware aggregate indexes", () => {
        describe("sum", () => {
            it("reads the maintained sum without scanning the source", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(sumSeqByProject));

                await seed(writer);

                // Wipe the source rows — a correct read returns the maintained value.
                harness.raw(`DELETE FROM "todos"`);

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p2" } })).resolves.toBe(4);
            });

            it("maintains the running sum across insert/patch/replace/delete", async () => {
                expect.assertions(4);

                const writer = setupWriter(makeSchema(sumSeqByProject));

                await seed(writer);

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);

                await writer.patch("t1", { seq: 10 }); // p1: 6 - 1 + 10 = 15

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(15);

                await writer.replace("t2", { archived: false, projectId: "p1", seq: 5 }); // p1: 15 - 2 + 5 = 18

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(18);

                await writer.delete("t3"); // p1: 18 - 3 = 15

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(15);
            });

            it("moves the running sum when a patch changes the `by`-key", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(sumSeqByProject));

                await seed(writer);

                await writer.patch("t4", { projectId: "p1" }); // p2 → p1: p1 6+4=10, p2 empty

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(10);

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p2" } })).resolves.toBeNull();
            });

            it("honors the index static `where` when the request carries it", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(activeSumSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                // Only active p1 rows (seq 1,2,0) contribute → 3 (the archived t3 is excluded).
                // The source rows are gone, so a non-null answer proves the counter was read.
                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { archived: false, projectId: "p1" } })).resolves.toBe(3);

                // The SAME request minus the index's own filter must NOT be answered
                // from that counter: `{ projectId: "p1" }` is a broader question than
                // `{ projectId: "p1", archived: false }`, and the counter only ever
                // tallied the narrower one. It falls to the scan, which sees the
                // emptied table.
                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBeNull();
            });

            it("whole-table sum keys on the empty tuple", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(sumSeqTotal));

                await seed(writer);

                await expect(writer.aggregate("todos", { field: "seq", op: "sum" })).resolves.toBe(10);

                await writer.delete("t4"); // 10 - 4 = 6

                await expect(writer.aggregate("todos", { field: "seq", op: "sum" })).resolves.toBe(6);
            });
        });

        describe("avg", () => {
            it("reads sum/count as the maintained average", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(avgSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } })).resolves.toBe(1.5);
                await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p2" } })).resolves.toBe(4);
            });

            it("recomputes the average as the divisor shrinks to zero", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(avgSeqByProject));

                await seed(writer);

                await writer.delete("t4"); // p2 now empty

                await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p2" } })).resolves.toBeNull();

                await writer.patch("t1", { seq: 7 }); // p1 seqs 7,2,3,0 → avg 3

                await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } })).resolves.toBe(3);
            });
        });

        describe("min/max", () => {
            it("reads the maintained extreme without scanning", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(0);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);
            });

            it("keeps the stored extreme on a fast-path delete (non-extreme row leaves)", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);

                await writer.delete("t2"); // p1 drops seq 2 — neither the min (0) nor max (3)

                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(0);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);
            });

            it("recomputes the extreme when the stored extreme is deleted", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);

                await writer.delete("t5"); // removes seq 0 (the p1 min) → new min is 1
                await writer.delete("t3"); // removes seq 3 (the p1 max) → new max is 2

                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(1);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(2);
            });

            it("recomputes the extreme on a shrinking update", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(maxSeqByProject));

                await seed(writer);

                await writer.patch("t3", { seq: 1 }); // the stored p1 max (3) shrinks to 1 → new max is 2

                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(2);

                await writer.patch("t1", { seq: 9 }); // a growing update wins the fast path

                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(9);
            });

            it("returns null when the group empties out", async () => {
                expect.assertions(1);

                const writer = setupWriter(makeSchema(minSeqByProject));

                await seed(writer);

                await writer.delete("t4"); // p2's only row

                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p2" } })).resolves.toBeNull();
            });

            it("moves the extreme between groups when a patch changes the `by`-key", async () => {
                expect.assertions(4);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);

                // t5 carries p1's min (seq 0); move it to p2. p1's min must
                // recompute (the stored extreme left), and p2 must seed the new
                // value — exercising recompute-on-old + seed-on-new across groups.
                await writer.patch("t5", { projectId: "p2" });

                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(1);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);
                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p2" } })).resolves.toBe(0);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p2" } })).resolves.toBe(4);
            });
        });

        describe("groupBy per op (indexed, no scan)", () => {
            it("groupBy(sum) reads each group's maintained sum", async () => {
                expect.assertions(1);

                const writer = setupWriter(makeSchema(sumSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                const groups = await writer.groupBy("todos", { agg: { field: "seq", op: "sum" }, by: ["projectId"] });
                const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

                expect(tally).toEqual({ p1: 6, p2: 4 });
            });

            it("groupBy(avg) reads each group's maintained average", async () => {
                expect.assertions(1);

                const writer = setupWriter(makeSchema(avgSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                const groups = await writer.groupBy("todos", { agg: { field: "seq", op: "avg" }, by: ["projectId"] });
                const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

                expect(tally).toEqual({ p1: 1.5, p2: 4 });
            });

            it("groupBy(min)/groupBy(max) read each group's maintained extreme", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);

                harness.raw(`DELETE FROM "todos"`);

                const mins = await writer.groupBy("todos", { agg: { field: "seq", op: "min" }, by: ["projectId"] });
                const maxes = await writer.groupBy("todos", { agg: { field: "seq", op: "max" }, by: ["projectId"] });

                expect(Object.fromEntries(mins.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 0, p2: 4 });
                expect(Object.fromEntries(maxes.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 3, p2: 4 });
            });

            it("drops an emptied min/max group from the indexed walk (DELETE on empty, not a NULL row)", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

                await seed(writer);
                await writer.delete("t4"); // p2's only row → the min/max group empties

                // Force the indexed walk: a leftover NULL-valued companion row
                // would surface p2 as a phantom group here.
                harness.raw(`DELETE FROM "todos"`);

                const mins = await writer.groupBy("todos", { agg: { field: "seq", op: "min" }, by: ["projectId"] });
                const maxes = await writer.groupBy("todos", { agg: { field: "seq", op: "max" }, by: ["projectId"] });

                expect(mins.map((g) => g.key["projectId"])).toEqual(["p1"]);
                expect(maxes.map((g) => g.key["projectId"])).toEqual(["p1"]);
            });
        });

        describe("lazy backfill computes per-op values", () => {
            it("backfills sum/avg/min/max from an existing table on first read", async () => {
                expect.assertions(4);

                let writer = setupWriter(makeSchema());

                await seed(writer);

                const schemaWithIndexes = makeSchema(sumSeqByProject, avgSeqByProject, minSeqByProject, maxSeqByProject);

                runShardMigrations(harness.sql, schemaWithIndexes);
                writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithIndexes, sql: harness.sql });

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
                await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } })).resolves.toBe(1.5);
                await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(0);
                await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);
            });

            it("backfillAggregateIndexes() seeds per-op values up-front", async () => {
                expect.assertions(2);

                let writer = setupWriter(makeSchema());

                await seed(writer);

                const schemaWithIndex = makeSchema(sumSeqByProject);

                runShardMigrations(harness.sql, schemaWithIndex);
                backfillAggregateIndexes(harness.sql, schemaWithIndex);

                // eslint-disable-next-line no-secrets/no-secrets -- companion table name (table__agg_index), not a credential
                const rows = harness.raw(`SELECT "__value__", "__count__" FROM "todos__agg_sumSeqByProject" WHERE "__key__" = '{"projectId":"p1"}'`) as {
                    __count__: number;
                    __value__: number;
                }[];

                expect(rows[0]).toMatchObject({ __count__: 4, __value__: 6 });

                writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithIndex, sql: harness.sql });

                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
            });
        });
    });

    describe("auto-backfill", () => {
        it("lazily backfills the counter on first read when the table already has rows", async () => {
            expect.assertions(2);

            // Phase 1: a writer with no aggregateIndex declarations. The counter
            // table does not exist yet.
            let writer = setupWriter(makeSchema());

            await seed(writer);

            // Phase 2: redeclare the schema with byProject and re-run migrations.
            // The counter table appears empty; the next read must backfill it.
            const schemaWithIndex = makeSchema(byProject);

            runShardMigrations(harness.sql, schemaWithIndex);
            writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithIndex, sql: harness.sql });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);

            // Wipe the source rows to prove the second read goes through the now-
            // populated counter, not a fallback scan.
            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("backfillAggregateIndexes() populates counters up-front", async () => {
            expect.assertions(2);

            let writer = setupWriter(makeSchema());

            await seed(writer);

            const schemaWithIndex = makeSchema(byProject);

            runShardMigrations(harness.sql, schemaWithIndex);
            backfillAggregateIndexes(harness.sql, schemaWithIndex);

            // The counter table is now populated independently of any read.
            const rows = harness.raw(`SELECT "__key__", "__value__" FROM "todos__agg_byProject"`);

            expect(rows).toHaveLength(2);

            writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithIndex, sql: harness.sql });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });
    });
});
