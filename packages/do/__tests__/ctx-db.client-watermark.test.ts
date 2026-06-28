import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { advanceClientWatermark, migrateClientWatermark, readClientWatermark, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The `__client_watermark` table: the per-client custom-mutator high-watermark.
 * It rides the CDC gate (custom mutators imply CDC), so `runShardMigrations(...,
 * { cdc: true })` creates it and a non-CDC shard never pays for it. The dispatch
 * path reads the watermark to classify an incoming `mutationId` (already
 * processed / next / out-of-order) and advances it monotonically.
 */

let harness: ReturnType<typeof createSqliteExec>;

const tableExists = (name: string): boolean => harness.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

describe("ctx-db client watermark", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("is created with CDC and absent without it", () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, messagesSchema, { cdc: false });

        expect(tableExists("__client_watermark")).toBe(false);

        harness.close();
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });

        expect(tableExists("__client_watermark")).toBe(true);
    });

    it("reads 0 for an unseen client", () => {
        expect.assertions(1);

        migrateClientWatermark(harness.sql);

        expect(readClientWatermark(harness.sql, "user-1", "client-a")).toBe(0);
    });

    it("advances and reads back per client, isolated by client id", () => {
        expect.assertions(3);

        migrateClientWatermark(harness.sql);

        advanceClientWatermark(harness.sql, "user-1", "client-a", 1);
        advanceClientWatermark(harness.sql, "user-1", "client-a", 2);
        advanceClientWatermark(harness.sql, "user-1", "client-b", 5);

        expect(readClientWatermark(harness.sql, "user-1", "client-a")).toBe(2);
        expect(readClientWatermark(harness.sql, "user-1", "client-b")).toBe(5);
        expect(readClientWatermark(harness.sql, "user-1", "client-c")).toBe(0);
    });

    it("isolates the watermark by identity so a reused client id can't cross users", () => {
        expect.assertions(2);

        migrateClientWatermark(harness.sql);

        // Same client id, two different authenticated identities — each keeps its
        // own counter, so one user can't suppress the other's sequence.
        advanceClientWatermark(harness.sql, "user-1", "shared-client", 9);

        expect(readClientWatermark(harness.sql, "user-2", "shared-client")).toBe(0);
        expect(readClientWatermark(harness.sql, "user-1", "shared-client")).toBe(9);
    });

    it("never regresses the watermark (monotonic MAX upsert)", () => {
        expect.assertions(1);

        migrateClientWatermark(harness.sql);

        advanceClientWatermark(harness.sql, "user-1", "client-a", 7);
        // A stale/out-of-order advance must not lower the high-watermark.
        advanceClientWatermark(harness.sql, "user-1", "client-a", 3);

        expect(readClientWatermark(harness.sql, "user-1", "client-a")).toBe(7);
    });
});
