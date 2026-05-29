import type { SchemaLike as VectorSchemaLike, VectorSearchLike } from "@cirrus/vectors";
import { createVectorSyncHook } from "@cirrus/vectors";
import { describe, expect, test, vi } from "vitest";

import type { WriteHook } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createFakeSql, messagesSchema } from "./_helpers/fake-sql.js";

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

const fakeVectorSearch = (): VectorSearchLike & { deletes: Array<[string, ReadonlyArray<string>]>; upserts: Array<[string, unknown]> } => {
    const upserts: Array<[string, unknown]> = [];
    const deletes: Array<[string, ReadonlyArray<string>]> = [];

    return {
        deleteByIds: vi.fn(async (indexName, ids) => void deletes.push([indexName, ids])),
        deletes,
        getByIds: vi.fn(async () => []),
        query: vi.fn(async () => ({ count: 0, matches: [] })),
        upsert: vi.fn(async (indexName, input) => void upserts.push([indexName, input])),
        upsertNow: vi.fn(async (indexName, input) => void upserts.push([indexName, input])),
        upserts,
    };
};

const setup = (): { vectors: ReturnType<typeof fakeVectorSearch>; writer: ReturnType<typeof createShardCtxDb> } => {
    const { sql } = createFakeSql();

    runShardMigrations(sql, messagesSchema);

    const vectors = fakeVectorSearch();
    const onWrite: WriteHook = createVectorSyncHook({ schema: vectorsSchema, vectors });
    const writer = createShardCtxDb({
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
    test("a committed insert syncs an upsert to the vector index", async () => {
        const { vectors, writer } = setup();

        const id = await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });

        expect(id).toBe("m_1");
        expect(vectors.upserts).toEqual([["messages-text", { embed, id: "m_1", input: "hello world", metadata: { authorId: "ann" } }]]);
        expect(vectors.deletes).toEqual([]);
    });

    test("a committed update re-embeds the merged row", async () => {
        const { vectors, writer } = setup();

        await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });
        vectors.upserts.length = 0;

        await writer.patch("m_1", { text: "edited body" });

        expect(vectors.upserts).toEqual([["messages-text", { embed, id: "m_1", input: "edited body", metadata: { authorId: "ann" } }]]);
    });

    test("a committed delete propagates deleteByIds to the index", async () => {
        const { vectors, writer } = setup();

        await writer.insert("messages", { authorId: "ann", channelId: "c1", text: "hello world" });
        await writer.delete("m_1");

        expect(vectors.deletes).toEqual([["messages-text", ["m_1"]]]);
    });

    test("writes to a table with no vector index are not synced", async () => {
        const { vectors, writer } = setup();

        await writer.insert("roomMembers", { roomId: "r1", userId: "u1" });

        expect(vectors.upserts).toEqual([]);
        expect(vectors.deletes).toEqual([]);
    });
});
