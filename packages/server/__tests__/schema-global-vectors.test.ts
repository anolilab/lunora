import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchemaExtension } from "../src/plugin";
import { defineSchema, defineTable, defineVectorIndex } from "../src/schema";

/**
 * Vector sync is a shard write hook, and a `.global()` table's writes go to the
 * SQL tier (D1/Hyperdrive), which has no such hook — so the combination used to
 * be accepted and index nothing. Refused instead, whichever DSL shape declares
 * the index and whichever side of `.global()` it is chained on.
 */
describe("defineSchema: .global() + vector index", () => {
    const embed = (): ReadonlyArray<number> => [0];
    const vectorize = { dimensions: 1, embed, index: "profiles_bio", metric: "cosine" } as const;

    it.each([
        ["global() first", () => defineTable({ bio: v.string() }).global().vectorize("bio", vectorize)],
        ["vectorize() first", () => defineTable({ bio: v.string() }).vectorize("bio", vectorize).global()],
    ])("rejects an inline .vectorize() on a .global() table (%s)", (_label, build) => {
        expect.assertions(1);

        expect(() => defineSchema({ profiles: build() })).toThrow(/table "profiles" is \.global\(\) and declares vector index "profiles_bio"/u);
    });

    it("rejects a standalone defineVectorIndex() sourced from a .global() table", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema(
                { profiles: defineTable({ bio: v.string() }).global() },
                {
                    profiles_bio: defineVectorIndex({
                        dimensions: 1,
                        embed,
                        metric: "cosine",
                        source: { select: (row) => String(row["bio"]), table: "profiles" },
                    }),
                },
            ),
        ).toThrow(/table "profiles" is \.global\(\) and declares vector index "profiles_bio"/u);
    });

    it("rejects one contributed by .extend()", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({}).extend(
                defineSchemaExtension("kit", { tables: { profiles: defineTable({ bio: v.string() }).global().vectorize("bio", vectorize) } }),
            ),
        ).toThrow(/table "kit_profiles" is \.global\(\) and declares vector index "profiles_bio"/u);
    });

    it("accepts a vector index on a shard-local table", () => {
        expect.assertions(1);

        expect(defineSchema({ profiles: defineTable({ bio: v.string() }).vectorize("bio", vectorize) }).tables.profiles.vectorIndexes).toHaveLength(1);
    });
});
