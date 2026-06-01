import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AggregateIndexDefinitionLike } from "../src/aggregates.js";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import type { RankIndexDefinitionLike } from "../src/rank.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

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

        return createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
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
                                handler: async (ctx, event) => {
                                    const count = await ctx.db.count("todos", { projectId: (event.doc as Record<string, unknown>)["projectId"] });

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
                                handler: async (ctx) => {
                                    const sum = await ctx.db.aggregate("todos", { field: "weight", op: "sum" });
                                    const groups = await ctx.db.groupBy("todos", { by: ["projectId"] });

                                    aggSeen.push(sum);
                                    groupSeen.push(...groups.map((entry) => { return { count: entry.value as number, projectId: entry.key["projectId"] }; }));
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
            const lastSnapshot = groupSeen.slice(-2).sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)));

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
                                handler: async (ctx, event) => {
                                    const result = await ctx.db.rank("messages", "byChannel", { row: event.id });

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
                                handler: async (ctx) => {
                                    counts.push(await ctx.db.count("todos", { projectId: "p1" }));
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
