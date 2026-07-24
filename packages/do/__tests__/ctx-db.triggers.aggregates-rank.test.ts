import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AggregateIndexDefinitionLike } from "@lunora/shard-engine";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { RankIndexDefinitionLike } from "@lunora/shard-engine";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Triggers run inline within the DO transaction; the counter / rank
 * companions are stepped BEFORE the after-trigger fires (see ctx-db.ts), so a
 * handler's `ctx.db.&lt;table>.aggregate(...)` / `count(...)` / `rank(...)` MUST
 * observe the just-staged write. These tests enforce that contract.
 */

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const byChannel: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "messages",
    partitionBy: ["channelId"],
    sortBy: [{ direction: "asc", field: "_creationTime" }],
};

let harness: ReturnType<typeof createSqliteExec>;

describe("ctx-db triggers — aggregates and rank", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
        runShardMigrations(harness.sql, schema);

        return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
    };

    describe("triggers see staged aggregate/rank state inside the same transaction", () => {
        it("after-insert trigger reads count() that includes the new row", async () => {
            expect.assertions(1);

            const seen: number[] = [];
            const schema: SchemaLike = {
                tables: {
                    todos: {
                        aggregateIndexes: [byProject],
                        indexes: [],
                        shape: { projectId: { kind: "string" } },
                        triggerMap: {
                            recordCount: {
                                handler: async (context, event) => {
                                    const count = await context.db.count("todos", { projectId: (event.doc as Record<string, unknown>)["projectId"] });

                                    seen.push(count);
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };
            const writer = makeWriter(schema);

            await writer.insert("todos", { _id: "t1", projectId: "p1" }, { allowExplicitId: true });
            await writer.insert("todos", { _id: "t2", projectId: "p1" }, { allowExplicitId: true });

            // Both reads must include the just-staged row — counter was stepped
            // before the trigger fired.
            expect(seen).toEqual([1, 2]);
        });

        it("after-insert trigger reads aggregate() and groupBy()", async () => {
            expect.assertions(2);

            const aggSeen: (null | number)[] = [];
            const groupSeen: { count: number; projectId: unknown }[] = []; // gitleaks:allow — kingfisher false positive on a structural TS type

            const schema: SchemaLike = {
                tables: {
                    todos: {
                        aggregateIndexes: [byProject],
                        indexes: [],
                        shape: { projectId: { kind: "string" }, weight: { kind: "number" } },
                        triggerMap: {
                            recordAgg: {
                                handler: async (context) => {
                                    const sum = await context.db.aggregate("todos", { field: "weight", op: "sum" });
                                    const groups = await context.db.groupBy("todos", { by: ["projectId"] });

                                    aggSeen.push(sum);
                                    groupSeen.push(
                                        ...groups.map((entry) => {
                                            return { count: entry.value as number, projectId: entry.key["projectId"] };
                                        }),
                                    );
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };
            const writer = makeWriter(schema);

            await writer.insert("todos", { _id: "t1", projectId: "p1", weight: 10 }, { allowExplicitId: true });
            await writer.insert("todos", { _id: "t2", projectId: "p2", weight: 5 }, { allowExplicitId: true });

            expect(aggSeen).toEqual([10, 15]);

            // After the second insert: { p1: 1, p2: 1 }
            const lastSnapshot = groupSeen.slice(-2).toSorted((a, b) => String(a.projectId).localeCompare(String(b.projectId)));

            expect(lastSnapshot).toEqual([
                { count: 1, projectId: "p1" },
                { count: 1, projectId: "p2" },
            ]);
        });

        it("after-insert trigger sees the new row's rank position", async () => {
            expect.assertions(1);

            const ranks: (null | { position: number; total: number })[] = [];

            const schema: SchemaLike = {
                tables: {
                    messages: {
                        indexes: [],
                        rankIndexes: [byChannel],
                        shape: { channelId: { kind: "string" } },
                        triggerMap: {
                            recordRank: {
                                handler: async (context, event) => {
                                    const result = await context.db.rank("messages", "byChannel", { row: event.id });

                                    ranks.push(result);
                                },
                                op: "insert",
                                timing: "after",
                            },
                        },
                    },
                },
            };
            const writer = makeWriter(schema);

            await writer.insert("messages", { _creationTime: 100, _id: "m1", channelId: "c1" }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 200, _id: "m2", channelId: "c1" }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 150, _id: "m3", channelId: "c1" }, { allowExplicitId: true });

            // m1 enters first → position 1 of 1.
            // m2 enters second → position 2 of 2 (it has a later _creationTime).
            // m3 enters third  → position 2 of 3 (sits between m1 and m2).
            expect(ranks).toEqual([
                { position: 1, total: 1 },
                { position: 2, total: 2 },
                { position: 2, total: 3 },
            ]);
        });

        it("replace() conflicts when a concurrent write commits during the before-update trigger, leaving the aggregate consistent", async () => {
            expect.assertions(3);

            // Two writers over the SAME SQLite db. The before-update trigger
            // spans an `await`; inside it a SECOND writer commits a competing
            // patch on the same row — exactly the window the OCC guard must
            // catch. Without the guard, replace's UPDATE ... WHERE id = ?
            // would silently clobber that write (lost update) AND apply a
            // `-prev` aggregate step against a stale `previous`, drifting the
            // count companion.
            let fired = false;
            let competitor: DatabaseWriterLike | undefined;

            const schema: SchemaLike = {
                tables: {
                    todos: {
                        aggregateIndexes: [byProject],
                        indexes: [],
                        shape: { projectId: { kind: "string" }, title: { kind: "string" } },
                        triggerMap: {
                            raceWrite: {
                                handler: async () => {
                                    // Commit a competing write exactly once,
                                    // during the replace's await window.
                                    if (!fired) {
                                        fired = true;
                                        await competitor?.patch("t1", { title: "concurrent" });
                                    }
                                },
                                op: "update",
                                timing: "before",
                            },
                        },
                    },
                },
            };
            const writer = makeWriter(schema);

            competitor = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });

            await writer.insert("todos", { _id: "t1", projectId: "p1", title: "orig" }, { allowExplicitId: true });

            // replace reads its snapshot, fires the before-update trigger
            // (which commits the competing patch), then its guarded UPDATE
            // must match zero rows and raise a ConflictError.
            await expect(writer.replace("t1", { projectId: "p2", title: "replaced" })).rejects.toMatchObject({ name: "ConflictError" });

            // The competing patch survived (not clobbered) and the row stays
            // in its original partition — proof the aggregate -prev step never
            // ran against the stale snapshot.
            const row = await competitor.get("t1");

            expect(row).toMatchObject({ projectId: "p1", title: "concurrent" });

            // Counter still reflects exactly the one row in p1 (no drift from
            // a -prev/+next applied against a row state that no longer matched
            // disk).
            await expect(competitor.count("todos", { projectId: "p1" })).resolves.toBe(1);
        });

        it("after-delete trigger sees the count without the deleted row", async () => {
            expect.assertions(1);

            const counts: number[] = [];

            const schema: SchemaLike = {
                tables: {
                    todos: {
                        aggregateIndexes: [byProject],
                        indexes: [],
                        shape: { projectId: { kind: "string" } },
                        triggerMap: {
                            recordCount: {
                                handler: async (context) => {
                                    counts.push(await context.db.count("todos", { projectId: "p1" }));
                                },
                                op: "delete",
                                timing: "after",
                            },
                        },
                    },
                },
            };
            const writer = makeWriter(schema);

            await writer.insert("todos", { _id: "t1", projectId: "p1" }, { allowExplicitId: true });
            await writer.insert("todos", { _id: "t2", projectId: "p1" }, { allowExplicitId: true });
            await writer.delete("t1");

            expect(counts).toEqual([1]);
        });
    });
});
