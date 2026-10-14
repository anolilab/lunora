import type { SchemaLike } from "@lunora/shard-engine";
import { deriveRelationEdges } from "@lunora/shard-engine";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchemaExtension, mergeSchemaExtension } from "../src/plugin";
import { defineSchema, defineTable } from "../src/schema";

/**
 * A foreign key inside a plugin extension names a sibling extension table by its bare name (`v.id("authors")`), exactly
 * as relation targets do, and is namespaced to `<key>_<name>` when the extension merges. Otherwise the column keeps
 * pointing at a table that does not exist, and the relation graph silently drops its edge.
 */
const extension = () =>
    defineSchemaExtension("cms", {
        tables: {
            authors: defineTable({ name: v.string() }),
            posts: defineTable({
                authorId: v.id("authors"),
                editorIds: v.array(v.id("authors")),
                meta: v.object({ author: v.id("authors"), tags: v.record(v.string(), v.id("authors")) }),
                either: v.union(v.id("authors"), v.string()),
                ownerId: v.id("users"),
                reviewerId: v.optional(v.id("authors")),
                title: v.string(),
            }),
        },
    });

const base = () => defineSchema({ users: defineTable({ name: v.string() }) });

const targetOf = (validator: unknown): unknown => (validator as { _meta?: { tableName?: unknown } })._meta?.tableName;

describe("plugin extension foreign keys", () => {
    it("namespaces ids that name a sibling extension table, through optional and array, and leaves app tables alone", () => {
        expect.assertions(5);

        const { shape } = mergeSchemaExtension(base(), extension()).tables["cms_posts"];
        const inner = (validator: unknown): unknown => (validator as { _meta: { inner: unknown } })._meta.inner;

        expect(targetOf(shape["authorId"])).toBe("cms_authors");
        expect(targetOf(inner(shape["editorIds"]))).toBe("cms_authors");
        expect(targetOf(inner(shape["reviewerId"]))).toBe("cms_authors");
        // `users` is an app table, not part of the extension.
        expect(targetOf(shape["ownerId"])).toBe("users");
        expect(shape["authorId"]?.kind).toBe("id");
    });

    it("follows an id into an object field, a record value and a union member", () => {
        expect.assertions(3);

        const { shape } = mergeSchemaExtension(base(), extension()).tables["cms_posts"];
        const meta = (validator: unknown) => (validator as { _meta: Record<string, any> })._meta;

        expect(targetOf(meta(shape["meta"]).shape.author)).toBe("cms_authors");
        expect(targetOf(meta(meta(shape["meta"]).shape.tags).valueValidator)).toBe("cms_authors");
        expect(targetOf(meta(shape["either"]).members[0])).toBe("cms_authors");
    });

    it("keeps the relation graph's edges to the namespaced tables", () => {
        expect.assertions(1);

        const edges = deriveRelationEdges(mergeSchemaExtension(base(), extension()) as unknown as SchemaLike);

        expect(edges.filter((edge) => edge.sourceTable === "cms_posts").map((edge) => `${edge.column}->${edge.targetTable}`)).toStrictEqual([
            "authorId->cms_authors",
            "editorIds->cms_authors",
            "ownerId->users",
            "reviewerId->cms_authors",
        ]);
    });

    it("does not mutate the shared extension definition, so it can be installed under another key", () => {
        expect.assertions(2);

        const shared = extension();

        mergeSchemaExtension(base(), shared);

        expect(targetOf(shared.tables["posts"].shape["authorId"])).toBe("authors");
        expect(targetOf(mergeSchemaExtension(base(), shared).tables["cms_posts"].shape["authorId"])).toBe("cms_authors");
    });

    it("still parses an id value after the retarget", () => {
        expect.assertions(1);

        const { shape } = mergeSchemaExtension(base(), extension()).tables["cms_posts"];

        expect(shape["authorId"].parse("abc")).toBe("abc");
    });
});
