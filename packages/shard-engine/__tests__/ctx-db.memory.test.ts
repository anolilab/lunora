import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { clearMemoryTables, isMemoryTable, memoryTableNames } from "../src/ctx-db-memory";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `.memory()` — the ephemeral tier.
 *
 * Two properties are under test, and they are the two the feature actually
 * promises: the rows do not survive a shard restart (`clearMemoryTables`, which
 * the generated `runShardInit` calls on every cold start), and the writes never
 * reach the CDC changelog. Everything else about a memory table is deliberately
 * identical to a durable one — same migration, same indexes, same reads — so
 * there is nothing separate to assert about querying it.
 */
const schema: SchemaLike = {
    tables: {
        // Durable control.
        rooms: {
            indexes: [],
            shape: { name: { kind: "string" } },
        },
        presence: {
            indexes: [{ fields: ["roomId"], name: "by_room" }],
            memoryMode: true,
            shape: { roomId: { kind: "string" }, userId: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const writer = (): DatabaseWriterLike => createShardContextDatabase({ cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });

/** Row count of `table` through a fresh writer, projected off the await so the lint's await-member rule is satisfied. */
const rowCount = async (database: DatabaseWriterLike, table: string, where?: Record<string, unknown>): Promise<number> => {
    const result = await database.findMany(table, where === undefined ? {} : { where });

    return result.page.length;
};

/** The tables named in the changelog, in `seq` order. Projected to strings: `node:sqlite` rows have a null prototype, which no object matcher compares cleanly against a literal. */
const cdcTables = (): string[] =>
    harness.sql
        .exec('SELECT "table" AS t FROM __cdc_log ORDER BY seq')
        .toArray()
        .map((row) => String((row as { t: unknown }).t));

describe("ctx-db memory tables", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, schema, { cdc: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("identifies memory tables from the schema", () => {
        expect.assertions(3);

        expect(isMemoryTable(schema.tables["presence"])).toBe(true);
        expect(isMemoryTable(schema.tables["rooms"])).toBe(false);
        expect(memoryTableNames(schema)).toStrictEqual(["presence"]);
    });

    it("migrates a memory table like any other, so reads work unchanged", async () => {
        expect.assertions(2);

        const database = writer();

        await database.insert("presence", { roomId: "r1", userId: "u1" });
        await database.insert("presence", { roomId: "r2", userId: "u2" });

        // The declared index is a plain SQLite index and answers normally.
        const inRoom = await database.findMany("presence", { where: { roomId: "r1" } });

        expect(inRoom.page).toHaveLength(1);
        expect(inRoom.page[0]?.["userId"]).toBe("u1");
    });

    it("keeps memory writes out of the CDC changelog while durable writes land", async () => {
        expect.assertions(1);

        const database = writer();

        await database.insert("rooms", { name: "general" });
        await database.insert("presence", { roomId: "r1", userId: "u1" });
        await database.insert("presence", { roomId: "r1", userId: "u2" });

        // Only the durable insert is in the log. This is not a size optimisation:
        // the log is append-only with no trim caller in `ShardDO`, so a
        // heartbeat-rate presence table would grow it for the life of the shard,
        // and a CDC consumer replaying it would materialize state the shard
        // itself drops on the next eviction.
        expect(cdcTables()).toStrictEqual(["rooms"]);
    });

    it("clears memory tables and leaves durable ones untouched", async () => {
        expect.assertions(4);

        const seed = writer();

        await seed.insert("rooms", { name: "general" });
        await seed.insert("presence", { roomId: "r1", userId: "u1" });

        await expect(rowCount(seed, "presence")).resolves.toBe(1);

        // What `runShardInit` does on every cold start.
        expect(clearMemoryTables(harness.sql, schema)).toBe(1);

        const after = writer();

        await expect(rowCount(after, "presence")).resolves.toBe(0);
        await expect(rowCount(after, "rooms")).resolves.toBe(1);
    });

    it("leaves the table usable after a clear", async () => {
        expect.assertions(1);

        const seed = writer();

        await seed.insert("presence", { roomId: "r1", userId: "u1" });
        clearMemoryTables(harness.sql, schema);

        // `DELETE FROM`, not `DROP` — the table and its index survive, which is
        // what lets an `onShardInit` hook refill it immediately.
        const rebuilt = writer();

        await rebuilt.insert("presence", { roomId: "r1", userId: "u2" });

        await expect(rowCount(rebuilt, "presence", { roomId: "r1" })).resolves.toBe(1);
    });
});
