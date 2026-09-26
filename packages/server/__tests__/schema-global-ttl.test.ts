import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { definePlugin, defineSchemaExtension, installPlugins } from "../src/plugin";
import { defineSchema, defineTable } from "../src/schema";

/**
 * The TTL sweep is a shard alarm over that shard's own SQLite. A `.global()`
 * table's rows live in D1/Hyperdrive, outside every shard, so `.ttl()` there was
 * accepted and then never deleted a row. `defineSchema` refuses the pair.
 */
describe("defineSchema — .global() + .ttl()", () => {
    it.each([
        ["global() first", () => defineTable({ expiresAt: v.number() }).global().ttl("expiresAt")],
        ["ttl() first", () => defineTable({ expiresAt: v.number() }).ttl("expiresAt").global()],
    ])("rejects the pair (%s)", (_label, build) => {
        expect.assertions(1);

        expect(() => defineSchema({ sessions: build() })).toThrow(/table "sessions" is both \.global\(\) and \.ttl\(\)/u);
    });

    it.each([
        ["ttl", () => defineTable({ expiresAt: v.number() }).global().ttl("expiresAt"), /is both \.global\(\) and \.ttl\(\)/u],
        ["bigint", () => defineTable({ amount: v.bigint() }).global(), /is \.global\(\) and column "amount" is v\.bigint\(\)/u],
        ["dropStalePatches", () => defineTable({ title: v.string() }).global().dropStalePatches(), /is both \.global\(\) and \.dropStalePatches\(\)/u],
    ])("rejects a .global() + %s table an .extend() contributes, not only one the app declares", (_label, build, message) => {
        expect.assertions(2);

        // `defineSchema` validates only the tables it is called with; the merge
        // must hold extension tables to the same rules.
        const extension = defineSchemaExtension("billing", { tables: { records: build() } });

        expect(() => defineSchema({ notes: defineTable({ body: v.string() }) }).extend(extension)).toThrow(message);
        expect(() => installPlugins(defineSchema({ notes: defineTable({ body: v.string() }) }), [definePlugin("billing", { extension })])).toThrow(message);
    });

    it("accepts .ttl() on a shard-local table", () => {
        expect.assertions(1);

        const schema = defineSchema({ sessions: defineTable({ expiresAt: v.number() }).ttl("expiresAt") });

        expect(schema.tables["sessions"]?.ttlPolicy).toStrictEqual({ after: undefined, field: "expiresAt" });
    });
});
