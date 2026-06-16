import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { CodegenDiagnosticError } from "../src/diagnostics";
import discoverSchema from "../src/discover-schema";
import { emitDataModel } from "../src/emit";

/**
 * Build a fresh in-memory project hosting a `schema.ts` with the given source.
 * Avoids touching disk so each case stays hermetic.
 */
const projectWith = (schemaSource: string): { project: Project; schemaPath: string } => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return { project, schemaPath };
};

describe("discoverSchema", () => {
    it("captures `.externallyManaged()` into the table IR; defaults to false", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                rateLimits: defineTable({ key: v.string() }).externallyManaged().index("by_key", ["key"]),
                messages: defineTable({ text: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.find((table) => table.name === "rateLimits")?.externallyManaged).toBe(true);
        expect(schema.tables.find((table) => table.name === "messages")?.externallyManaged).toBe(false);
    });

    it("captures searchIndex name + field + filterFields", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("searchIndex without filterFields leaves the field undefined (not an empty array)", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                docs: defineTable({ body: v.string() }).searchIndex("by_body", { field: "body" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "docs");

        expect(docs?.searchIndexes[0]).toMatchObject({ field: "body", name: "by_body" });
        expect(docs?.searchIndexes[0]?.filterFields).toBeUndefined();
    });

    it("tables without searchIndex calls expose an empty searchIndexes array", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.searchIndexes).toEqual([]);
    });

    it("indexes, shardBy and searchIndex coexist on the same table", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("captures a .rankIndex() name + sortBy + partitionBy into the IR", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                scores: defineTable({
                    boardId: v.id("boards"),
                    points: v.number(),
                })
                    .rankIndex("by_points", { sortBy: [{ field: "points", direction: "desc" }], partitionBy: ["boardId"] }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const scores = schema.tables.find((table) => table.name === "scores");

        expect(scores?.rankIndexes).toHaveLength(1);
        expect(scores?.rankIndexes[0]).toEqual({
            name: "by_points",
            partitionBy: ["boardId"],
            sortBy: [{ direction: "desc", field: "points" }],
        });

        // `direction` defaults to "asc" when omitted on a sortBy key.
        const { project: project2, schemaPath: schemaPath2 } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                scores: defineTable({ points: v.number() }).rankIndex("g", { sortBy: [{ field: "points" }] }),
            });
        `);

        expect(discoverSchema(project2, schemaPath2).tables[0]?.rankIndexes[0]).toEqual({
            name: "g",
            partitionBy: undefined,
            sortBy: [{ direction: "asc", field: "points" }],
        });
    });

    it("tables without rankIndex calls expose an empty rankIndexes array", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.rankIndexes).toEqual([]);
    });

    it("emits a per-table RankIndexName union and wires it into rank/rankPage", () => {
        expect.assertions(4);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                scores: defineTable({ points: v.number() }).rankIndex("by_points", { sortBy: [{ field: "points" }] }),
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const dataModel = emitDataModel(schema);

        expect(dataModel).toContain("export interface RankIndexNamesByTable");
        // Per-table union: declared name for `scores`, `never` for `users`.
        expect(dataModel).toContain('scores: "by_points";');
        expect(dataModel).toContain("export type RankIndexName<T extends keyof DataModel> = RankIndexNamesByTable[T];");
        // The per-table rank-index map is threaded into the facade binding (the
        // `RANK` generic), which constrains `rank`/`rankPage` to declared names.
        expect(dataModel).toContain("= TableReaderFacadeOf<DataModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, T>;");
    });

    it("carries a rankIndex declared on an extension table onto the prefixed table", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        scores: defineTable({ points: v.number() })
                            .rankIndex("by_points", { sortBy: [{ field: "points", direction: "desc" }] }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const scores = schema.tables.find((table) => table.name === "ext_scores");

        // The rank index rides along onto the prefixed owning table verbatim.
        expect(scores?.rankIndexes[0]?.name).toBe("by_points");
        // …and the emitted union keys it under the prefixed table name.
        expect(emitDataModel(schema)).toContain('ext_scores: "by_points";');
    });

    it("parses a literal `unique: true` on an index", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({
                    email: v.string(),
                })
                    .index("by_email", ["email"], { unique: true }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const users = schema.tables.find((table) => table.name === "users");

        expect(users?.indexes).toEqual([{ fields: ["email"], name: "by_email", unique: true }]);
    });

    it("throws when `unique` is a non-literal expression instead of silently dropping it", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const isUnique = true;
            export const schema = defineSchema({
                users: defineTable({
                    email: v.string(),
                })
                    .index("by_email", ["email"], { unique: isUnique }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/`unique` must be a literal/u);
    });

    it("throws a diagnostic when a table name collides with a `ctx.db` member (reserved name)", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                query: defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/table name "query" is reserved/u);
    });

    it("captures an inline .vectorize() index hoisted into schema.vectorIndexes (Shape A)", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";
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

    it("captures a standalone defineVectorIndex entry from the second arg (Shape B)", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@lunora/server";
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

    it("captures column modifiers into the field IR (and a chain no longer throws)", () => {
        expect.assertions(6);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("captures timestamp/date kinds and the $type/defaultNow modifiers", () => {
        expect.assertions(4);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                events: defineTable({
                    at: v.timestamp(),
                    due: v.date(),
                    startedAt: v.timestamp().defaultNow(),
                    externalId: v.string().$type<\`ext_\${string}\`>(),
                }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const events = schema.tables.find((table) => table.name === "events");

        expect(events?.shape.at).toEqual({ kind: "timestamp" });
        expect(events?.shape.due).toEqual({ kind: "date" });
        // defaultNow records a default like .default(), making the column insert-optional.
        expect(events?.shape.startedAt).toEqual({ column: { hasDefault: true, notNull: true }, kind: "timestamp" });
        // $type is a type-only override: it leaves the discovered kind untouched.
        expect(events?.shape.externalId).toEqual({ column: { notNull: true }, kind: "string" });
    });

    it("parses .relations() into one/many descriptors with references defaulting to _id", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("honors an explicit references and ignores onDelete on a many relation", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("tables without .relations() expose an empty relations array", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.relations).toEqual([]);
    });

    it("a .triggers() call is skipped without disrupting indexes/relations on the same table", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

    it("emits the relation type machinery and per-table Relations map", () => {
        expect.assertions(8);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

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

        // The with-inference machinery binds the shipped generics to this
        // project's DataModel + Relations (the bodies live in
        // `@lunora/server/data-model`, so they never regenerate here).
        expect(dataModel).toContain("export type WithArg<T extends keyof DataModel> = WithArgOf<DataModel, Relations, T>;");
        expect(dataModel).toContain("export type LoadWith<T extends keyof DataModel, W> = LoadWithOf<DataModel, Relations, T, W>;");
        expect(dataModel).toContain("import type {\n    DatabaseReaderFacade as DatabaseReaderFacadeOf,");
        expect(dataModel).toContain('} from "@lunora/server/data-model";');
    });

    it("emits an empty Relations entry for tables that declare none", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const dataModel = emitDataModel(discoverSchema(project, schemaPath));

        expect(dataModel).toContain("users: {};");
    });

    it("emits a VectorIndexName union covering both shapes", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@lunora/server";
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

    it("merges an inline .extend(defineSchemaExtension(...)) table with its key prefix and indexes intact", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        buckets: defineTable({
                            key: v.string(),
                            count: v.number(),
                        }).index("by_key", ["key"], { unique: true }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const buckets = schema.tables.find((table) => table.name === "ext_buckets");

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ext_buckets", "todos"]);
        expect(buckets).toBeDefined();
        expect(buckets?.indexes).toEqual([{ fields: ["key"], name: "by_key", unique: true }]);
    });

    it("rewrites an intra-extension relation to the prefixed table, leaving base references untouched", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        buckets: defineTable({ ownerId: v.id("users"), windowId: v.id("windows") }).relations((r) => ({
                            window: r.one("windows", { field: "windowId" }),
                            owner: r.one("users", { field: "ownerId" }),
                        })),
                        windows: defineTable({ at: v.number() }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const buckets = schema.tables.find((table) => table.name === "ext_buckets");

        // Intra-extension reference -> prefixed; base/app reference -> untouched.
        expect(buckets?.relations.find((relation) => relation.name === "window")?.table).toBe("ext_windows");
        expect(buckets?.relations.find((relation) => relation.name === "owner")?.table).toBe("users");
    });

    it("rewrites an inline vector index `table` to the owning prefixed table and prefixes its name", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        docs: defineTable({ body: v.string() })
                            .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", embed }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "ext_docs");

        expect(docs?.vectorIndexes[0]?.table).toBe("ext_docs");
        // Inline (Shape A) vector indexes keep their declared `index` name; only
        // the `table` reference is rewritten to the prefixed owner.
        expect(schema.vectorIndexes).toContainEqual(expect.objectContaining({ name: "docs-body", table: "ext_docs" }));
    });

    it("prefixes a standalone extension vectorIndex map key and its table reference", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, defineVectorIndex, v } from "@lunora/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        docs: defineTable({ body: v.string() }),
                    },
                    vectorIndexes: {
                        "docs-body": defineVectorIndex({
                            source: { table: "docs", select: (row) => row.body },
                            dimensions: 768,
                            metric: "euclidean",
                            embed,
                        }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.vectorIndexes).toContainEqual({
            dimensions: 768,
            metric: "euclidean",
            name: "ext_docs-body",
            table: "ext_docs",
        });
    });

    it("resolves a same-project identifier extension via .extend(myExt)", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            const myExt = defineSchemaExtension("ext", {
                tables: {
                    buckets: defineTable({ key: v.string() }),
                },
            });

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(myExt);
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ext_buckets", "todos"]);
    });

    it("resolves a same-project property-access extension via .extend(plugin.extension)", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            const plugin = {
                key: "ext",
                extension: defineSchemaExtension("ext", {
                    tables: {
                        buckets: defineTable({ key: v.string() }),
                    },
                }),
            };

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(plugin.extension);
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ext_buckets", "todos"]);
    });

    it("merges multiple chained .extend() calls", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            })
                .extend(defineSchemaExtension("a", { tables: { items: defineTable({ x: v.string() }) } }))
                .extend(defineSchemaExtension("b", { tables: { items: defineTable({ y: v.string() }) } }));
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["a_items", "b_items", "todos"]);
    });

    it("does not collide when an app table and an extension table share a bare name", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                buckets: defineTable({ appField: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: { buckets: defineTable({ extField: v.string() }) },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        // App `buckets` and extension `ext_buckets` live in separate namespaces.
        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["buckets", "ext_buckets"]);
    });

    it("throws when two same-key extensions produce the same prefixed table", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            })
                .extend(defineSchemaExtension("dup", { tables: { items: defineTable({ x: v.string() }) } }))
                .extend(defineSchemaExtension("dup", { tables: { items: defineTable({ y: v.string() }) } }));
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/table "dup_items" already exists/u);
    });

    it("skips a cross-package (.d.ts-only) extension with a warning instead of crashing", () => {
        expect.assertions(2);

        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

        // A node_modules declaration file is the only thing reachable for `vendorExt`.
        project.createSourceFile(
            "/virtual/node_modules/@vendor/plugin/index.d.ts",
            `import type { SchemaExtension } from "@lunora/server";
             export declare const vendorExt: SchemaExtension;`,
        );

        const schemaPath = "/virtual/lunora/schema.ts";

        project.createSourceFile(
            schemaPath,
            `import { defineSchema, defineTable, v } from "@lunora/server";
             import { vendorExt } from "@vendor/plugin";

             export const schema = defineSchema({
                 todos: defineTable({ title: v.string() }),
             }).extend(vendorExt);`,
        );

        const warnings: string[] = [];
        // eslint-disable-next-line no-console -- capture the codegen skip warning under test.
        const originalWarn = console.warn;

        // eslint-disable-next-line no-console -- temporarily intercept warnings emitted during discovery.
        console.warn = (message: string): void => {
            warnings.push(message);
        };

        try {
            const schema = discoverSchema(project, schemaPath);

            expect(schema.tables.map((table) => table.name)).toEqual(["todos"]);
        } finally {
            // eslint-disable-next-line no-console -- restore the original implementation.
            console.warn = originalWarn;
        }

        expect(warnings.some((message) => message.includes("could not be resolved from local sources"))).toBe(true);
    });

    it("throws a CodegenDiagnosticError with file:line:column when `unique` is not a literal", () => {
        expect.assertions(5);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const someFlag = true;
            export const schema = defineSchema({
                users: defineTable({
                    email: v.string(),
                })
                    .index("by_email", ["email"], { unique: someFlag }),
            });
        `);

        let thrown: unknown;

        try {
            discoverSchema(project, schemaPath);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(CodegenDiagnosticError);

        const diagnostic = thrown as CodegenDiagnosticError;

        // Message must contain the schema path so users can navigate directly to the error.
        expect(diagnostic.message).toContain("schema.ts:");
        // The structured properties must be set.
        expect(diagnostic.file).toBe(schemaPath);
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.column).toBeGreaterThan(0);
    });
});
