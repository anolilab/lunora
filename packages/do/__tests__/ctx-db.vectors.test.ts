import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@cirrus/vectors";
import { createVectorSyncHook } from "@cirrus/vectors";
import { describe, expect, it, vi } from "vitest";

import type { WriteHook } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { createFakeSql, messagesSchema } from "./_helpers/fake-sql";

const fixedTime = 1_700_000_000_000;

const embed = async (value: string): Promise<ReadonlyArray<number>> => [value.length];

// The sync hook reads its own schema shape (table → vector indexes), separate
// from the ctx-db migration schema. `messages-text` is sourced inline from the
// `messages.text` column (Shape A) with `authorId` carried as metadata.
const vectorsSchema: VectorSchemaLike = {
    tables: {
        messages: { vectorIndexes: [{ embed, field: "text", metadata: ["authorId"], name: "messages-text" }] },
    },
    vectorIndexes: {},
};

const fakeVectorSearch = (): VectorSearchLike & { deletes: [string, ReadonlyArray<string>][]; upserts: [string, unknown][] } => {
    const upserts: [string, unknown][] = [];
    const deletes: [string, ReadonlyArray<string>][] = [];

    return {
        deleteByIds: vi.fn<VectorSearchLike["deleteByIds"]>(async (indexName, ids) => {
            deletes.push([indexName, ids]);
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

const setup = (): { vectors: ReturnType<typeof fakeVectorSearch>; writer: ReturnType<typeof createShardContextDatabase> } => {
    const { sql } = createFakeSql();

    runShardMigrations(sql, messagesSchema);

    const vectors = fakeVectorSearch();
    const onWrite: WriteHook = createVectorSyncHook({ schema: vectorsSchema, vectors });
    const writer = createShardContextDatabase({
        broadcast: () => undefined,
        clock: () => fixedTime,
        idGenerator: () => "m_1",
        onWrite,
        schema: messagesSchema,
        sql,
    });

    return { vectors, writer };
};

describe("createShardCtxDb + createVectorSyncHook (composed write path)", () => {
    it("a committed insert syncs an upsert to the vector index", async () => {
        expect.assertions(3);

        const { vectors, writer } = setup();

        const id = await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });

        expect(id).toBe("m_1");
        expect(vectors.upserts).toEqual([["messages-text", { embed, id: "m_1", input: "hello world", metadata: { authorId: "ann" } }]]);
        expect(vectors.deletes).toEqual([]);
    });

    it("a committed update re-embeds the merged row", async () => {
        expect.assertions(1);

        const { vectors, writer } = setup();

        await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });
        vectors.upserts.length = 0;

        await writer.patch("m_1", { text: "edited body" });

        expect(vectors.upserts).toEqual([["messages-text", { embed, id: "m_1", input: "edited body", metadata: { authorId: "ann" } }]]);
    });

    it("a committed delete propagates deleteByIds to the index", async () => {
        expect.assertions(1);

        const { vectors, writer } = setup();

        await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });
        await writer.delete("m_1");

        expect(vectors.deletes).toEqual([["messages-text", ["m_1"]]]);
    });

    it("writes to a table with no vector index are not synced", async () => {
        expect.assertions(2);

        const { vectors, writer } = setup();

        await writer.insert("roomMembers", { roomId: "r1", userId: "u1" });

        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([]);
    });
});
