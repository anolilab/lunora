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

        expect(readClientWatermark(harness.sql, "client-a")).toBe(0);
    });

    it("advances and reads back per client, isolated by client id", () => {
        expect.assertions(3);

        migrateClientWatermark(harness.sql);

        advanceClientWatermark(harness.sql, "client-a", 1);
        advanceClientWatermark(harness.sql, "client-a", 2);
        advanceClientWatermark(harness.sql, "client-b", 5);

        expect(readClientWatermark(harness.sql, "client-a")).toBe(2);
        expect(readClientWatermark(harness.sql, "client-b")).toBe(5);
        expect(readClientWatermark(harness.sql, "client-c")).toBe(0);
    });

    it("never regresses the watermark (monotonic MAX upsert)", () => {
        expect.assertions(1);

        migrateClientWatermark(harness.sql);

        advanceClientWatermark(harness.sql, "client-a", 7);
        // A stale/out-of-order advance must not lower the high-watermark.
        advanceClientWatermark(harness.sql, "client-a", 3);

        expect(readClientWatermark(harness.sql, "client-a")).toBe(7);
    });
});
