import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

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

    it("accepts .ttl() on a shard-local table", () => {
        expect.assertions(1);

        const schema = defineSchema({ sessions: defineTable({ expiresAt: v.number() }).ttl("expiresAt") });

        expect(schema.tables["sessions"]?.ttlPolicy).toStrictEqual({ after: undefined, field: "expiresAt" });
    });
});
