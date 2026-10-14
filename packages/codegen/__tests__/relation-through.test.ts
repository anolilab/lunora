import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/run-codegen";

/**
 * Many-to-many relations through codegen: `r.many(target, { through: { table, from, to } })` is read statically
 * off the schema, types as an ordinary `ManyRelation<Target>`, and the advisor holds the join table to the
 * unique-index rule. The first two cases pin the golden shape; the last two pin the lint on a fixture that breaks
 * the rule and on the documented shape that does not.
 */
const schemaSource = (joinIndex: string): string => `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    post_tags: defineTable({ postId: v.id("posts"), tagId: v.id("tags") })${joinIndex}.relations((r) => ({
        post: r.one("posts", { field: "postId", onDelete: "cascade" }),
        tag: r.one("tags", { field: "tagId", onDelete: "cascade" }),
    })),
    posts: defineTable({ title: v.string() }).relations((r) => ({
        tags: r.many("tags", { through: { from: "postId", table: "post_tags", to: "tagId" } }),
    })),
    tags: defineTable({ label: v.string() }),
});

export default schema;
`;

const UNIQUE_PAIR = `.index("byPair", ["postId", "tagId"], { unique: true }).index("byTag", ["tagId"])`;

let workdir: string;

const generate = (joinIndex: string) => {
    writeFileSync(join(workdir, "lunora", "schema.ts"), schemaSource(joinIndex), "utf8");

    return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });
};

describe("many-to-many relation codegen", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-through-"));
        mkdirSync(join(workdir, "lunora"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("emits a through relation as a plain ManyRelation of the target", () => {
        expect.assertions(2);

        const { dataModel } = generate(UNIQUE_PAIR).generated;

        // Reads, predicates and nested writes are typed off the target alone, so the join table never reaches the type.
        expect(dataModel).toContain('    posts: {\n        tags: ManyRelation<"tags">;\n    };');
        // The join table's own foreign keys keep their one-hop shape.
        expect(dataModel).toContain('post: OneRelation<"posts", "postId">;');
    });

    it("flags a join table with no unique index over the two keys", () => {
        expect.assertions(2);

        const findings = generate("").advisories.filter((finding) => finding.name === "through_relation_missing_unique_index");

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "ERROR", metadata: { relation: "tags", table: "post_tags" } });
    });

    it("is silent on the documented shape, and the through relation trips no other relation lint", () => {
        expect.assertions(1);

        const names = generate(UNIQUE_PAIR)
            .advisories.map((finding) => finding.name)
            .filter((name) => name.startsWith("relation_") || name.startsWith("through_") || name.startsWith("unindexed_"));

        expect(names).toStrictEqual([]);
    });
});
