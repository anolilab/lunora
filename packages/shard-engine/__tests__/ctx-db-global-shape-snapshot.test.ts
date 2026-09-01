import { describe, expect, it } from "vitest";

import {
    GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS,
    migrateGlobalShapeSnapshot,
    readGlobalShapeSnapshot,
    writeGlobalShapeSnapshot,
} from "../src/ctx-db-global-shape-snapshot";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The durable per-socket baseline for `.global()`-table shape subscriptions.
 * Both cases here are about telling apart states the table used to conflate.
 */
describe("global shape snapshot table", () => {
    it("distinguishes an absent row from a stored empty membership", () => {
        expect.assertions(3);

        const harness = createSqliteExec();

        try {
            migrateGlobalShapeSnapshot(harness.sql);

            // No row at all: the caller cannot diff against this, because a diff
            // against a fabricated empty baseline emits inserts and never a
            // `delete` — the phantom-row failure this table exists to prevent.
            expect(readGlobalShapeSnapshot(harness.sql, "conn-1", "g1")).toBeUndefined();

            // A REAL empty membership is a legitimate baseline and stays a map.
            writeGlobalShapeSnapshot(harness.sql, "conn-1", "g1", new Map<string, string>());

            expect(readGlobalShapeSnapshot(harness.sql, "conn-1", "g1")).toStrictEqual(new Map<string, string>());

            writeGlobalShapeSnapshot(harness.sql, "conn-1", "g1", new Map([["t1", '{"_id":"t1"}']]));

            expect(readGlobalShapeSnapshot(harness.sql, "conn-1", "g1")).toStrictEqual(new Map([["t1", '{"_id":"t1"}']]));
        } finally {
            harness.close();
        }
    });

    it("refuses a snapshot too large for one durable row, naming the subscription", () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        try {
            migrateGlobalShapeSnapshot(harness.sql);

            // The membership goes in as ONE JSON TEXT value and the only bound
            // above it was a 50,000-ROW cap, which says nothing about bytes.
            const wide = new Map<string, string>();
            const value = "x".repeat(10_000);

            for (let index = 0; index * 10_000 <= GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS; index += 1) {
                wide.set(`k${String(index)}`, value);
            }

            expect(() => {
                writeGlobalShapeSnapshot(harness.sql, "conn-1", "g1", wide);
            }).toThrow(/g1/u);
            expect(readGlobalShapeSnapshot(harness.sql, "conn-1", "g1")).toBeUndefined();
        } finally {
            harness.close();
        }
    });
});
