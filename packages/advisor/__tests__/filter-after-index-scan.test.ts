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
        indexName: "by_owner",
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

    it("says nothing without a filter, without filter evidence, or without an index", () => {
        expect.assertions(3);

        expect(filterAfterIndexScan.run(context([read({ hasFilter: false, filterFields: undefined })]))).toHaveLength(0);
        expect(filterAfterIndexScan.run(context([read({ filterFields: undefined })]))).toHaveLength(0);
        expect(filterAfterIndexScan.run(context([read({ indexName: undefined })]))).toHaveLength(0);
    });

    it("leaves a primary-key filter to filter_on_primary_key", () => {
        expect.assertions(1);

        expect(filterAfterIndexScan.run(context([read({ filtersPrimaryKey: true })]))).toHaveLength(0);
    });

    it("skips an index the schema does not declare", () => {
        expect.assertions(1);

        expect(filterAfterIndexScan.run(context([read({ indexName: "by_nothing" })]))).toHaveLength(0);
    });
});
