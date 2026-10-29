import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { definePlugin, defineSchemaExtension, installPlugins, mergeSchemaExtension } from "../src/plugin";
import { defineSchema, defineTable } from "../src/schema";

/**
 * A plugin that contributes a many-to-many relation through its own join table. Extension tables are declared with
 * bare names (`posts`, `tags`, `post_tags`) and namespaced to `<key>_<name>` at merge; the join table's `v.id(...)`
 * columns are written with the same bare names.
 */
const tagging = (postTarget = "posts", tagTarget = "tags") =>
    defineSchemaExtension("cms", {
        tables: {
            post_tags: defineTable({ postId: v.id(postTarget), tagId: v.id(tagTarget) }).index("byPair", ["postId", "tagId"], {
                unique: true,
            }),
            posts: defineTable({ title: v.string() }).relations((r) => {
                return {
                    tags: r.many("tags", { through: { from: "postId", table: "post_tags", to: "tagId" } }),
                };
            }),
            tags: defineTable({ label: v.string() }),
        },
    });

describe("plugin-declared through relation", () => {
    it("merges an extension whose join table names its bare extension-local tables", () => {
        expect.assertions(3);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const merged = mergeSchemaExtension(base, tagging());

        expect(merged.tables["cms_posts"]?.relationMap["tags"]?.table).toBe("cms_tags");
        expect(merged.tables["cms_posts"]?.relationMap["tags"]?.through?.table).toBe("cms_post_tags");
        expect(merged.tables).toHaveProperty("cms_post_tags");
    });

    it("installs the same extension through installPlugins", () => {
        expect.assertions(1);

        const plugin = definePlugin("cms", { extension: tagging() });
        const schema = installPlugins(defineSchema({ todos: defineTable({ title: v.string() }) }), [plugin]);

        expect(schema.tables).toHaveProperty("cms_post_tags");
    });

    it("still rejects a join column that genuinely points at the wrong table", () => {
        expect.assertions(1);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });

        // `tagId` names the extension's `posts` table, but the relation targets `tags` — a real error.
        expect(() => mergeSchemaExtension(base, tagging("posts", "posts"))).toThrow(
            'through "cms_post_tags"): "cms_post_tags.tagId" must be a required v.id("cms_tags") column',
        );
    });

    it("resolves a bare extension v.id to the extension table, not an app table of the same name", () => {
        expect.assertions(2);

        const base = defineSchema({ todos: defineTable({ title: v.string() }), tags: defineTable({ label: v.string() }) });

        // A bare `v.id("tags")` inside the extension means `cms_tags`; the app's `tags` is a different table.
        const merged = mergeSchemaExtension(base, tagging());

        expect(merged.tables["cms_posts"]?.relationMap["tags"]?.table).toBe("cms_tags");
        expect(merged.tables).toHaveProperty("tags");
    });
});
