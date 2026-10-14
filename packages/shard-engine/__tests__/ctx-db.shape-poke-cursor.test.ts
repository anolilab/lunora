import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runShardMigrations } from "../src/ctx-db";
import {
    deleteShapePokeCursor,
    deleteShapePokeCursorsForConnection,
    migrateShapePokeCursor,
    readShapePokeCursor,
    writeShapePokeCursor,
} from "../src/ctx-db-shape-poke-cursor";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The `__shape_poke_cursor` table: the durable per-socket poke baseline for
 * op-log-backed shape subscriptions (plan 326). It rides the CDC gate (an
 * op-log-backed shape diffs against `__cdc_log`, which requires CDC), so
 * `runShardMigrations(..., { cdc: true })` creates it and a non-CDC shard
 * never pays for it. `ShardDO.pokeShapeSubscribers` reads it on a cold
 * in-memory memo (post-hibernation) instead of falling back to a bare `0`,
 * which would otherwise force a full `__cdc_log` rescan on every wake.
 */

let harness: ReturnType<typeof createSqliteExec>;

const tableExists = (name: string): boolean => harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

describe("ctx-db shape poke cursor", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("is created with CDC and absent without it", () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, messagesSchema, { cdc: false });

        expect(tableExists("__shape_poke_cursor")).toBe(false);

        harness.close();
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });

        expect(tableExists("__shape_poke_cursor")).toBe(true);
    });

    it("reads undefined for an unseen subscription", () => {
        expect.assertions(1);

        migrateShapePokeCursor(harness.sql);

        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-a")).toBeUndefined();
    });

    it("writes and reads back per (connection, sub), isolated by subscription", () => {
        expect.assertions(3);

        migrateShapePokeCursor(harness.sql);

        writeShapePokeCursor(harness.sql, "conn-1", "sub-a", 5);
        writeShapePokeCursor(harness.sql, "conn-1", "sub-b", 9);

        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-a")).toBe(5);
        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-b")).toBe(9);
        expect(readShapePokeCursor(harness.sql, "conn-2", "sub-a")).toBeUndefined();
    });

    it("upserts (last write wins, no duplicate rows)", () => {
        expect.assertions(2);

        migrateShapePokeCursor(harness.sql);

        writeShapePokeCursor(harness.sql, "conn-1", "sub-a", 5);
        writeShapePokeCursor(harness.sql, "conn-1", "sub-a", 12);

        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-a")).toBe(12);
        expect(harness.raw("SELECT COUNT(*) AS n FROM __shape_poke_cursor")[0]?.["n"]).toBe(1);
    });

    it("deletes a single subscription's cursor without touching siblings", () => {
        expect.assertions(2);

        migrateShapePokeCursor(harness.sql);

        writeShapePokeCursor(harness.sql, "conn-1", "sub-a", 5);
        writeShapePokeCursor(harness.sql, "conn-1", "sub-b", 9);

        deleteShapePokeCursor(harness.sql, "conn-1", "sub-a");

        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-a")).toBeUndefined();
        expect(readShapePokeCursor(harness.sql, "conn-1", "sub-b")).toBe(9);
    });

    it("deletes every cursor for a connection, leaving other connections untouched", () => {
        expect.assertions(2);

        migrateShapePokeCursor(harness.sql);

        writeShapePokeCursor(harness.sql, "conn-1", "sub-a", 5);
        writeShapePokeCursor(harness.sql, "conn-1", "sub-b", 9);
        writeShapePokeCursor(harness.sql, "conn-2", "sub-a", 3);

        deleteShapePokeCursorsForConnection(harness.sql, "conn-1");

        expect(harness.raw("SELECT COUNT(*) AS n FROM __shape_poke_cursor")[0]?.["n"]).toBe(1);
        expect(readShapePokeCursor(harness.sql, "conn-2", "sub-a")).toBe(3);
    });
});
