import { describe, expect, it } from "vitest";

import type { FunctionCallStat, MetricsIndexHit } from "../src/admin";
import { declaredIndexesFor, deriveRuntimeAdvisories } from "../src/derive-runtime-advisories";

/** A used index — recorded reads > 0, so it must NOT be flagged dead. */
const USED_HIT: MetricsIndexHit = { index: "byAuthor", reads: 12, table: "posts" };

/** A function stat that full-scanned `events` hot enough to clear the lint threshold (25). */
const HOT_SCAN_FN: FunctionCallStat = {
    calls: 40,
    errors: 0,
    lastCalledAt: 1000,
    lastErrorAt: null,
    lastErrorMessage: null,
    maxDurationMs: 4200,
    path: "feed:list",
    scannedTables: [{ scans: 40, table: "events" }],
    scans: 40,
    totalDurationMs: 9000,
};

describe("deriveRuntimeAdvisories", () => {
    it("flags a declared index absent from the recorded read feed as dead", () => {
        expect.assertions(3);

        // `byTitle` is declared but never recorded a read → reconciles to reads:0 → dead.
        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [{ index: "byTitle", table: "posts" }],
            functions: [],
            indexHits: [],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.issueType).toBe("Index utilization");
        expect(rows[0]?.description).toContain('Index "byTitle" on table "posts" has recorded no reads');
    });

    it("flags a declared index recorded with zero reads as dead", () => {
        expect.assertions(2);

        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [{ index: "byTitle", table: "posts" }],
            functions: [],
            indexHits: [{ index: "byTitle", reads: 0, table: "posts" }],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.entity).toBe("posts");
    });

    it("does not flag a declared index with recorded reads > 0", () => {
        expect.assertions(1);

        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [{ index: "byAuthor", table: "posts" }],
            functions: [],
            indexHits: [USED_HIT],
        });

        expect(rows).toHaveLength(0);
    });

    it("sums recorded reads across shards before judging an index dead", () => {
        expect.assertions(1);

        // Two per-shard rows for the same index, each reads:0 individually but the
        // index IS declared — still dead. Here one shard recorded a read, so the
        // sum is > 0 and it is NOT flagged.
        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [{ index: "byAuthor", table: "posts" }],
            functions: [],
            indexHits: [
                { index: "byAuthor", reads: 0, table: "posts" },
                { index: "byAuthor", reads: 3, table: "posts" },
            ],
        });

        expect(rows).toHaveLength(0);
    });

    it("flags a hot full-scanned table over the threshold", () => {
        expect.assertions(3);

        const rows = deriveRuntimeAdvisories({ declaredIndexes: [], functions: [HOT_SCAN_FN], indexHits: [] });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.entity).toBe("events");
        expect(rows[0]?.description).toContain('Table "events" has been full-scanned 40 times');
    });

    it("aggregates scans for the same table across multiple functions", () => {
        expect.assertions(2);

        // 15 + 15 = 30 scans of `events`, clearing the 25 threshold only once summed.
        const a: FunctionCallStat = { ...HOT_SCAN_FN, path: "a:x", scannedTables: [{ scans: 15, table: "events" }], scans: 15 };
        const b: FunctionCallStat = { ...HOT_SCAN_FN, path: "b:y", scannedTables: [{ scans: 15, table: "events" }], scans: 15 };

        const rows = deriveRuntimeAdvisories({ declaredIndexes: [], functions: [a, b], indexHits: [] });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.description).toContain("full-scanned 30 times");
    });

    it("does not flag a table scanned below the threshold", () => {
        expect.assertions(1);

        const cool: FunctionCallStat = { ...HOT_SCAN_FN, scannedTables: [{ scans: 3, table: "events" }], scans: 3 };
        const rows = deriveRuntimeAdvisories({ declaredIndexes: [], functions: [cool], indexHits: [] });

        expect(rows).toHaveLength(0);
    });

    it("returns no rows and does not throw on empty / missing inputs", () => {
        expect.assertions(2);

        expect(deriveRuntimeAdvisories({})).toStrictEqual([]);
        expect(deriveRuntimeAdvisories({ declaredIndexes: [], functions: null, indexHits: null })).toStrictEqual([]);
    });

    it("ignores recorded reads for an index that is not declared (a stale dropped index)", () => {
        expect.assertions(1);

        // The feed mentions `byOld`, but it isn't declared → not reconciled, so no
        // dead-index row. Only declared indexes can be dead overhead.
        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [],
            functions: [],
            indexHits: [{ index: "byOld", reads: 0, table: "posts" }],
        });

        expect(rows).toHaveLength(0);
    });

    it("derives both halves at once: a dead index and a hot scan", () => {
        expect.assertions(1);

        const rows = deriveRuntimeAdvisories({
            declaredIndexes: [{ index: "byTitle", table: "posts" }],
            functions: [HOT_SCAN_FN],
            indexHits: [],
        });

        expect(rows).toHaveLength(2);
    });
});

describe("declaredIndexesFor", () => {
    it("flattens a table's index list into { table, index } pairs", () => {
        expect.assertions(1);

        const pairs = declaredIndexesFor("posts", [
            { fields: ["authorId"], name: "byAuthor", type: "index" },
            { fields: ["title"], name: "byTitle", type: "index" },
        ]);

        expect(pairs).toStrictEqual([
            { index: "byAuthor", table: "posts" },
            { index: "byTitle", table: "posts" },
        ]);
    });
});
