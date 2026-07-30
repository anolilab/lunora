import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    cursorAfter,
    deserializeCursor,
    maxCursorValue,
    migrateSourceCursor,
    readSourceCursor,
    serializeCursor,
    writeSourceCursor,
} from "../src/external-source-cursor";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Durable cursor/watermark storage for incremental external-source ingest
 * (plan 136): the type-tagged serialization round-trip, the monotonic
 * high-watermark tracking, and the `__lunora_source_cursor` meta table.
 */

describe("cursor serialization", () => {
    it("round-trips a number", () => {
        expect.assertions(2);

        expect(serializeCursor(42)).toBe("n:42");
        expect(deserializeCursor("n:42")).toBe(42);
    });

    it("round-trips a bigint (no Number precision loss)", () => {
        expect.assertions(2);

        const big = 9_007_199_254_740_993n; // 2^53 + 1

        expect(serializeCursor(big)).toBe("b:9007199254740993");
        expect(deserializeCursor(serializeCursor(big))).toBe(big);
    });

    it("round-trips a Date as ISO", () => {
        expect.assertions(2);

        const date = new Date("2026-07-17T10:00:00.000Z");

        expect(serializeCursor(date)).toBe("d:2026-07-17T10:00:00.000Z");
        expect(deserializeCursor("d:2026-07-17T10:00:00.000Z")).toStrictEqual(date);
    });

    it("round-trips a string (default tag)", () => {
        expect.assertions(2);

        expect(serializeCursor("abc")).toBe("s:abc");
        expect(deserializeCursor("s:abc")).toBe("abc");
    });
});

describe("cursorAfter", () => {
    it("orders numbers numerically (not lexically)", () => {
        expect.assertions(2);

        expect(cursorAfter(10, 9)).toBe(true);
        expect(cursorAfter(9, 10)).toBe(false);
    });

    it("orders ISO timestamp strings correctly (lexical == chronological)", () => {
        expect.assertions(1);

        expect(cursorAfter("2026-07-17T10:00:01.000Z", "2026-07-17T10:00:00.000Z")).toBe(true);
    });

    it("orders Dates by instant", () => {
        expect.assertions(1);

        expect(cursorAfter(new Date("2026-07-17T10:00:01Z"), new Date("2026-07-17T10:00:00Z"))).toBe(true);
    });

    it("orders numeric-string columns numerically, not lexically (Postgres bigint/numeric come back as strings)", () => {
        expect.assertions(3);

        // The bug: lexically `"9" > "10"` is true, which would strand the watermark.
        expect(cursorAfter("9", "10")).toBe(false);
        expect(cursorAfter("10", "9")).toBe(true);
        // Beyond 2^53 — integer strings compare via BigInt, precision-safe.
        expect(cursorAfter("9007199254740993", "9007199254740992")).toBe(true);
    });

    it("keeps lexical order for non-numeric (ISO timestamp) strings", () => {
        expect.assertions(1);

        expect(cursorAfter("2026-07-17T10:00:01.000Z", "2026-07-17T10:00:00.000Z")).toBe(true);
    });
});

describe("maxCursorValue", () => {
    it("returns the serialized max across the slice and the current watermark", () => {
        expect.assertions(1);

        const rows = [{ updated_at: 5 }, { updated_at: 9 }, { updated_at: 7 }];

        expect(maxCursorValue(rows, "updated_at", "n:6")).toBe("n:9");
    });

    it("keeps the current watermark when the slice adds nothing higher", () => {
        expect.assertions(1);

        expect(maxCursorValue([{ updated_at: 3 }], "updated_at", "n:10")).toBe("n:10");
    });

    it("seeds from an empty (null) watermark", () => {
        expect.assertions(1);

        expect(maxCursorValue([{ updated_at: 3 }, { updated_at: 8 }], "updated_at", null)).toBe("n:8");
    });

    it("advances a numeric-string (bigint column) watermark by numeric value, not lexically", () => {
        expect.assertions(1);

        // Without numeric-aware compare this would strand at "9" (lexically the max).
        expect(maxCursorValue([{ seq: "9" }, { seq: "10" }, { seq: "100" }], "seq", "s:8")).toBe("s:100");
    });

    it("skips rows missing the cursor column (never corrupts the mark)", () => {
        expect.assertions(1);

        expect(maxCursorValue([{ other: 1 }, { updated_at: null }, { updated_at: 4 }], "updated_at", null)).toBe("n:4");
    });

    it("returns null for an all-empty slice and no current watermark", () => {
        expect.assertions(1);

        expect(maxCursorValue([{ other: 1 }], "updated_at", null)).toBeNull();
    });
});

describe("__lunora_source_cursor table", () => {
    let harness: ReturnType<typeof createSqliteExec>;

    beforeEach(() => {
        harness = createSqliteExec();
        migrateSourceCursor(harness.sql);
    });

    afterEach(() => {
        harness.close();
    });

    it("reads the initial all-null state for an unseen (table, shard)", () => {
        expect.assertions(1);

        expect(readSourceCursor(harness.sql, "documents", "tenant-a")).toStrictEqual({ lastReconcileMs: null, watermark: null });
    });

    it("upserts and reads back the state per (table, shard)", () => {
        expect.assertions(2);

        writeSourceCursor(harness.sql, "documents", "tenant-a", { lastReconcileMs: 1000, watermark: "n:5" });
        writeSourceCursor(harness.sql, "documents", "tenant-b", { lastReconcileMs: 2000, watermark: "n:9" });

        expect(readSourceCursor(harness.sql, "documents", "tenant-a")).toStrictEqual({ lastReconcileMs: 1000, watermark: "n:5" });
        expect(readSourceCursor(harness.sql, "documents", "tenant-b")).toStrictEqual({ lastReconcileMs: 2000, watermark: "n:9" });
    });

    it("overwrites on a second write for the same key", () => {
        expect.assertions(1);

        writeSourceCursor(harness.sql, "documents", "tenant-a", { lastReconcileMs: 1000, watermark: "n:5" });
        writeSourceCursor(harness.sql, "documents", "tenant-a", { lastReconcileMs: 3000, watermark: "n:12" });

        expect(readSourceCursor(harness.sql, "documents", "tenant-a")).toStrictEqual({ lastReconcileMs: 3000, watermark: "n:12" });
    });

    it("is idempotent to migrate twice", () => {
        expect.assertions(1);

        expect(() => {
            migrateSourceCursor(harness.sql);
        }).not.toThrow();
    });
});
