import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import filterOnPrimaryKey from "../src/lints/static/filter-on-primary-key";
import filterWithoutIndex from "../src/lints/static/filter-without-index";
import type { AdvisorQueryRead } from "../src/queries";

/**
 * One table per storage tier, so `filter_without_index` can be exercised across
 * all three: `.shardBy()` reads one Durable Object, `.global()` reads D1, and
 * the default root table reads the single DO.
 */
const schema = () =>
    fromServerSchema(
        defineSchema({
            catalog: defineTable({ sku: v.string() }).global(),
            notes: defineTable({ text: v.string() }),
            threadAccess: defineTable({ role: v.string(), userId: v.string() }).shardBy("userId"),
        }),
    );

const read = (table: string, overrides: Partial<AdvisorQueryRead> = {}): AdvisorQueryRead => {
    return { exportName: "list", file: "access", hasFilter: true, hasIndex: false, line: 7, table, ...overrides };
};

describe("filter_without_index storage-tier awareness", () => {
    it("drops a shardBy table's unindexed filter to INFO and says it is already scoped", () => {
        expect.assertions(3);

        // A `.shardBy()` query runs inside ONE Durable Object,
        // so it reads one tenant's rows, not the table. Reporting it identically
        // to an unbounded D1 scan makes the two cases that need very different
        // responses look the same in the output.
        const findings = filterWithoutIndex.run({ queries: [read("threadAccess")], schema: schema() });

        expect(findings[0]).toMatchObject({ level: "INFO", metadata: { shardKind: "shardBy" } });
        expect(findings[0]?.detail).toContain("already scoped to one shard");
        expect(findings[0]?.detail).not.toContain("loads every row");
    });

    // The tier lookup must be prototype-safe. Built as an object literal it
    // inherits `Object.prototype`, so a shard kind of `"toString"` resolves to
    // an inherited FUNCTION — truthy, so the `??` neutral fallback is skipped
    // and the finding's detail embeds a stringified function. A `Map` has no
    // such keys. `shardKind` is typed as a union, so this models a value that
    // slipped past the declared type rather than a supported configuration.
    it.each(["toString", "constructor", "valueOf", "__proto__"])("falls back to the neutral wording for a %s shard kind", (kind) => {
        expect.assertions(2);

        const poisoned = schema();
        const table = poisoned.tables.find((entry) => entry.name === "notes");

        (table as { shardKind?: string }).shardKind = kind;

        const findings = filterWithoutIndex.run({ queries: [read("notes")], schema: poisoned });

        expect(findings[0]?.detail).toContain("loads every row");
        // Never an inherited member leaking into operator-facing text.
        expect(findings[0]?.detail).not.toMatch(/function|\[object|native code/u);
    });

    it("keeps a global table at WARN and names the cross-region cost", () => {
        expect.assertions(2);

        // The rule earns its keep here: a `.global()` table is D1-backed and the
        // scan is genuinely unbounded.
        const findings = filterWithoutIndex.run({ queries: [read("catalog")], schema: schema() });

        expect(findings[0]).toMatchObject({ level: "WARN", metadata: { shardKind: "global" } });
        expect(findings[0]?.detail).toContain("scans the whole D1 table");
    });

    it("keeps a root table at WARN with the original wording", () => {
        expect.assertions(2);

        const findings = filterWithoutIndex.run({ queries: [read("notes")], schema: schema() });

        expect(findings[0]).toMatchObject({ level: "WARN", metadata: { shardKind: "root" } });
        expect(findings[0]?.detail).toContain("loads every row");
    });

    it("defers to filter_on_primary_key rather than double-reporting", () => {
        expect.assertions(2);

        // Both lints would otherwise fire on `.filter(d => d._id === id)` with
        // no index, pointing at different fixes — one says "add an index", the
        // other says "use ctx.db.get". Only the second is right.
        const primaryKeyRead = read("notes", { filtersPrimaryKey: true });

        expect(filterWithoutIndex.run({ queries: [primaryKeyRead], schema: schema() })).toHaveLength(0);
        expect(filterOnPrimaryKey.run({ queries: [primaryKeyRead], schema: schema() })).toHaveLength(1);
    });

    it("names the root Durable Object rather than reusing the unknown-tier wording", () => {
        expect.assertions(2);

        // `root` is the default single-DO table (its own SQLite), not D1 —
        // `global` is the D1 tier. An unrecognised table keeps the neutral
        // wording, since we cannot claim anything about its storage.
        expect(filterWithoutIndex.run({ queries: [read("notes")], schema: schema() })[0]?.detail).toContain("root Durable Object's SQLite");
        expect(filterWithoutIndex.run({ queries: [read("unknownTable")], schema: schema() })[0]?.detail).toContain("loads every row");
    });

    it("still says nothing about an indexed read", () => {
        expect.assertions(1);

        expect(filterWithoutIndex.run({ queries: [read("catalog", { hasIndex: true })], schema: schema() })).toHaveLength(0);
    });
});

describe("filter_on_primary_key", () => {
    it("flags a filter on _id as directly addressable", () => {
        expect.assertions(3);

        // Always wrong, never a judgement call — which is why it is its own rule
        // rather than another `filter_without_index` finding to triage.
        const findings = filterOnPrimaryKey.run({ queries: [read("notes", { filtersPrimaryKey: true })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ cacheKey: "filter_on_primary_key:access:7:notes", name: "filter_on_primary_key" });
        expect(findings[0]?.remediation).toContain("ctx.db.get(id)");
    });

    it("does not fire on an inequality filter, which ctx.db.get cannot express", () => {
        expect.assertions(1);

        // `.filter((d) => d._id !== excludeId)` is "every row except this one" —
        // a legitimate read. Flagging it would tell the author to replace it
        // with `ctx.db.get(id)`, which returns the opposite set. The feeder's
        // regex is what enforces this; the lint only sees the boolean.
        expect(filterOnPrimaryKey.run({ queries: [read("notes", { filtersPrimaryKey: false })], schema: schema() })).toHaveLength(0);
    });

    it("fires independently of the index and shard tier", () => {
        expect.assertions(2);

        // An index on the chain does not make an `_id` filter correct, and the
        // scan is wrong on a sharded table too — so neither of the escapes that
        // apply to filter_without_index applies here.
        expect(filterOnPrimaryKey.run({ queries: [read("notes", { filtersPrimaryKey: true, hasIndex: true })], schema: schema() })).toHaveLength(1);
        expect(filterOnPrimaryKey.run({ queries: [read("threadAccess", { filtersPrimaryKey: true })], schema: schema() })).toHaveLength(1);
    });

    it("finds nothing without primary-key evidence", () => {
        expect.assertions(2);

        expect(filterOnPrimaryKey.run({ queries: [read("notes")], schema: schema() })).toHaveLength(0);
        expect(filterOnPrimaryKey.run({ schema: schema() })).toHaveLength(0);
    });
});
