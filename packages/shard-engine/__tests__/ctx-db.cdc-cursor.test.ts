import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import { bumpCdcEpoch, CDC_LOG_TABLE, minCdcSeq, readCdcCursor, readCdcEpoch, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The subscription resume cursor (Pillar 1b) advertises the `__cdc_log`
 * high-watermark on every `data`/`delta` frame so a reconnecting client can
 * resume from it. `readCdcCursor` must keep returning that high-watermark even
 * after `trimCdcChanges` deletes the row carrying it (retention compaction),
 * and `minCdcSeq` must report the new retention floor so the server can detect
 * a client whose `sinceSeq` fell off the back of the log.
 */

let harness: ReturnType<typeof createSqliteExec>;

const append = (sql: SqlExec, table: string, id: string): void => {
    // Insert without `seq` so AUTOINCREMENT assigns it (and advances
    // sqlite_sequence) exactly as `appendCdcChange` does in production.
    sql.exec(`INSERT INTO "${CDC_LOG_TABLE}" (ts, "table", id, op, doc) VALUES (?, ?, ?, ?, ?)`, 1, table, id, "insert", null);
};

describe("ctx-db cdc cursor helpers", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        runShardMigrations(harness.sql, messagesSchema, { cdc: true });
    });

    afterEach(() => {
        harness.close();
    });

    it("reports 0 for an empty changelog", () => {
        expect.assertions(2);

        expect(readCdcCursor(harness.sql)).toBe(0);
        expect(minCdcSeq(harness.sql)).toBeUndefined();
    });

    it("mints a stable epoch and rolls it on bump", () => {
        expect.assertions(3);

        const first = readCdcEpoch(harness.sql);

        // Stable across reads — the same minted value is returned, not re-minted.
        expect(readCdcEpoch(harness.sql)).toBe(first);

        // A bump rolls it to a fresh value (timeline fork) that then persists.
        const bumped = bumpCdcEpoch(harness.sql);

        expect(bumped).not.toBe(first);
        expect(readCdcEpoch(harness.sql)).toBe(bumped);
    });

    it("tracks the high-watermark as changes are appended", () => {
        expect.assertions(2);

        append(harness.sql, "messages", "m-1");
        append(harness.sql, "messages", "m-2");
        append(harness.sql, "messages", "m-3");

        expect(readCdcCursor(harness.sql)).toBe(3);
        expect(minCdcSeq(harness.sql)).toBe(1);
    });

    it("keeps the high-watermark after a trim deletes the newest retained row", () => {
        expect.assertions(3);

        append(harness.sql, "messages", "m-1");
        append(harness.sql, "messages", "m-2");
        append(harness.sql, "messages", "m-3");

        // Compact the whole log — the row carrying seq=3 is gone, but the cursor
        // must not regress to 0 or a reconnecting client would replay forever.
        harness.sql.exec(`DELETE FROM "${CDC_LOG_TABLE}"`);

        expect(readCdcCursor(harness.sql)).toBe(3);
        // The log is empty, so there is no retention floor to advertise.
        expect(minCdcSeq(harness.sql)).toBeUndefined();

        // A fresh change continues from the high-watermark, never reusing seq.
        append(harness.sql, "messages", "m-4");

        expect(readCdcCursor(harness.sql)).toBe(4);
    });

    it("advances the retention floor after a partial trim", () => {
        expect.assertions(2);

        append(harness.sql, "messages", "m-1");
        append(harness.sql, "messages", "m-2");
        append(harness.sql, "messages", "m-3");

        harness.sql.exec(`DELETE FROM "${CDC_LOG_TABLE}" WHERE seq <= ?`, 1);

        expect(minCdcSeq(harness.sql)).toBe(2);
        expect(readCdcCursor(harness.sql)).toBe(3);
    });
});
