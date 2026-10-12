import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorQueryRead, LintContext } from "../src";
import { fromServerSchema } from "../src";
import filterAfterIndexScan from "../src/lints/static/filter-after-index-scan";

const schema = fromServerSchema(defineSchema({ sessions: defineTable({ ownerId: v.string(), expiresAt: v.number() }).index("by_owner", ["ownerId"]) }));

/** A `withIndex("by_owner").filter(…)` read; the filter fields are set per test. */
const read = (overrides: Partial<AdvisorQueryRead> = {}): AdvisorQueryRead => {
    return {
        file: "sessions",
        filterFields: ["expiresAt"],
        hasFilter: true,
        hasIndex: true,
        index: { bounds: ["eq"], name: "by_owner" },
        line: 12,
        scope: { kind: "export", name: "mine" },
        table: "sessions",
        ...overrides,
    };
};

const context = (queries: AdvisorQueryRead[]): LintContext => {
    return { queries, schema };
};

describe("filter_after_index_scan", () => {
    it("flags a filter on a field the index does not cover", () => {
        expect.assertions(2);

        const findings = filterAfterIndexScan.run(context([read()]));

        expect(findings).toStrictEqual([
            expect.objectContaining({ cacheKey: "filter_after_index_scan:sessions:12:sessions", level: "INFO", name: "filter_after_index_scan" }),
        ]);
        expect(findings[0]?.metadata).toMatchObject({ filteredFields: ["expiresAt"], indexName: "by_owner" });
    });

    it("says nothing when every filtered field is in the index", () => {
        expect.assertions(1);

        expect(filterAfterIndexScan.run(context([read({ filterFields: ["ownerId"] })]))).toHaveLength(0);
    });

    it("says nothing without a filter, without filter evidence, or without an index name", () => {
        expect.assertions(3);

        expect(filterAfterIndexScan.run(context([read({ hasFilter: false, filterFields: undefined })]))).toHaveLength(0);
        expect(filterAfterIndexScan.run(context([read({ filterFields: undefined })]))).toHaveLength(0);
        expect(filterAfterIndexScan.run(context([read({ index: { bounds: ["eq"] } })]))).toHaveLength(0);
    });

    it("never reports the _id part of a predicate, so a pure primary-key filter is silent", () => {
        expect.assertions(1);

        expect(filterAfterIndexScan.run(context([read({ filterFields: ["_id"], filtersPrimaryKey: true })]))).toHaveLength(0);
    });

    it("reports the uncovered field of a mixed predicate, and not its _id", () => {
        expect.assertions(1);

        const findings = filterAfterIndexScan.run(context([read({ filterFields: ["_id", "expiresAt"], filtersPrimaryKey: true })]));

        expect(findings[0]?.metadata).toMatchObject({ filteredFields: ["expiresAt"] });
    });

    it("skips an index the schema does not declare", () => {
        expect.assertions(1);

        expect(filterAfterIndexScan.run(context([read({ index: { bounds: ["eq"], name: "by_nothing" } })]))).toHaveLength(0);
    });

    it("leaves a server-driven open-range sweep to unbounded_collect_on_open_range, so the read gets one finding", () => {
        expect.assertions(1);

        // An internal open range with an uncovered filter: the sweep rule reports it, naming the same field.
        const sweep = read({ filterFields: ["expiresAt"], index: { bounds: [], name: "by_owner" }, terminal: "collect", visibility: "internal" });

        expect(filterAfterIndexScan.run(context([sweep]))).toHaveLength(0);
    });
});
