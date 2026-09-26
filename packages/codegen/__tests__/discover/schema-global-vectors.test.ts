import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../../src/discover/schema";

/**
 * A vector index on a `.global()` table never syncs — vector sync is a shard
 * write hook and a global table's writes go to D1/Hyperdrive. `defineSchema`
 * refuses it at runtime; codegen refuses it first, so `lunora dev` fails at
 * generate time instead of at the first request.
 */
const discover = (source: string): ReturnType<typeof discoverSchema> => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, source);

    return discoverSchema(project, schemaPath);
};

describe("discoverSchema — .global() + vector index", () => {
    it("rejects an inline .vectorize() on a .global() table", () => {
        expect.assertions(1);

        expect(() =>
            discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({
                    profiles: defineTable({ bio: v.string() }).global().vectorize("bio", { dimensions: 768, embed, index: "profiles_bio", metric: "cosine" }),
                });
            `),
        ).toThrow(/table "profiles" is \.global\(\) and declares vector index "profiles_bio"/u);
    });

    it("rejects a standalone defineVectorIndex() sourced from a .global() table", () => {
        expect.assertions(1);

        expect(() =>
            discover(`
                import { defineSchema, defineTable, defineVectorIndex, v } from "@lunora/server";

                export const schema = defineSchema(
                    { profiles: defineTable({ bio: v.string() }).global() },
                    { profiles_bio: defineVectorIndex({ dimensions: 768, embed, metric: "cosine", source: { select: (row) => row.bio, table: "profiles" } }) },
                );
            `),
        ).toThrow(/table "profiles" is \.global\(\) and declares vector index "profiles_bio"/u);
    });

    it("accepts a vector index on a shard-local table", () => {
        expect.assertions(1);

        const schema = discover(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                profiles: defineTable({ bio: v.string() }).vectorize("bio", { dimensions: 768, embed, index: "profiles_bio", metric: "cosine" }),
            });
        `);

        expect(schema.vectorIndexes.map((index) => index.name)).toStrictEqual(["profiles_bio"]);
    });
});

describe("discoverSchema — .global() + .ttl()", () => {
    it.each([
        ["global() first", `defineTable({ expiresAt: v.number() }).global().ttl("expiresAt")`],
        ["ttl() first", `defineTable({ expiresAt: v.number() }).ttl("expiresAt").global({ backend: "hyperdrive" })`],
    ])("rejects the pair (%s) instead of emitting no sweep", (_label, table) => {
        expect.assertions(1);

        // `buildTtlSweeps` never swept a global table, so the policy was a no-op.
        expect(() =>
            discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                export const schema = defineSchema({ sessions: ${table} });
            `),
        ).toThrow(/table "sessions" is both \.global\(\) and \.ttl\(\)/u);
    });
});
