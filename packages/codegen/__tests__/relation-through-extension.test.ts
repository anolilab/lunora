import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/run-codegen";

/**
 * A many-to-many relation declared inside a plugin's schema extension. Extension tables are namespaced to
 * `<key>_<name>`; their relation `table` / `through.table` and the `v.id(...)` columns that name a sibling extension
 * table are rewritten with them. The codegen advisor reads the join table's indexes by its namespaced name, so the
 * unique-index rule must still hold for it.
 */
const schemaSource = (joinIndex: string): string => `import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    todos: defineTable({ title: v.string() }),
}).extend(
    defineSchemaExtension("cms", {
        tables: {
            post_tags: defineTable({ postId: v.id("posts"), tagId: v.id("tags") })${joinIndex}.relations((r) => ({
                post: r.one("posts", { field: "postId", onDelete: "cascade" }),
                tag: r.one("tags", { field: "tagId", onDelete: "cascade" }),
            })),
            posts: defineTable({ title: v.string() }).relations((r) => ({
                tags: r.many("tags", { through: { from: "postId", table: "post_tags", to: "tagId" } }),
            })),
            tags: defineTable({ label: v.string() }),
        },
    }),
);

export default schema;
`;

const UNIQUE_PAIR = `.index("byPair", ["postId", "tagId"], { unique: true }).index("byTag", ["tagId"])`;

let workdir: string;

const generate = (joinIndex: string) => {
    writeFileSync(join(workdir, "lunora", "schema.ts"), schemaSource(joinIndex), "utf8");

    return runCodegen({ projectRoot: workdir, wranglerQueueProducers: [] });
};

describe("many-to-many relation declared by a plugin extension", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-codegen-through-ext-"));
        mkdirSync(join(workdir, "lunora"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("emits the through relation against the namespaced target", () => {
        expect.assertions(1);

        const { dataModel } = generate(UNIQUE_PAIR).generated;

        expect(dataModel).toContain('    cms_posts: {\n        tags: ManyRelation<"cms_tags">;\n    };');
    });

    it("emits the join table's id columns against the namespaced tables", () => {
        expect.assertions(3);

        const { dataModel } = generate(UNIQUE_PAIR).generated;

        expect(dataModel).toContain('postId: Id<"cms_posts">;');
        expect(dataModel).toContain('tagId: Id<"cms_tags">;');
        expect(dataModel).not.toContain('Id<"posts">');
    });

    it("is silent on the documented shape: no through or relation lint fires for the namespaced join", () => {
        expect.assertions(1);

        const names = generate(UNIQUE_PAIR)
            .advisories.map((finding) => finding.name)
            .filter((name) => name.startsWith("relation_") || name.startsWith("through_") || name.startsWith("unindexed_"));

        expect(names).toStrictEqual([]);
    });

    it("flags the namespaced join table when it has no unique index over the two keys", () => {
        expect.assertions(2);

        const findings = generate("").advisories.filter((finding) => finding.name === "through_relation_missing_unique_index");

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "ERROR", metadata: { relation: "tags", table: "cms_post_tags" } });
    });
});
