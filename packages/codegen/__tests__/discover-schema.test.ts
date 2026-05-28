import { Project } from "ts-morph";
import { describe, expect, test } from "vitest";

import { discoverSchema } from "../src/discover-schema.js";
import { emitDataModel } from "../src/emit.js";

/**
 * Build a fresh in-memory project hosting a `schema.ts` with the given source.
 * Avoids touching disk so each case stays hermetic.
 */
const projectWith = (schemaSource: string): { project: Project; schemaPath: string } => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/cirrus/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return { project, schemaPath };
};

describe("discoverSchema", () => {
    test("captures searchIndex name + field + filterFields", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                messages: defineTable({
                    channelId: v.id("channels"),
                    text: v.string(),
                })
                    .searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const messages = schema.tables.find((table) => table.name === "messages");

        expect(messages).toBeDefined();
        expect(messages?.searchIndexes).toHaveLength(1);
        expect(messages?.searchIndexes[0]).toEqual({
            field: "text",
            filterFields: ["channelId"],
            name: "by_text",
        });
    });

    test("searchIndex without filterFields leaves the field undefined (not an empty array)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                docs: defineTable({ body: v.string() }).searchIndex("by_body", { field: "body" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "docs");

        expect(docs?.searchIndexes[0]).toMatchObject({ field: "body", name: "by_body" });
        expect(docs?.searchIndexes[0]?.filterFields).toBeUndefined();
    });

    test("tables without searchIndex calls expose an empty searchIndexes array", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.searchIndexes).toEqual([]);
    });

    test("indexes, shardBy and searchIndex coexist on the same table", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                messages: defineTable({
                    channelId: v.id("channels"),
                    text: v.string(),
                })
                    .shardBy("channelId")
                    .index("by_channel", ["channelId"])
                    .searchIndex("by_text", { field: "text" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const messages = schema.tables[0];

        expect(messages?.shardMode).toEqual({ field: "channelId", kind: "shardBy" });
        expect(messages?.indexes).toEqual([{ fields: ["channelId"], name: "by_channel", unique: false }]);
        expect(messages?.searchIndexes[0]).toMatchObject({ field: "text", name: "by_text" });
    });

    test("captures an inline .vectorize() index hoisted into schema.vectorIndexes (Shape A)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema({
                docs: defineTable({
                    body: v.string(),
                    title: v.string(),
                    workspaceId: v.id("workspaces"),
                })
                    .shardBy("workspaceId")
                    .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", metadata: ["title", "workspaceId"], embed }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "docs");

        expect(docs?.vectorIndexes[0]).toEqual({
            dimensions: 1024,
            field: "body",
            metadata: ["title", "workspaceId"],
            metric: "cosine",
            name: "docs-body",
            table: "docs",
        });
        expect(schema.vectorIndexes).toEqual(docs?.vectorIndexes);
    });

    test("captures a standalone defineVectorIndex entry from the second arg (Shape B)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema(
                {
                    docs: defineTable({ body: v.string(), title: v.string() }).shardBy("body"),
                },
                {
                    "docs-title-and-body": defineVectorIndex({
                        source: { table: "docs", select: (row) => row.title + row.body },
                        dimensions: 768,
                        metric: "euclidean",
                        embed,
                    }),
                },
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.vectorIndexes).toEqual([
            {
                dimensions: 768,
                metric: "euclidean",
                name: "docs-title-and-body",
                table: "docs",
            },
        ]);
    });

    test("captures column modifiers into the field IR (and a chain no longer throws)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                todos: defineTable({
                    title: v.string().unique(),
                    priority: v.string().unique().default("medium"),
                    createdAt: v.number().$defaultFn(() => Date.now()),
                    updatedAt: v.number().$onUpdateFn(() => Date.now()),
                    note: v.string().nullable(),
                    plain: v.string(),
                }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const todos = schema.tables.find((table) => table.name === "todos");

        expect(todos?.shape.title).toEqual({ column: { notNull: true, unique: true }, kind: "string" });
        expect(todos?.shape.priority).toEqual({ column: { hasDefault: true, notNull: true, unique: true }, kind: "string" });
        expect(todos?.shape.createdAt).toEqual({ column: { hasDefault: true, notNull: true }, kind: "number" });
        expect(todos?.shape.updatedAt).toEqual({ column: { hasOnUpdate: true, notNull: true }, kind: "number" });
        expect(todos?.shape.note).toEqual({ column: { notNull: false }, kind: "string" });
        // A bare validator carries no column metadata.
        expect(todos?.shape.plain).toEqual({ kind: "string" });
    });

    test("parses .relations() into one/many descriptors with references defaulting to _id", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }).relations((r) => ({
                    posts: r.many("posts", { field: "authorId" }),
                })),
                posts: defineTable({
                    authorId: v.id("users"),
                    body: v.string(),
                }).relations((r) => ({
                    author: r.one("users", { field: "authorId", onDelete: "cascade" }),
                })),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const users = schema.tables.find((table) => table.name === "users");
        const posts = schema.tables.find((table) => table.name === "posts");

        expect(users?.relations).toEqual([{ field: "authorId", kind: "many", name: "posts", onDelete: undefined, references: "_id", table: "posts" }]);
        expect(posts?.relations).toEqual([{ field: "authorId", kind: "one", name: "author", onDelete: "cascade", references: "_id", table: "users" }]);
    });

    test("honors an explicit references and ignores onDelete on a many relation", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                orgs: defineTable({ slug: v.string() }).relations((r) => ({
                    members: r.many("members", { field: "orgSlug", references: "slug", onDelete: "cascade" }),
                })),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const orgs = schema.tables.find((table) => table.name === "orgs");

        expect(orgs?.relations[0]).toEqual({ field: "orgSlug", kind: "many", name: "members", onDelete: undefined, references: "slug", table: "members" });
    });

    test("tables without .relations() expose an empty relations array", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.relations).toEqual([]);
    });

    test("a .triggers() call is skipped without disrupting indexes/relations on the same table", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                messages: defineTable({ authorId: v.id("users"), body: v.string() })
                    .index("by_author", ["authorId"])
                    .relations((r) => ({ author: r.one("users", { field: "authorId" }) }))
                    .triggers((t) => ({
                        audit: t.afterInsert(async (ctx, e) => { await ctx.db.insert("audit", { row: e.id }); }),
                        guard: t.beforeDelete(async () => {}),
                    })),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const messages = schema.tables.find((table) => table.name === "messages");

        expect(messages).toBeDefined();
        // Triggers are code (closures), not IR — discovery steps over the call and the rest of the chain still parses.
        expect(messages?.indexes).toEqual([{ fields: ["authorId"], name: "by_author", unique: false }]);
        expect(messages?.relations).toEqual([{ field: "authorId", kind: "one", name: "author", onDelete: undefined, references: "_id", table: "users" }]);
    });

    test("emits the relation type machinery and per-table Relations map", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }).relations((r) => ({
                    posts: r.many("posts", { field: "authorId" }),
                })),
                posts: defineTable({ authorId: v.id("users") }).relations((r) => ({
                    author: r.one("users", { field: "authorId" }),
                })),
            });
        `);

        const dataModel = emitDataModel(discoverSchema(project, schemaPath));

        // Phantom descriptors + the per-table Relations map.
        expect(dataModel).toContain("export interface OneRelation<Target extends keyof DataModel>");
        expect(dataModel).toContain("export interface ManyRelation<Target extends keyof DataModel>");
        expect(dataModel).toContain('posts: ManyRelation<"posts">;');
        expect(dataModel).toContain('author: OneRelation<"users">;');

        // The with-inference machinery + generic facades.
        expect(dataModel).toContain("export type WithArg<T extends keyof DataModel>");
        expect(dataModel).toContain("export type LoadWith<T extends keyof DataModel, W> = Doc<T> & LoadedRelations<T, W> & LoadedCount<W>;");
        expect(dataModel).toContain("findMany: <W extends WithArg<T> = {}>(args?: QueryArgs<Doc<T>> & { with?: W }) => Promise<QueryPage<LoadWith<T, W>>>;");
        expect(dataModel).toContain("findFirst: <W extends WithArg<T> = {}>(args?: QueryArgs<Doc<T>> & { with?: W }) => Promise<LoadWith<T, W> | null>;");
    });

    test("emits an empty Relations entry for tables that declare none", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const dataModel = emitDataModel(discoverSchema(project, schemaPath));

        expect(dataModel).toContain("users: {};");
    });

    test("emits a VectorIndexName union covering both shapes", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema(
                {
                    docs: defineTable({ body: v.string(), title: v.string() })
                        .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", embed }),
                },
                {
                    "docs-title": defineVectorIndex({
                        source: { table: "docs", select: (row) => row.title },
                        dimensions: 1024,
                        metric: "cosine",
                        embed,
                    }),
                },
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const dataModel = emitDataModel(schema);

        expect(dataModel).toContain('export type VectorIndexName = "docs-body" | "docs-title";');
    });
});
