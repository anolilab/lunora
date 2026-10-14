import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorCountRead, LintContext } from "../src";
import { fromServerSchema } from "../src";
import countWithoutIndex from "../src/lints/static/count-without-index";

const schema = fromServerSchema(defineSchema({ posts: defineTable({ title: v.string() }), jobs: defineTable({ state: v.string() }) }));

/** A `count()` on `table` in `tally` of file `counts`. */
const count = (table: string, overrides: Partial<AdvisorCountRead> = {}): AdvisorCountRead => {
    return { file: "counts", indexed: false, line: 4, scope: { kind: "export", name: "tally" }, table, ...overrides };
};

const context = (countReads?: AdvisorCountRead[], extra: Partial<LintContext> = {}): LintContext => {
    return { countReads, schema, ...extra };
};

describe("count_without_index", () => {
    it("finds nothing without count reads (runtime caller)", () => {
        expect.assertions(1);

        expect(countWithoutIndex.run({ schema })).toHaveLength(0);
    });

    it("flags a count on a table with no aggregate index", () => {
        expect.assertions(2);

        const findings = countWithoutIndex.run(context([count("posts")]));

        expect(findings).toStrictEqual([
            expect.objectContaining({
                cacheKey: "count_without_index:counts:4:posts",
                level: "WARN",
                name: "count_without_index",
            }),
        ]);
        expect(findings[0]?.detail).toContain('scans every row of "posts"');
    });

    it("says nothing about a count the feeder reads as indexed", () => {
        expect.assertions(1);

        expect(countWithoutIndex.run(context([count("posts", { indexed: true })]))).toHaveLength(0);
    });

    it("reports a sharded table at INFO, since the count covers one shard", () => {
        expect.assertions(2);

        const findings = countWithoutIndex.run(
            context([count("posts")], {
                schema: fromServerSchema(defineSchema({ posts: defineTable({ title: v.string() }).shardBy("title") })),
            }),
        );

        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { shardKind: "shardBy" } });
        expect(findings[0]?.detail).toContain("one shard's rows");
    });

    describe("with ordinary indexes on the table", () => {
        const indexed = fromServerSchema(
            defineSchema({
                posts: defineTable({ rank: v.number(), status: v.string(), title: v.string() })
                    .index("by_status", ["status"])
                    .index("by_status_rank", ["status", "rank"]),
            }),
        );

        it("flags a bare count, since no index narrows it", () => {
            expect.assertions(1);

            expect(countWithoutIndex.run(context([count("posts")], { schema: indexed }))).toHaveLength(1);
        });

        it("does not flag a count whose where leads with an indexed field, which is a range scan", () => {
            expect.assertions(1);

            expect(countWithoutIndex.run(context([count("posts", { filterFields: ["status"] })], { schema: indexed }))).toHaveLength(0);
        });

        it("does not flag a count whose where leads with an indexed field and adds a further filter", () => {
            expect.assertions(1);

            expect(countWithoutIndex.run(context([count("posts", { filterFields: ["status", "title"] })], { schema: indexed }))).toHaveLength(0);
        });

        it("flags a count whose where no ordinary index leads with, and names the field", () => {
            expect.assertions(2);

            const findings = countWithoutIndex.run(context([count("posts", { filterFields: ["title"] })], { schema: indexed }));

            expect(findings).toHaveLength(1);
            expect(findings[0]?.detail).toContain('leads with a field its where tests ("title")');
        });

        it("flags a count that tests only the non-leading column of a composite index", () => {
            expect.assertions(1);

            expect(countWithoutIndex.run(context([count("posts", { filterFields: ["rank"] })], { schema: indexed }))).toHaveLength(1);
        });

        it("does not flag a count on _id, which is a primary-key lookup", () => {
            expect.assertions(1);

            expect(countWithoutIndex.run(context([count("posts", { filterFields: ["_id"] })], { schema: indexed }))).toHaveLength(0);
        });
    });

    it("reports every unindexed count, each at its own site", () => {
        expect.assertions(1);

        const findings = countWithoutIndex.run(context([count("posts", { line: 4 }), count("posts", { line: 9, scope: { kind: "export", name: "other" } })]));

        expect(findings.map((finding) => finding.cacheKey)).toStrictEqual(["count_without_index:counts:4:posts", "count_without_index:counts:9:posts"]);
    });
});
