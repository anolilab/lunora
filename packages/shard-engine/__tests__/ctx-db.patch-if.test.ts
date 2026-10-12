import { describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

const fixedTime = 1_700_000_000_000;

type ConditionalWriter = DatabaseWriterLike & Required<Pick<DatabaseWriterLike, "insertManyUnsafe" | "patchIf">>;

const setupWriter = (
    globalDb?: DatabaseWriterLike,
): {
    deltas: Parameters<BroadcastDelta>[0][];
    harness: ReturnType<typeof createSqliteExec>;
    seen: { params: unknown[]; text: string }[];
    writer: ConditionalWriter;
} => {
    const harness = createSqliteExec();
    const seen: { params: unknown[]; text: string }[] = [];
    const deltas: Parameters<BroadcastDelta>[0][] = [];
    const recordingSql: SqlExec = {
        exec: (query: string, ...params: unknown[]) => {
            seen.push({ params, text: query });

            return harness.sql.exec(query, ...params);
        },
    };

    runShardMigrations(harness.sql, messagesSchema);

    const writer = createShardContextDatabase({
        broadcast: (delta) => deltas.push(delta),
        clock: () => fixedTime,
        globalDb,
        schema: messagesSchema,
        sql: recordingSql,
    });

    return { deltas, harness, seen, writer: writer as ConditionalWriter };
};

describe("ctx-db patchIf (shard-local)", () => {
    it("applies the patch when the stored row matches and returns the written row", async () => {
        expect.assertions(3);

        const { deltas, writer } = setupWriter();
        const id = await writer.insert("messages", { authorId: "a1", channelId: "c1", text: "hello" });

        deltas.length = 0;

        const result = await writer.patchIf("messages", id, { patch: { text: "edited" }, where: { text: "hello" } });

        expect(result).toStrictEqual({ applied: true, doc: expect.objectContaining({ _id: id, authorId: "a1", text: "edited" }) });
        await expect(writer.get(id)).resolves.toStrictEqual(expect.objectContaining({ text: "edited" }));
        expect(deltas.map((delta) => delta.op)).toStrictEqual(["update"]);
    });

    it("leaves a non-matching row untouched and reports it as it stands", async () => {
        expect.assertions(3);

        const { deltas, writer } = setupWriter();
        const id = await writer.insert("messages", { authorId: "a1", channelId: "c1", text: "hello" });

        deltas.length = 0;

        const result = await writer.patchIf("messages", id, { patch: { text: "edited" }, where: { text: "something else" } });

        expect(result).toStrictEqual({ applied: false, doc: expect.objectContaining({ _id: id, text: "hello" }) });
        await expect(writer.get(id)).resolves.toStrictEqual(expect.objectContaining({ text: "hello" }));
        expect(deltas).toHaveLength(0);
    });

    it("evaluates operator filters against the stored row", async () => {
        expect.assertions(2);

        const { writer } = setupWriter();
        const id = await writer.insert("messages", { authorId: "a5", channelId: "c1", text: "hello" });

        await expect(writer.patchIf("messages", id, { patch: { text: "lt" }, where: { authorId: { lt: "a3" } } })).resolves.toMatchObject({ applied: false });
        await expect(writer.patchIf("messages", id, { patch: { text: "gt" }, where: { authorId: { gt: "a3" } } })).resolves.toMatchObject({ applied: true });
    });

    it("reports a missing row as not applied with a null doc", async () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        await expect(writer.patchIf("messages", "00000000-0000-4000-8000-000000000000", { patch: { text: "x" }, where: {} })).resolves.toStrictEqual({
            applied: false,
            doc: null,
        });
    });

    it("lets exactly one of ten concurrent compare-and-set patches win", async () => {
        expect.assertions(2);

        const { writer } = setupWriter();
        const id = await writer.insert("messages", { authorId: "a1", channelId: "c1", text: "0" });

        // Every caller read text "0" and tries to move it on; only the first may.
        const results = await Promise.all(
            Array.from({ length: 10 }, async (_, index) =>
                writer.patchIf("messages", id, { patch: { text: `winner-${String(index)}` }, where: { text: "0" } }),
            ),
        );

        expect(results.filter((result) => result.applied)).toHaveLength(1);
        await expect(writer.get(id)).resolves.toStrictEqual(expect.objectContaining({ text: results.find((result) => result.applied)?.doc?.["text"] }));
    });

    it("rejects an unknown table", async () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        await expect(writer.patchIf("nope", "x", { patch: {}, where: {} })).rejects.toThrow(/unknown table: nope/u);
    });
});

describe("ctx-db patchIf (.global() routing)", () => {
    it("forwards a global table's conditional patch to the global writer", async () => {
        expect.assertions(2);

        const patchIf = vi.fn<NonNullable<DatabaseWriterLike["patchIf"]>>(async () => {
            return { applied: true, doc: { _id: "p1", userId: "u2" } };
        });
        const { writer } = setupWriter({ patchIf } as unknown as DatabaseWriterLike);
        const args = { patch: { userId: "u2" }, where: { userId: "u1" } };

        await expect(writer.patchIf("profiles", "p1", args)).resolves.toStrictEqual({ applied: true, doc: { _id: "p1", userId: "u2" } });
        expect(patchIf).toHaveBeenCalledWith("profiles", "p1", args);
    });

    it("refuses a global backend without a conditional write instead of reading then writing", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({ patch: vi.fn<DatabaseWriterLike["patch"]>() } as unknown as DatabaseWriterLike);

        await expect(writer.patchIf("profiles", "p1", { patch: { userId: "u2" }, where: { userId: "u1" } })).rejects.toThrow(/unsupported/u);
    });

    it("routes a global table's findFirst to the global writer", async () => {
        expect.assertions(2);

        const findMany = vi.fn<DatabaseWriterLike["findMany"]>(async () => {
            return { continueCursor: null, isDone: true, page: [{ _id: "p1", userId: "u1" }] };
        });
        const { writer } = setupWriter({ findMany } as unknown as DatabaseWriterLike);

        await expect(writer.findFirst("profiles", { where: { userId: "u1" } })).resolves.toStrictEqual({ _id: "p1", userId: "u1" });
        expect(findMany).toHaveBeenCalledWith("profiles", expect.objectContaining({ limit: 1, where: { userId: "u1" } }));
    });
});

describe("ctx-db findFirst by an indexed column (shard-local)", () => {
    it("reads through the declared index rather than scanning the table", async () => {
        expect.assertions(2);

        const { harness, seen, writer } = setupWriter();

        await writer.insertManyUnsafe(
            "messages",
            Array.from({ length: 500 }, (_, index) => {
                return { authorId: "a", channelId: `c${String(index % 50)}`, text: `t${String(index)}` };
            }),
        );
        seen.length = 0;

        await expect(writer.findFirst("messages", { where: { channelId: "c7" } })).resolves.toStrictEqual(expect.objectContaining({ channelId: "c7" }));

        const read = seen.findLast((entry) => entry.text.startsWith("SELECT"));
        const plan = harness
            .raw(`EXPLAIN QUERY PLAN ${read?.text ?? ""}`, ...(read?.params ?? []))
            .map((row) => String(row["detail"]))
            .join(" | ");

        expect(plan).toMatch(/USING INDEX \S*by_channel/u);
    });
});
