import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import filterWithoutIndex from "../src/lints/static/filter-without-index";
import unboundedCollect from "../src/lints/static/unbounded-collect";
import type { AdvisorQueryRead } from "../src/queries";

/** One table per storage tier, so the lint's tier wording can be exercised across all three. */
const schema = () =>
    fromServerSchema(
        defineSchema({
            catalog: defineTable({ sku: v.string() }).global(),
            notes: defineTable({ text: v.string() }),
            threadAccess: defineTable({ role: v.string(), userId: v.string() }).shardBy("userId"),
        }),
    );

/** A bare `ctx.db.query(table).collect()` — no index, no filter. */
const read = (table: string, overrides: Partial<AdvisorQueryRead> = {}): AdvisorQueryRead => {
    return { exportName: "list", file: "notes", hasFilter: false, hasIndex: false, line: 4, table, terminal: "collect", ...overrides };
};

describe("unbounded_collect", () => {
    it("flags an unindexed, unfiltered collect on a root table and names the subscription cost", () => {
        expect.assertions(3);

        const findings = unboundedCollect.run({ queries: [read("notes")], schema: schema() });

        expect(findings[0]).toMatchObject({ cacheKey: "unbounded_collect:notes:4:notes", level: "WARN", name: "unbounded_collect" });
        expect(findings[0]?.detail).toContain("root Durable Object's SQLite");
        // The WebSocket half is the point of the lint, not a footnote: an
        // unindexed read records a whole-table dependency, so the DO's refresh
        // gate cannot skip it and re-sends the full result per socket per write.
        expect(findings[0]?.detail).toContain("re-sends the full result to each subscribed socket");
    });

    it("keeps a global table at WARN and names the cross-region cost", () => {
        expect.assertions(2);

        const findings = unboundedCollect.run({ queries: [read("catalog")], schema: schema() });

        expect(findings[0]).toMatchObject({ level: "WARN", metadata: { shardKind: "global" } });
        expect(findings[0]?.detail).toContain("whole D1 table");
    });

    it("drops a shardBy table to INFO — the read is scoped to one shard", () => {
        expect.assertions(2);

        const findings = unboundedCollect.run({ queries: [read("threadAccess")], schema: schema() });

        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { shardKind: "shardBy" } });
        expect(findings[0]?.detail).toContain("one shard's rows");
    });

    it("defers to filter_without_index rather than double-reporting a filtered read", () => {
        expect.assertions(2);

        // Both would otherwise fire on `.filter(...).collect()` with no index,
        // and both remediations name the same `.withIndex(...)`. One finding.
        const filtered = read("notes", { hasFilter: true });

        expect(unboundedCollect.run({ queries: [filtered], schema: schema() })).toHaveLength(0);
        expect(filterWithoutIndex.run({ queries: [filtered], schema: schema() })).toHaveLength(1);
    });

    it("says nothing about a bounded or narrowed read", () => {
        expect.assertions(4);

        // `.withIndex(...)` narrows the scan AND lets the refresh gate skip the
        // subscription when the write lands outside the slice.
        expect(unboundedCollect.run({ queries: [read("notes", { hasIndex: true })], schema: schema() })).toHaveLength(0);
        // A capped or paged terminal never materializes the table.
        expect(unboundedCollect.run({ queries: [read("notes", { terminal: "take" })], schema: schema() })).toHaveLength(0);
        expect(unboundedCollect.run({ queries: [read("notes", { terminal: "paginate" })], schema: schema() })).toHaveLength(0);
        expect(unboundedCollect.run({ queries: [read("notes", { terminal: "first" })], schema: schema() })).toHaveLength(0);
    });

    it("stays silent for a dynamic table, a feeder without terminals, and a runtime caller", () => {
        expect.assertions(3);

        // A non-literal `query(expr)` gives no table to name.
        expect(unboundedCollect.run({ queries: [read("")], schema: schema() })).toHaveLength(0);
        // `terminal` is optional; absent means "unknown", not "collect".
        expect(unboundedCollect.run({ queries: [read("notes", { terminal: undefined })], schema: schema() })).toHaveLength(0);
        expect(unboundedCollect.run({ schema: schema() })).toHaveLength(0);
    });

    it("falls back to neutral wording for a table whose tier is not recognised", () => {
        expect.assertions(1);

        // The `Map`-vs-object-literal prototype safety this shares with
        // `filter_without_index` is asserted once, exhaustively, in
        // `filter-scope.test.ts` — it is a property of `Map`, not of either lint.
        expect(unboundedCollect.run({ queries: [read("unknownTable")], schema: schema() })[0]?.detail).toContain("loads every row");
    });
});
