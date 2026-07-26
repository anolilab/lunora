import { describe, expect, it } from "vitest";

import type { DatabaseWriterLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

const fixedTime = 1_700_000_000_000;

/**
 * The erase primitives are declared optional on `DatabaseWriterLike` (the
 * `.global()` twins omit them), but the concrete DO writer always implements them.
 */
type EraseWriter = DatabaseWriterLike & Required<Pick<DatabaseWriterLike, "asId" | "deleteAll" | "insertMany" | "wipeShard">>;

const setupWriter = (): EraseWriter => {
    const { sql } = createSqliteExec();

    runShardMigrations(sql, messagesSchema);

    return createShardContextDatabase({
        broadcast: () => undefined,
        clock: () => fixedTime,
        schema: messagesSchema,
        sql,
    }) as EraseWriter;
};

const message = (n: number): Record<string, unknown> => {
    const suffix = String(n);

    return { authorId: `a${suffix}`, channelId: "c1", text: `t${suffix}` };
};

describe("ctx-db.deleteAll", () => {
    it("erases every row past the batch cap that deleteWhere would reject", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        // The default batch cap is 500. `deleteWhere(table, {})` throws
        // BATCH_LIMIT_EXCEEDED here — which is the whole reason `deleteAll` exists:
        // an erasure that stops at row 500 is a bug, not a safety rail.
        const documents = Array.from({ length: 620 }, (_unused, index) => message(index));

        for (let offset = 0; offset < documents.length; offset += 200) {
            // eslint-disable-next-line no-await-in-loop -- seeding within the insertMany cap
            await writer.insertMany("messages", documents.slice(offset, offset + 200));
        }

        const result = await writer.deleteAll("messages");

        expect(result).toStrictEqual({ deleted: 620 });

        const remaining = await writer.count("messages");

        expect(remaining).toBe(0);
    });

    it("honors a custom chunk size", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insertMany("messages", [message(1), message(2), message(3), message(4), message(5)]);

        const result = await writer.deleteAll("messages", { chunkSize: 2 });

        expect(result).toStrictEqual({ deleted: 5 });
        await expect(writer.count("messages")).resolves.toBe(0);
    });

    it("is a no-op on an already-empty table", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await expect(writer.deleteAll("messages")).resolves.toStrictEqual({ deleted: 0 });
    });

    it("actually erases a .global() table instead of no-op'ing through a pinned id", async () => {
        expect.assertions(3);

        // A `.global()` row lives in D1, so the by-id delete only reaches it through
        // `globalFallback()` — which is skipped when a table is pinned (the by-id IDOR
        // guard). Pinning here made every delete a silent no-op: an inflated count,
        // surviving rows, and an infinite loop once the table held >= chunkSize rows.
        const rows = new Map<string, Record<string, unknown>>([
            ["p1", { _id: "p1", userId: "u1" }],
            ["p2", { _id: "p2", userId: "u2" }],
        ]);
        const globalDb = {
            delete: async (id: string) => {
                rows.delete(id);
            },
            findMany: async () => {
                return { continueCursor: null, isDone: true, page: [...rows.values()] };
            },
        } as unknown as DatabaseWriterLike;

        const { sql } = createSqliteExec();

        runShardMigrations(sql, messagesSchema);

        const writer = createShardContextDatabase({
            broadcast: () => undefined,
            clock: () => fixedTime,
            globalDb,
            schema: messagesSchema,
            sql,
        }) as EraseWriter;

        // `profiles` is declared `.global()` in messagesSchema.
        const result = await writer.deleteAll("profiles");

        expect(result).toStrictEqual({ deleted: 2 });
        // The rows are really gone — the count isn't just optimistic.
        expect([...rows.keys()]).toStrictEqual([]);

        // And the loop terminated (it would spin forever on a no-op delete).
        await expect(writer.deleteAll("profiles")).resolves.toStrictEqual({ deleted: 0 });
    });

    it("rejects an unknown table", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await expect(writer.deleteAll("nope")).rejects.toThrow("unknown table: nope");
    });
});

describe("ctx-db.wipeShard", () => {
    it("erases every shard-local table and reports per-table counts", async () => {
        expect.assertions(3);

        const writer = setupWriter();

        await writer.insertMany("messages", [message(1), message(2)]);
        await writer.insertMany("roomMembers", [
            { roomId: "r1", userId: "u1" },
            { roomId: "r1", userId: "u2" },
            { roomId: "r2", userId: "u1" },
        ]);

        const result = await writer.wipeShard();

        expect(result.deleted).toBe(5);
        expect(result.tables).toStrictEqual({ messages: 2, roomMembers: 3 });
        // `profiles` is `.global()` — its rows live in D1 and are shared across
        // shards, so a shard wipe must not even attempt them.
        expect(Object.keys(result.tables)).not.toContain("profiles");
    });

    it("restricts the sweep to the named tables", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insertMany("messages", [message(1)]);
        await writer.insertMany("roomMembers", [{ roomId: "r1", userId: "u1" }]);

        const result = await writer.wipeShard({ tables: ["messages"] });

        expect(result.tables).toStrictEqual({ messages: 1 });
        // The unnamed table is untouched.
        await expect(writer.count("roomMembers")).resolves.toBe(1);
    });

    it("spares an excluded table", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insertMany("messages", [message(1)]);
        await writer.insertMany("roomMembers", [{ roomId: "r1", userId: "u1" }]);

        const result = await writer.wipeShard({ exclude: ["roomMembers"] });

        expect(result.tables).toStrictEqual({ messages: 1 });
        await expect(writer.count("roomMembers")).resolves.toBe(1);
    });

    it("rejects an unknown table in `tables`", async () => {
        expect.assertions(1);

        const writer = setupWriter();

        await expect(writer.wipeShard({ tables: ["nope"] })).rejects.toThrow("wipeShard: unknown table: nope");
    });
});

describe("ctx-db.asId", () => {
    it("brands a well-formed id string", async () => {
        expect.assertions(1);

        const writer = setupWriter();
        const [id] = await writer.insertMany("messages", [message(1)]);

        expect(writer.asId("messages", String(id))).toBe(id);
    });

    it("throws on a malformed id instead of asserting it through", () => {
        expect.assertions(3);

        const writer = setupWriter();

        // Same structural check as `normalizeId` (ids are opaque strings — empty,
        // whitespace-bearing, or NUL-bearing values are not ids), but throwing, so a
        // call site gets the brand without writing `as Id<"messages">`. That cast
        // would let these reach the query layer.
        expect(() => writer.asId("messages", "")).toThrow('is not a valid id for table "messages"');
        expect(() => writer.asId("messages", "has space")).toThrow('is not a valid id for table "messages"');
        expect(() => writer.asId("messages", "\tid")).toThrow('is not a valid id for table "messages"');
    });
});
