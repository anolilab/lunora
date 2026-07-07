import { describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, WriteHook } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

const fixedTime = 1_700_000_000_000;

// The batch methods are declared optional on `DatabaseWriterLike` (the `.global()`
// twins omit them — see ctx-db.ts), but the concrete DO writer always implements
// them. Narrow to the required shape so the test calls them without `?.`.
type BatchWriter = DatabaseWriterLike &
    Required<Pick<DatabaseWriterLike, "deleteMany" | "deleteWhere" | "insertMany" | "insertManyUnsafe" | "patchMany" | "patchWhere">>;

const setupWriter = (
    overrides: {
        broadcast?: BroadcastDelta;
        idGenerator?: () => string;
        onWrite?: WriteHook;
    } = {},
): {
    deltas: Parameters<BroadcastDelta>[0][];
    writer: BatchWriter;
} => {
    const { sql } = createSqliteExec();
    const deltas: Parameters<BroadcastDelta>[0][] = [];

    runShardMigrations(sql, messagesSchema);

    const writer = createShardContextDatabase({
        broadcast: overrides.broadcast ?? ((delta) => deltas.push(delta)),
        clock: () => fixedTime,
        idGenerator: overrides.idGenerator,
        onWrite: overrides.onWrite,
        schema: messagesSchema,
        sql,
    });

    return { deltas, writer: writer as BatchWriter };
};

const row = (n: number): Record<string, unknown> => {
    const suffix = String(n);

    return { authorId: `a${suffix}`, channelId: "c1", text: `t${suffix}` };
};

describe("ctx-db batch writes", () => {
    describe("insertMany", () => {
        it("inserts every document and returns the minted ids in input order", async () => {
            expect.assertions(3);

            const { writer } = setupWriter();

            const ids = await writer.insertMany("messages", [row(1), row(2), row(3)]);

            // The returned ids are in input order (one per document, sequential loop).
            expect(ids).toHaveLength(3);

            const page = await writer.findMany("messages", {});

            expect(page.page).toHaveLength(3);
            // Every minted id was persisted (read-back order is by the table's
            // sort, not insertion order, so compare as a set).
            expect(new Set(page.page.map((document) => document["_id"]))).toStrictEqual(new Set(ids));
        });

        it("broadcasts one insert delta per row", async () => {
            expect.assertions(2);

            const { deltas, writer } = setupWriter();

            await writer.insertMany("messages", [row(1), row(2)]);

            expect(deltas).toHaveLength(2);
            expect(deltas.every((delta) => delta.op === "insert")).toBe(true);
        });

        it("fires the write hook once per row", async () => {
            expect.assertions(1);

            const onWrite = vi.fn<WriteHook>();
            const { writer } = setupWriter({ onWrite });

            await writer.insertMany("messages", [row(1), row(2), row(3)]);

            expect(onWrite).toHaveBeenCalledTimes(3);
        });

        it("is a no-op for an empty batch", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            const ids = await writer.insertMany("messages", []);

            expect(ids).toStrictEqual([]);
            await expect(writer.findMany("messages", {}).then((p) => p.page)).resolves.toHaveLength(0);
        });

        it("rejects a batch larger than the default limit before any write", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();
            const tooMany = Array.from({ length: 501 }, (_, index) => row(index));

            await expect(writer.insertMany("messages", tooMany)).rejects.toThrow(/exceeds the limit of 500/);
            // Nothing was written — the cap is checked up front.
            await expect(writer.findMany("messages", {}).then((p) => p.page)).resolves.toHaveLength(0);
        });

        it("honors a raised options.limit", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();
            const batch = Array.from({ length: 501 }, (_, index) => row(index));

            const ids = await writer.insertMany("messages", batch, { limit: 1000 });

            expect(ids).toHaveLength(501);
        });

        it("rejects a batch over a lowered options.limit", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await expect(writer.insertMany("messages", [row(1), row(2), row(3)], { limit: 2 })).rejects.toThrow(/batch of 3 exceeds the limit of 2/);
        });

        it("skipDuplicates turns unique breaches into null results without failing the batch", async () => {
            expect.assertions(4);

            const { writer } = setupWriter();

            // The messages schema has a unique index on `text`, so a duplicate
            // text triggers a unique-constraint breach.
            await writer.insertMany("messages", [row(1)]);
            const second = await writer.insertMany(
                "messages",
                [
                    { authorId: "a1", channelId: "c1", text: "t1" }, // duplicate text
                    { authorId: "a2", channelId: "c1", text: "t2" },
                ],
                { skipDuplicates: true },
            );

            expect(second).toStrictEqual([null, expect.any(String)]);
            expect(second[1]).not.toBeNull();

            const page = await writer.findMany("messages", {});

            expect(page.page).toHaveLength(2);
            expect(new Set(page.page.map((document) => document["text"]))).toStrictEqual(new Set(["t1", "t2"]));
        });
    });

    describe("deleteMany", () => {
        it("deletes every id and returns the count", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();
            const ids = (await writer.insertMany("messages", [row(1), row(2), row(3)])) as string[];

            const result = await writer.deleteMany(ids);

            expect(result).toStrictEqual({ deleted: 3 });
            await expect(writer.findMany("messages", {}).then((p) => p.page)).resolves.toHaveLength(0);
        });

        it("rejects a batch larger than the limit", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();
            const ids = Array.from({ length: 501 }, (_, index) => `m${String(index)}`);

            await expect(writer.deleteMany(ids)).rejects.toThrow(/exceeds the limit of 500/);
        });

        it("deleteWhere removes every row matching the predicate", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            await writer.insertMany("messages", [
                { authorId: "a1", channelId: "c1", text: "x" },
                { authorId: "a1", channelId: "c2", text: "y" },
                { authorId: "a2", channelId: "c1", text: "z" },
            ]);

            const result = await writer.deleteWhere("messages", { authorId: "a1" });

            expect(result).toStrictEqual({ deleted: 2 });
            await expect(writer.findMany("messages", {}).then((page) => page.page)).resolves.toHaveLength(1);
        });
    });

    describe("patchMany", () => {
        it("applies each patch by id and returns the patched count", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();
            const ids = (await writer.insertMany("messages", [row(1), row(2)])) as string[];

            const result = await writer.patchMany(
                ids.map((id, index) => {
                    return { id, patch: { text: `patched-${String(index)}` } };
                }),
            );

            const texts = await writer.findMany("messages", {}).then((page) => new Set(page.page.map((document) => document["text"])));

            // Order-independent: every row received its patch (read-back order is by table sort).
            expect(texts).toStrictEqual(new Set(["patched-0", "patched-1"]));
            expect(result).toStrictEqual({ patched: 2 });
        });

        it("rejects a batch larger than the limit", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();
            const patches = Array.from({ length: 501 }, (_, index) => {
                return { id: `m${String(index)}`, patch: { text: "x" } };
            });

            await expect(writer.patchMany(patches)).rejects.toThrow(/exceeds the limit of 500/);
        });

        it("patchWhere applies the same patch to every row matching the predicate", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            await writer.insertMany("messages", [
                { authorId: "a1", channelId: "c1", text: "x" },
                { authorId: "a1", channelId: "c2", text: "y" },
                { authorId: "a2", channelId: "c1", text: "z" },
            ]);

            const result = await writer.patchWhere("messages", { where: { authorId: "a1" }, patch: { channelId: "patched" } });

            expect(result).toStrictEqual({ patched: 2 });

            const channelIds = await writer.findMany("messages", {}).then((page) => new Set(page.page.map((document) => document["channelId"])));

            expect(channelIds).toStrictEqual(new Set(["c1", "patched"]));
        });
    });

    describe("insertManyUnsafe", () => {
        it("inserts every document in one statement and returns the minted ids", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            const ids = await writer.insertManyUnsafe("messages", [row(1), row(2), row(3)]);

            expect(ids).toHaveLength(3);
            await expect(writer.findMany("messages", {}).then((p) => p.page)).resolves.toHaveLength(3);
        });

        it("still maintains companions — the UNIQUE by_text index rejects a dup", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            // Only validators + triggers are skipped; SQL constraints + companion
            // indexes are still enforced, so two rows with the same `text` violate
            // the UNIQUE `by_text` index (the whole single-statement INSERT fails).
            await expect(
                writer.insertManyUnsafe("messages", [
                    { authorId: "a", channelId: "c1", text: "dup" },
                    { authorId: "b", channelId: "c1", text: "dup" },
                ]),
            ).rejects.toThrow(/unique constraint/i);
        });

        it("broadcasts one insert delta per row", async () => {
            expect.assertions(2);

            const { deltas, writer } = setupWriter();

            await writer.insertManyUnsafe("messages", [row(1), row(2)]);

            expect(deltas).toHaveLength(2);
            expect(deltas.every((delta) => delta.op === "insert")).toBe(true);
        });

        it("is a no-op for an empty batch", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await expect(writer.insertManyUnsafe("messages", [])).resolves.toStrictEqual([]);
        });

        it("rejects a batch larger than the limit before any write", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();
            const tooMany = Array.from({ length: 501 }, (_, index) => row(index));

            await expect(writer.insertManyUnsafe("messages", tooMany)).rejects.toThrow(/exceeds the limit of 500/);
            await expect(writer.findMany("messages", {}).then((p) => p.page)).resolves.toHaveLength(0);
        });

        it("preserves an explicit _id with allowExplicitId", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            const ids = await writer.insertManyUnsafe("messages", [{ _id: "fixed-1", authorId: "a", channelId: "c1", text: "x" }], { allowExplicitId: true });

            expect(ids).toStrictEqual(["fixed-1"]);
        });

        it("forwards allowExplicitId across the .global() boundary (preserves _id on imports)", async () => {
            expect.assertions(2);

            // Regression for the thermos HIGH: the global branch must forward
            // `allowExplicitId` to the D1 writer, else a trusted import into a
            // `.global()` table is silently re-keyed. The mock honors the id only
            // when the option is forwarded, so a dropped option yields "minted".
            const calls: { options: unknown }[] = [];
            const globalDb = {
                insert: async (_table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => {
                    calls.push({ options });

                    return options?.allowExplicitId === true && typeof document["_id"] === "string" ? document["_id"] : "minted";
                },
            } as unknown as DatabaseWriterLike;

            const { sql } = createSqliteExec();

            runShardMigrations(sql, messagesSchema);

            const writer = createShardContextDatabase({ clock: () => fixedTime, globalDb, schema: messagesSchema, sql }) as BatchWriter;

            // `profiles` is declared `.global()` in messagesSchema → routes to globalDb.
            const ids = await writer.insertManyUnsafe("profiles", [{ _id: "p_fixed", userId: "u1" }], { allowExplicitId: true });

            expect(ids).toStrictEqual(["p_fixed"]);
            expect(calls[0]?.options).toStrictEqual({ allowExplicitId: true });
        });
    });
});
