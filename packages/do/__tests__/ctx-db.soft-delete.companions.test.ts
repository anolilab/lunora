import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@lunora/bindings/vectors";
import { createVectorSyncHook } from "@lunora/bindings/vectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseWriterLike, SchemaLike, WriteHook } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Companions a soft delete must drop (no read-time marker filter is possible):
 * the rank companion (its row carries no marker column) and external Vectorize
 * (its query can't be scoped). A soft delete removes the row from both, like a
 * physical delete; `restore()` re-adds them via the patch path.
 */
const FIXED = 1_700_000_000_000;

describe("soft delete — rank companion", () => {
    const schema: SchemaLike = {
        tables: {
            scores: {
                indexes: [],
                rankIndexes: [{ name: "by_score", on: "scores", sortBy: [{ direction: "desc", field: "score" }] }],
                shape: { deletedAt: { kind: "number" }, score: { kind: "number" } },
                softDeleteMode: { field: "deletedAt" },
            },
        },
    };

    let harness: ReturnType<typeof createSqliteExec>;

    const setup = async (): Promise<DatabaseWriterLike> => {
        runShardMigrations(harness.sql, schema);

        const writer = createShardContextDatabase({ clock: () => FIXED, schema, sql: harness.sql });

        await writer.insert("scores", { _id: "s1", score: 10 }, { allowExplicitId: true });
        await writer.insert("scores", { _id: "s2", score: 20 }, { allowExplicitId: true });
        await writer.insert("scores", { _id: "s3", score: 30 }, { allowExplicitId: true });

        return writer;
    };

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("excludes a soft-deleted row from rankPage, and restore re-adds it", async () => {
        expect.assertions(3);

        const writer = await setup();

        await writer.delete("s2", "scores");

        const afterDelete = await writer.rankPage("scores", "by_score", {});

        expect(afterDelete.page.map((row) => row["_id"])).toStrictEqual(["s3", "s1"]);

        await writer.restore!("s2", "scores");

        const afterRestore = await writer.rankPage("scores", "by_score", {});

        expect(afterRestore.page.map((row) => row["_id"])).toStrictEqual(["s3", "s2", "s1"]);

        // hardDelete keeps it out for good.
        await writer.delete("s2", "scores", { hard: true });

        const afterHard = await writer.rankPage("scores", "by_score", {});

        expect(afterHard.page.map((row) => row["_id"])).toStrictEqual(["s3", "s1"]);
    });
});

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

describe("soft delete — Vectorize sync", () => {
    const ctxSchema: SchemaLike = {
        tables: {
            messages: {
                indexes: [],
                shape: { deletedAt: { kind: "number" }, text: { kind: "string" } },
                softDeleteMode: { field: "deletedAt" },
            },
        },
    };

    const vectorsSchema: VectorSchemaLike = {
        tables: { messages: { vectorIndexes: [{ embed, field: "text", name: "messages-text" }] } },
        vectorIndexes: {},
    };

    const fakeVectors = (): VectorSearchLike & { deletes: [string, ReadonlyArray<string>][]; upserts: [string, unknown][] } => {
        const upserts: [string, unknown][] = [];
        const deletes: [string, ReadonlyArray<string>][] = [];

        return {
            deleteByIds: vi.fn<VectorSearchLike["deleteByIds"]>(async (indexName, indexIds) => {
                deletes.push([indexName, indexIds]);
            }),
            deletes,
            getByIds: vi.fn<VectorSearchLike["getByIds"]>(async () => []),
            query: vi.fn<VectorSearchLike["query"]>(async () => {
                return { count: 0, matches: [] };
            }),
            upsert: vi.fn<VectorSearchLike["upsert"]>(async (indexName, input) => {
                upserts.push([indexName, input]);
            }),
            upsertNow: vi.fn<VectorSearchLike["upsertNow"]>(async (indexName, input) => {
                upserts.push([indexName, input]);
            }),
            upserts,
        };
    };

    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("drops the vector on soft delete and re-upserts on restore", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, ctxSchema);

        const vectors = fakeVectors();
        const onWrite: WriteHook = createVectorSyncHook({ schema: vectorsSchema, vectors });
        const writer = createShardContextDatabase({ clock: () => FIXED, idGenerator: () => "m1", onWrite, schema: ctxSchema, sql: harness.sql });

        await writer.insert("messages", { text: "hello" });

        expect(vectors.upserts).toHaveLength(1);

        // Soft delete must REMOVE the vector (else it leaks into similarity search).
        await writer.delete("m1", "messages");

        expect(vectors.deletes).toStrictEqual([["messages-text", ["m1"]]]);

        // Restore re-embeds it.
        await writer.restore!("m1", "messages");

        expect(vectors.upserts).toHaveLength(2);
    });
});
