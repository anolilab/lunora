import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTable, v } from "@lunora/server";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { CodegenDiagnosticError } from "../../src/diagnostics";
import discoverSchema from "../../src/discover/schema";
import { emitDataModel, emitServer } from "../../src/emit";
import { runtimeTableToIR } from "../../src/resolve-package-extension";

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
    it("keeps a shorthand column (`defineTable({ status })`) in the table shape", () => {
        expect.assertions(3);

        // A shorthand property is its own initializer. Skipping it dropped the
        // column from the shape entirely: `Doc_tasks` came out without `status`,
        // and an index over it only surfaced as a misleading
        // `index_references_unknown_field` advisory. `object-shorthand` rewrites
        // `status: status` into this form, so a lint run could cause the loss.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const status = v.union(v.literal("todo"), v.literal("done"));

            export const schema = defineSchema({
                tasks: defineTable({ title: v.string(), status }).index("by_status", ["status"]),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const tasks = schema.tables.find((table) => table.name === "tasks");

        expect(Object.keys(tasks?.shape ?? {})).toStrictEqual(["title", "status"]);
        // The identifier is followed to the const it names, so the column keeps
        // its real kind. It used to stop at the shorthand PROPERTY's symbol and
        // degrade to `any` — rendering `unknown` in `Doc_*` and in the public api
        // surface — while the longhand `status: status` spelling of the same
        // thing resolved fine.
        expect(tasks?.shape.status?.kind).toBe("union");
        // Not just "some union" — the members are what `Doc_tasks` and the public
        // api surface render, which is the whole point of following the alias.
        expect(tasks?.shape.status?.members?.map((member) => member.literalValue)).toStrictEqual(['"todo"', '"done"']);
    });

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

    it("captures `.source()` into the table IR (presence of functions only) and implies externallyManaged", () => {
        expect.assertions(3);

        // The fixture deliberately writes `mode: "incremental"` + `reconcileEveryMs`
        // even though neither is on the typed `.source()` surface: discovery is
        // AST-level and must capture what the source text says verbatim.

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                documents: defineTable({ orgId: v.string(), title: v.string() })
                    .shardBy("orgId")
                    .source({
                        binding: "HD",
                        query: "select uuid, title, org_id from documents where org_id = $1",
                        idColumn: "uuid",
                        mode: "incremental",
                        columns: ["title"],
                        reconcileEveryMs: 60000,
                        tenantBy: (key) => [key],
                        map: (row) => ({ title: row.title }),
                    }),
                plain: defineTable({ title: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const documents = schema.tables.find((table) => table.name === "documents");

        expect(documents?.externalSource).toStrictEqual({
            binding: "HD",
            columns: ["title"],
            hasReconcile: true,
            hasSoftDelete: false,
            hasTenantBy: true,
            idColumn: "uuid",
            mode: "incremental",
            query: "select uuid, title, org_id from documents where org_id = $1",
        });
        // `.source()` implies `.externallyManaged()` (rows come from the ingest loop).
        expect(documents?.externallyManaged).toBe(true);
        expect(schema.tables.find((table) => table.name === "plain")?.externalSource).toBeUndefined();
    });

    it("records an `unanalyzable` sentinel when `.source()` is passed a non-literal config", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const buildConfig = () => ({ binding: "HD", query: "select 1", tenantBy: (key) => [key] });

            export const schema = defineSchema({
                documents: defineTable({ orgId: v.string(), title: v.string() })
                    .shardBy("orgId")
                    .source(buildConfig()),
            });
        `);

        const documents = discoverSchema(project, schemaPath).tables.find((table) => table.name === "documents");

        // The source exists but can't be read statically — a sentinel, NOT `undefined`,
        // so `hasSourcedTables` and the `external_source_*` lints still see a source.
        expect(documents?.externalSource).toStrictEqual({ binding: "", hasTenantBy: false, unanalyzable: true });
        expect(documents?.externallyManaged).toBe(true);
    });

    it("captures `.softDelete()`, injecting the marker column so Doc carries it", () => {
        expect.assertions(4);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                posts: defineTable({ title: v.string() }).softDelete(),
                logs: defineTable({ line: v.string() }).softDelete({ field: "removedAt" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const posts = schema.tables.find((table) => table.name === "posts");
        const logs = schema.tables.find((table) => table.name === "logs");

        expect(posts?.softDelete).toStrictEqual({ field: "deletedAt" });
        expect(logs?.softDelete).toStrictEqual({ field: "removedAt" });

        // The injected column flows into the emitted Doc as an optional number.
        const dataModel = emitDataModel(schema);

        expect(dataModel).toContain("deletedAt?: number;");
        expect(dataModel).toContain("removedAt?: number;");
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

    it("rejects two search indexes whose FTS5 shadow tables collide", () => {
        expect.assertions(3);

        // `search_prompts` renders the FTS table `prompts__fts_search_prompts`,
        // whose `_content` shadow is `prompts__fts_search_prompts_content` —
        // exactly the table `search_prompts_content` wants. SQLite rejects the
        // second CREATE, which aborts the shard migration and leaves every
        // sharded table unreadable, with a 200 on the wire.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                prompts: defineTable({
                    content: v.string(),
                    name: v.string(),
                    userId: v.string(),
                })
                    .searchIndex("search_prompts", { field: "name", filterFields: ["userId"] })
                    .searchIndex("search_prompts_content", { field: "content", filterFields: ["userId"] }),
            });
        `);

        let message = "";

        try {
            discoverSchema(project, schemaPath);
        } catch (error: unknown) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain("search_prompts");
        expect(message).toContain("prompts__fts_search_prompts_content");
        expect(message).toContain("_content");
    });

    it("rejects a collision with the fts5vocab companion, which fails SILENTLY at runtime", () => {
        expect.assertions(3);

        // `__vocab` is created with `IF NOT EXISTS`, so unlike the reserved
        // SQLite shadows this does not error — the second index binds to the
        // first's vocab table and returns wrong results with no signal at all.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                prompts: defineTable({ body: v.string(), name: v.string() })
                    .searchIndex("search_prompts", { field: "name" })
                    .searchIndex("search_prompts__vocab", { field: "body" }),
            });
        `);

        let message = "";

        try {
            discoverSchema(project, schemaPath);
        } catch (error: unknown) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain("search_prompts__vocab");
        // The message must NOT promise a SQLITE_ERROR here — `IF NOT EXISTS`
        // means this collision is silent, which is the whole reason it is worse.
        expect(message).toContain("with no error");
        expect(message).not.toContain("SQLITE_ERROR");
    });

    it("allows two search indexes whose names do not collide through a shadow suffix", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                prompts: defineTable({ body: v.string(), name: v.string() })
                    .searchIndex("search_prompts", { field: "name" })
                    .searchIndex("search_prompt_body", { field: "body" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.find((table) => table.name === "prompts")?.searchIndexes).toHaveLength(2);
    });

    it("captures searchIndex staged: true", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                docs: defineTable({ body: v.string() }).searchIndex("by_body", { field: "body", staged: true }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.searchIndexes[0]).toMatchObject({ field: "body", name: "by_body", staged: true });
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

    it("captures geoIndex name + field + precision", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                places: defineTable({
                    location: v.geoPoint(),
                    name: v.string(),
                })
                    .geoIndex("by_location", { field: "location", precision: 7 }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const places = schema.tables.find((table) => table.name === "places");

        expect(places?.geoIndexes).toHaveLength(1);
        expect(places?.geoIndexes?.[0]).toEqual({ field: "location", name: "by_location", precision: 7 });
        // The geo-point column emits a `{ lat, lng }` type in the data model.
        expect(emitDataModel(schema)).toContain("location: { lat: number; lng: number };");
    });

    it("emits a per-table GeoIndexName union and threads it into the facade", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                places: defineTable({ location: v.geoPoint() }).geoIndex("by_location", { field: "location" }),
                users: defineTable({ email: v.string() }),
            });
        `);

        const dataModel = emitDataModel(discoverSchema(project, schemaPath));

        expect(dataModel).toContain('places: "by_location";');
        expect(dataModel).toContain("export type GeoIndexName<T extends keyof DataModel> = GeoIndexNamesByTable[T];");
    });

    it("captures a .ttl(field, { after }) policy", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                sessions: defineTable({ createdAt: v.timestamp(), token: v.string() }).ttl("createdAt", { after: 3600000 }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const sessions = schema.tables.find((table) => table.name === "sessions");

        expect(sessions?.ttl).toStrictEqual({ after: 3_600_000, field: "createdAt" });
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

    it("a bare .global() defaults to the d1 backend", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                settings: defineTable({ key: v.string() }).global(),
            });
        `);

        const table = discoverSchema(project, schemaPath).tables[0];

        expect(table?.shardMode).toBe("global");
        expect(table?.globalBackend).toBe("d1");
    });

    it('captures .global({ backend: "hyperdrive" }) into the IR', () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                settings: defineTable({ key: v.string() }).global({ backend: "hyperdrive" }),
            });
        `);

        const table = discoverSchema(project, schemaPath).tables[0];

        expect(table?.shardMode).toBe("global");
        expect(table?.globalBackend).toBe("hyperdrive");
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
        const server = emitServer({ schema });

        expect(dataModel).toContain("export interface RankIndexNamesByTable");
        // Per-table union: declared name for `scores`, `never` for `users`.
        expect(dataModel).toContain('scores: "by_points";');
        expect(dataModel).toContain("export type RankIndexName<T extends keyof DataModel> = RankIndexNamesByTable[T];");
        // The per-table rank-index map is threaded into the facade binding (the
        // `RANK` generic), which constrains `rank`/`rankPage` to declared names.
        // The binding itself lives in `server.ts` — it needs the server package,
        // and `dataModel.ts` is kept free of it so a client can compile it.
        expect(server).toContain("= TableReaderFacadeOf<DataModel, Relations, RankIndexNamesByTable, SearchIndexNamesByTable, T, GeoIndexNamesByTable>;");
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

    it("throws a diagnostic when a table name is not a valid JS identifier", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                "user-profiles": defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/user-profiles/u);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/identifier/u);
    });

    it("throws with a file:line:column suffix for a non-identifier table name", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                "user-profiles": defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/schema\.ts:\d+:\d+\)/u);
    });

    it("rejects a quoted string-literal table name that collides with a `ctx.db` member (reserved name)", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                "delete": defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/table name "delete" is reserved/u);
    });

    it("accepts a valid camelCase table name without throwing", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                userProfiles: defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).not.toThrow();
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

        const relationSchema = discoverSchema(project, schemaPath);
        const dataModel = emitDataModel(relationSchema);
        const server = emitServer({ schema: relationSchema });

        // Phantom descriptors + the per-table Relations map.
        expect(dataModel).toContain("export interface OneRelation<Target extends keyof DataModel>");
        expect(dataModel).toContain("export interface ManyRelation<Target extends keyof DataModel>");
        expect(dataModel).toContain('posts: ManyRelation<"posts">;');
        expect(dataModel).toContain('author: OneRelation<"users">;');

        // The with-inference machinery binds the shipped generics to this
        // project's DataModel + Relations (the bodies live in
        // `@lunora/server/data-model`, so they never regenerate here). It sits in
        // `server.ts`, which is the file allowed to need the server package.
        expect(server).toContain("export type WithArg<T extends keyof DataModel> = WithArgOf<DataModel, Relations, T>;");
        expect(server).toContain("export type LoadWith<T extends keyof DataModel, W> = LoadWithOf<DataModel, Relations, T, W>;");
        expect(server).toContain("import type {\n    DatabaseReaderFacade as DatabaseReaderFacadeOf,");
        // The dependency-free property, asserted from the other side.
        expect(dataModel).not.toContain("@lunora/server");
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

    it("throws a located diagnostic for an extension key that is not a valid JS identifier", () => {
        expect.assertions(4);

        // The key is concatenated into every one of the extension's table names
        // (`${key}_${bareName}`), so a hyphen in it reached `emitDataModel` as
        // `rate-limit_buckets` — an unlocated `INTERNAL` throw naming a table the
        // user never typed, with no file, no line and no mention of the call that
        // produced it.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("rate-limit", {
                    tables: {
                        buckets: defineTable({ tokens: v.number() }),
                    },
                }),
            );
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/rate-limit/u);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/defineSchemaExtension/u);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/schema\.ts:\d+:\d+\)/u);
    });

    it("records the contributing extension key so app-declared tables stay distinguishable", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ratelimit", {
                    tables: { buckets: defineTable({ key: v.string() }) },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        // Drives the emitted `AppTableName`: an add-on's table is a real table, but an
        // app enumerating "my tables" should not have to know it exists.
        expect(schema.tables.find((table) => table.name === "ratelimit_buckets")?.extensionKey).toBe("ratelimit");
        expect(schema.tables.find((table) => table.name === "todos")?.extensionKey).toBeUndefined();
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

    it("resolves a `definePlugin(...)`-wrapped extension via .extend(plugin.extension)", () => {
        expect.assertions(1);

        // The shape the registry's `ratelimit`/`presence` items ship: the extension
        // is wrapped in `definePlugin("key", { extension: … })`. Accessing
        // `plugin.extension` resolves the `.extension` field through definePlugin's
        // return TYPE (in @lunora/server), so resolution must follow the receiver
        // and unwrap the local `definePlugin(...)` config object structurally.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, definePlugin, defineTable, v } from "@lunora/server";

            export const ratelimit = definePlugin("ratelimit", {
                extension: defineSchemaExtension("ratelimit", {
                    tables: {
                        buckets: defineTable({ key: v.string() }).index("by_key", ["key"]),
                    },
                }),
                middleware: ({ ctx, next }) => next({ ctx }),
            });

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(ratelimit.extension);
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ratelimit_buckets", "todos"]);
    });

    it("resolves a `definePlugin(...)` extension imported from a sibling local file", () => {
        expect.assertions(1);

        // The exact scaffold shape: `lunora/<key>/schema.ts` exports the plugin and
        // `lunora/schema.ts` imports it and `.extend(<key>.extension)`. Resolution
        // must follow the import into the sibling project file (not bail as cross-package).
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

        project.createSourceFile(
            "/virtual/lunora/ratelimit/schema.ts",
            `
            import { defineSchemaExtension, definePlugin, defineTable, v } from "@lunora/server";

            export const ratelimit = definePlugin("ratelimit", {
                extension: defineSchemaExtension("ratelimit", {
                    tables: {
                        buckets: defineTable({ key: v.string() }).index("by_key", ["key"]),
                    },
                }),
                middleware: ({ ctx, next }) => next({ ctx }),
            });
        `,
        );

        const schemaPath = "/virtual/lunora/schema.ts";

        project.createSourceFile(
            schemaPath,
            `
            import { defineSchema, defineTable, v } from "@lunora/server";

            import { ratelimit } from "./ratelimit/schema";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(ratelimit.extension);
        `,
        );

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ratelimit_buckets", "todos"]);
    });

    it("resolves a schema extension defined inside an installed package (node_modules runtime introspection)", () => {
        expect.assertions(3);

        // Plan 056: when the extension can't be resolved from local AST (it lives
        // in a published package), codegen imports the package from the project
        // root and introspects its runtime `SchemaExtension` value.
        const root = mkdtempSync(join(tmpdir(), "lunora-pkgext-"));

        try {
            // A fake installed package shipping a runtime definePlugin-shaped value:
            // duck-typed validators (`{ kind, _meta }`) + a `defineTable`-shaped builder.
            const pkgDir = join(root, "node_modules", "test-rl-ext");

            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: "./index.mjs", main: "index.mjs", name: "test-rl-ext", type: "module" }));
            writeFileSync(
                join(pkgDir, "index.mjs"),
                `const s = (kind) => ({ kind, _meta: { column: { notNull: true } } });
                 const optional = (inner) => ({ kind: "optional", _meta: { inner, column: { notNull: false } } });
                 const buckets = {
                     shape: { key: s("string"), value: s("number"), ts: s("number"), prev: optional(s("number")) },
                     indexes: [{ fields: ["key"], name: "by_key", unique: false }],
                     shardMode: { kind: "root" },
                 };
                 export const ratelimit = { key: "ratelimit", extension: { key: "ratelimit", tables: { buckets } } };
                `,
            );

            mkdirSync(join(root, "lunora"), { recursive: true });
            const schemaPath = join(root, "lunora", "schema.ts");

            writeFileSync(
                schemaPath,
                `import { defineSchema, defineTable, v } from "@lunora/server";
                 import { ratelimit } from "test-rl-ext";
                 export const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(ratelimit.extension);
                `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true });
            const schema = discoverSchema(project, schemaPath, root);

            const buckets = schema.tables.find((table) => table.name === "ratelimit_buckets");

            expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ratelimit_buckets", "todos"]);
            expect(Object.keys(buckets?.shape ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual(["key", "prev", "ts", "value"]);
            expect(buckets?.indexes).toEqual([{ fields: ["key"], name: "by_key" }]);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("throws a located diagnostic for a package extension whose table name is not an identifier", () => {
        expect.assertions(3);

        // The package-runtime path builds its bare tables from `Object.entries`
        // with no name check at all, so a published add-on shipping
        // `tables: { "user-profiles": … }` walked straight past the assert the
        // AST path calls and died in emit with an unlocated `INTERNAL` naming
        // `pkg_user-profiles`. The user cannot fix the package, but the
        // `.extend(...)` call naming it is theirs.
        const root = mkdtempSync(join(tmpdir(), "lunora-pkgext-bad-"));

        try {
            const pkgDir = join(root, "node_modules", "test-bad-ext");

            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: "./index.mjs", main: "index.mjs", name: "test-bad-ext", type: "module" }));
            writeFileSync(
                join(pkgDir, "index.mjs"),
                `const s = (kind) => ({ kind, _meta: { column: { notNull: true } } });
                 const profiles = { shape: { key: s("string") }, indexes: [], shardMode: { kind: "root" } };
                 export const bad = { key: "pkg", extension: { key: "pkg", tables: { "user-profiles": profiles } } };
                `,
            );

            mkdirSync(join(root, "lunora"), { recursive: true });
            const schemaPath = join(root, "lunora", "schema.ts");

            writeFileSync(
                schemaPath,
                `import { defineSchema, defineTable, v } from "@lunora/server";
                 import { bad } from "test-bad-ext";
                 export const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(bad.extension);
                `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true });

            expect(() => discoverSchema(project, schemaPath, root)).toThrow(CodegenDiagnosticError);
            expect(() => discoverSchema(project, schemaPath, root)).toThrow(/user-profiles/u);
            expect(() => discoverSchema(project, schemaPath, root)).toThrow(/schema\.ts:\d+:\d+\)/u);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("resolves a package extension imported as a default export (.extend(plugin.extension))", () => {
        expect.assertions(1);

        const root = mkdtempSync(join(tmpdir(), "lunora-pkgext-default-"));

        try {
            const pkgDir = join(root, "node_modules", "test-default-ext");

            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(
                join(pkgDir, "package.json"),
                JSON.stringify({ exports: "./index.mjs", main: "index.mjs", name: "test-default-ext", type: "module" }),
            );
            writeFileSync(
                join(pkgDir, "index.mjs"),
                `const s = (kind) => ({ kind, _meta: { column: { notNull: true } } });
                 const present = { shape: { roomId: s("string") }, indexes: [], shardMode: { kind: "root" } };
                 export default { key: "presence", extension: { key: "presence", tables: { present } } };
                `,
            );

            mkdirSync(join(root, "lunora"), { recursive: true });
            const schemaPath = join(root, "lunora", "schema.ts");

            writeFileSync(
                schemaPath,
                `import { defineSchema, defineTable, v } from "@lunora/server";
                 import presence from "test-default-ext";
                 export const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(presence.extension);
                `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true });
            const schema = discoverSchema(project, schemaPath, root);

            expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["presence_present", "todos"]);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("runtimeTableToIR converts a REAL `defineTable` builder (drift guard for `@lunora/values` _meta)", () => {
        expect.assertions(8);

        // Build with the real `v`/`defineTable` so a rename of a validator's `_meta`
        // key (inner/members/shape/valueValidator/tableName/value) FAILS this test
        // rather than silently degrading every package-extension column.
        const builder = defineTable({
            count: v.optional(v.number()),
            meta: v.record(v.string(), v.number()),
            nested: v.object({ x: v.string() }),
            tag: v.union(v.literal("a"), v.id("things")),
            title: v.string(),
        }).index("by_title", ["title"]);

        const table = runtimeTableToIR(builder, "t");

        expect(table.shape["title"]?.kind).toBe("string");
        expect(table.shape["count"]?.kind).toBe("optional");
        expect(table.shape["count"]?.inner?.kind).toBe("number");
        expect(table.shape["tag"]?.members?.map((member) => member.kind)).toEqual(["literal", "id"]);
        expect(table.shape["tag"]?.members?.[1]?.tableName).toBe("things");
        expect(table.shape["meta"]?.valueType?.kind).toBe("number");
        expect(table.shape["nested"]?.shape?.["x"]?.kind).toBe("string");
        expect(table.indexes).toEqual([{ fields: ["title"], name: "by_title" }]);
    });

    it("skips (without throwing) a package export that is not a SchemaExtension", () => {
        expect.assertions(1);

        const root = mkdtempSync(join(tmpdir(), "lunora-pkgext-bad-"));

        try {
            const pkgDir = join(root, "node_modules", "test-bad-ext");

            mkdirSync(pkgDir, { recursive: true });
            writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: "./index.mjs", main: "index.mjs", name: "test-bad-ext", type: "module" }));
            // `extension` resolves to a non-SchemaExtension value (no string `key`).
            writeFileSync(join(pkgDir, "index.mjs"), `export const bad = { extension: { nope: true } };\n`);

            mkdirSync(join(root, "lunora"), { recursive: true });
            const schemaPath = join(root, "lunora", "schema.ts");

            writeFileSync(
                schemaPath,
                `import { defineSchema, defineTable, v } from "@lunora/server";
                 import { bad } from "test-bad-ext";
                 export const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(bad.extension);
                `,
            );

            const project = new Project({ skipAddingFilesFromTsConfig: true });
            const schema = discoverSchema(project, schemaPath, root);

            // Fail-safe: the extension is dropped (warn+skip), the base table survives, nothing throws.
            expect(schema.tables.map((table) => table.name)).toEqual(["todos"]);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
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

    it("defaults jurisdiction to undefined when not declared", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            });
        `);

        expect(discoverSchema(project, schemaPath).jurisdiction).toBeUndefined();
    });

    it.each(["eu", "us", "fedramp"] as const)("captures `.jurisdiction(%s)` into the schema IR", (value) => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            }).jurisdiction("${value}");
        `);

        expect(discoverSchema(project, schemaPath).jurisdiction).toBe(value);
    });

    it("finds `.jurisdiction(...)` regardless of position in the builder chain", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            }).rls("required").jurisdiction("eu");
        `);

        expect(discoverSchema(project, schemaPath).jurisdiction).toBe("eu");
    });

    it("throws a diagnostic on an unknown jurisdiction literal", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            }).jurisdiction("atlantis");
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/unknown jurisdiction/);
    });

    it("captures `.public()` into the table IR; defaults to false", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                emojis: defineTable({ glyph: v.string() }).public(),
                messages: defineTable({ text: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.find((table) => table.name === "emojis")?.isPublic).toBe(true);
        expect(schema.tables.find((table) => table.name === "messages")?.isPublic).toBe(false);
    });

    it("defaults rlsMode to undefined when `.rls(...)` is not declared", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            });
        `);

        expect(discoverSchema(project, schemaPath).rlsMode).toBeUndefined();
    });

    it('captures `.rls("required")` into the schema IR, regardless of position in the builder chain', () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            }).jurisdiction("eu").rls("required");
        `);

        expect(discoverSchema(project, schemaPath).rlsMode).toBe("required");
    });

    it("throws a diagnostic on an unknown `.rls(...)` mode literal", () => {
        expect.assertions(1);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            }).rls("optional");
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(/unknown rls mode/);
    });

    // `await`/`yield` are reserved only in a module context and `eval`/`arguments` are
    // not reserved words at all, yet `const <name> = sqliteTable(...)` is a SyntaxError
    // for every one of them in the ES module codegen emits.
    it.each(["class", "await", "yield", "eval", "arguments"])("throws a diagnostic when a table name is the reserved JS word %s", (name) => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                ${name}: defineTable({ text: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(new RegExp(`table name "${name}" is a reserved JavaScript word`, "u"));
        expect(() => discoverSchema(project, schemaPath)).toThrow(new RegExp(`const ${name} = sqliteTable`, "u"));
    });

    it("throws a diagnostic when a base table key is declared more than once", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
                messages: defineTable({ body: v.string() }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/table "messages" is declared more than once/u);
    });

    it("throws a pinpointed diagnostic (not a generic INTERNAL error) for an extension table named after a reserved keyword", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        class: defineTable({ text: v.string() }),
                    },
                }),
            );
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).not.toThrow(/INTERNAL/u);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/table name "class" is a reserved JavaScript word/u);
    });

    it("throws a pinpointed diagnostic (not a generic INTERNAL error) for an extension table whose bare name is not a valid identifier", () => {
        expect.assertions(3);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                todos: defineTable({ title: v.string() }),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        "user profiles": defineTable({ text: v.string() }),
                    },
                }),
            );
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).not.toThrow(/INTERNAL/u);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/user profiles/u);
    });

    it("throws when v.id(...)'s target table is not a string literal", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const targetTable = "users";

            export const schema = defineSchema({
                posts: defineTable({ authorId: v.id(targetTable) }),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/v\.id\(\.\.\.\) target table must be a string literal/u);
    });

    it("throws when a .relations() target table is not a string literal", () => {
        expect.assertions(2);

        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            const targetTable = "users";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
                posts: defineTable({ authorId: v.id("users") }).relations((r) => ({
                    author: r.one(targetTable, { field: "authorId" }),
                })),
            });
        `);

        expect(() => discoverSchema(project, schemaPath)).toThrow(CodegenDiagnosticError);
        expect(() => discoverSchema(project, schemaPath)).toThrow(/relation target table must be a string literal/u);
    });

    it("still generates unchanged output for a valid schema exercising every new-validation shape correctly (regression guard against over-rejection)", () => {
        expect.assertions(4);

        // Every shape the new checks touch, used the way a real, valid schema
        // would: non-reserved, non-keyword, non-duplicate table names; a valid
        // extension table name; and literal `v.id()` / `.relations()` targets.
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
                posts: defineTable({ authorId: v.id("users"), body: v.string() }).relations((r) => ({
                    author: r.one("users", { field: "authorId" }),
                })),
            }).extend(
                defineSchemaExtension("ext", {
                    tables: {
                        buckets: defineTable({ key: v.string() }),
                    },
                }),
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["ext_buckets", "posts", "users"]);

        const posts = schema.tables.find((table) => table.name === "posts");

        expect(posts?.shape.authorId).toMatchObject({ kind: "id", tableName: "users" });
        expect(posts?.relations).toEqual([{ field: "authorId", kind: "one", name: "author", onDelete: undefined, references: "_id", table: "users" }]);

        // Emission still succeeds and never surfaces the `_unknown_` sentinel
        // this plan removed — a rejected-in-error schema would either throw
        // before reaching here or leak the sentinel into the generated types.
        const dataModel = emitDataModel(schema);

        expect(dataModel).not.toContain("_unknown_");
    });
});
