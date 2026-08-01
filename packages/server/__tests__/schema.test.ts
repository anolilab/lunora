import { describe, expect, it } from "vitest";

import { defineAggregateIndex, defineRankIndex, defineSchema, defineTable, defineVectorIndex, indexFieldsFromSchema, v } from "../src/index";

describe("defineTable", () => {
    it("returns a table definition with shape and default __root__ shard mode", () => {
        expect.assertions(4);

        const messages = defineTable({
            text: v.string(),
            userId: v.id("users"),
        });

        expect(messages.shape.text.kind).toBe("string");
        expect(messages.shardMode).toEqual({ kind: "root" });
        expect(messages.indexes).toEqual([]);
        expect(messages.searchIndexes).toEqual([]);
    });

    it("rejects a v.from() column (args-only), including when nested under v.optional/array", () => {
        expect.assertions(3);

        const fake = {
            "~standard": {
                validate: (value: unknown) => {
                    return { value };
                },
                vendor: "fake",
                version: 1 as const,
            },
        };

        expect(() => defineTable({ x: v.from(fake) })).toThrow(/args-only/u);
        expect(() => defineTable({ x: v.optional(v.from(fake)) })).toThrow(/args-only/u);
        expect(() => defineTable({ x: v.array(v.from(fake)) })).toThrow(/args-only/u);
    });

    it(".index appends an index definition", () => {
        expect.assertions(3);

        const messages = defineTable({ channelId: v.id("channels"), createdAt: v.number() })
            .index("by_channel", ["channelId"])
            .index("by_channel_time", ["channelId", "createdAt"], { unique: true });

        expect(messages.indexes).toHaveLength(2);
        expect(messages.indexes[0]).toMatchObject({ fields: ["channelId"], name: "by_channel", unique: false });
        expect(messages.indexes[1]).toMatchObject({ fields: ["channelId", "createdAt"], name: "by_channel_time", unique: true });
    });

    it(".searchIndex appends a search index definition", () => {
        expect.assertions(2);

        const documents = defineTable({ body: v.string(), workspaceId: v.id("workspaces") }).searchIndex("by_body", {
            field: "body",
            filterFields: ["workspaceId"],
        });

        expect(documents.searchIndexes).toHaveLength(1);
        expect(documents.searchIndexes[0]).toMatchObject({ field: "body", filterFields: ["workspaceId"], name: "by_body" });
    });

    /**
     * Both guards exist for the same reason: neither option *degrades* on a
     * typo, so nothing downstream can report one. An unknown language silently
     * analyzes as folding-only; an unknown strategy silently picks a different
     * physical storage layout. Schema-build time is the only place either is
     * still a typo rather than a stored fact.
     */
    it(".searchIndex refuses an unknown language or strategy", () => {
        expect.assertions(3);

        expect(() => defineTable({ body: v.string() }).searchIndex("by_body", { field: "body", language: "klingon" as never })).toThrow(
            /unknown language "klingon" \(supported: de, en, es, fr, it, nl, none, pt\)/u,
        );
        expect(() => defineTable({ body: v.string() }).searchIndex("by_body", { field: "body", strategy: "Native" as never })).toThrow(
            /unknown strategy "Native" \(supported: native, portable\)/u,
        );
        // The accepted spellings still pass, so the guards are not just refusing.
        expect(defineTable({ body: v.string() }).searchIndex("by_body", { field: "body", language: "en", strategy: "native" }).searchIndexes[0]).toMatchObject({
            language: "en",
            strategy: "native",
        });
    });

    it(".shardBy marks the table as shard-local", () => {
        expect.assertions(1);

        const documents = defineTable({ body: v.string(), workspaceId: v.id("workspaces") }).shardBy("workspaceId");

        expect(documents.shardMode).toEqual({ field: "workspaceId", kind: "shardBy" });
    });

    it(".ownedBy records the owning column for owner-scoped shapes", () => {
        expect.assertions(2);

        // Independent of `.shardBy` even when both name the same column: the shard
        // key routes storage, `ownedBy` states who the rows belong to.
        const nodes = defineTable({ text: v.string(), userId: v.string() }).shardBy("userId").ownedBy("userId");

        expect(nodes.ownerField).toBe("userId");
        expect(defineTable({ text: v.string() }).ownerField).toBeUndefined();
    });

    it(".global marks the table as global", () => {
        expect.assertions(1);

        const users = defineTable({ email: v.string() }).global();

        expect(users.shardMode).toEqual({ backend: "d1", kind: "global" });
    });

    it('.global({ backend: "hyperdrive" }) records the Hyperdrive backend', () => {
        expect.assertions(1);

        const settings = defineTable({ key: v.string() }).global({ backend: "hyperdrive" });

        expect(settings.shardMode).toEqual({ backend: "hyperdrive", kind: "global" });
    });

    it("table without .vectorize exposes an empty vectorIndexes array", () => {
        expect.assertions(1);

        const docs = defineTable({ body: v.string() });

        expect(docs.vectorIndexes).toEqual([]);
    });

    it(".vectorize appends an inline vector index (Shape A)", () => {
        expect.assertions(3);

        const embed = (text: string): ReadonlyArray<number> => [text.length];
        const docs = defineTable({ body: v.string(), title: v.string(), workspaceId: v.id("workspaces") })
            .shardBy("workspaceId")
            .vectorize("body", { dimensions: 1024, embed, index: "docs-body", metadata: ["title", "workspaceId"], metric: "cosine" });

        expect(docs.vectorIndexes).toHaveLength(1);
        expect(docs.vectorIndexes[0]).toMatchObject({
            dimensions: 1024,
            field: "body",
            metadata: ["title", "workspaceId"],
            metric: "cosine",
            name: "docs-body",
        });
        expect(docs.vectorIndexes[0]?.embed).toBe(embed);
    });

    it(".aggregateIndex defaults to count and stashes the by-tuple", () => {
        expect.assertions(5);

        const todos = defineTable({ archived: v.boolean(), projectId: v.string() })
            .aggregateIndex("byProject", { by: ["projectId"] })
            .aggregateIndex("activeByProject", { by: ["projectId"], where: { archived: false } });

        expect(todos.aggregateIndexes).toHaveLength(2);
        expect(todos.aggregateIndexes[0]).toMatchObject({ by: ["projectId"], name: "byProject", op: "count" });
        expect(todos.aggregateIndexes[1]).toMatchObject({ name: "activeByProject", where: { archived: false } });

        // `on` is filled in by defineSchema once the table is keyed.
        const schema = defineSchema({ todos });

        expect(schema.tables.todos.aggregateIndexes[0]?.on).toBe("todos");
        expect(schema.tables.todos.aggregateIndexes[1]?.on).toBe("todos");
    });

    it(".aggregateIndex(non-count) requires a field", () => {
        expect.assertions(1);

        const builder = defineTable({ seq: v.number() });

        expect(() => builder.aggregateIndex("seqSum", { op: "sum" })).toThrow(/requires a "field"/);
    });

    it(".rankIndex stashes name, sortBy (asc default) + partitionBy + where", () => {
        expect.assertions(6);

        const messages = defineTable({ archived: v.boolean(), channelId: v.string(), createdAt: v.number(), score: v.number() })
            .rankIndex("byChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }] })
            .rankIndex("leaderboard", { sortBy: [{ direction: "desc", field: "score" }] })
            .rankIndex("activeByChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }], where: { archived: false } });

        expect(messages.rankIndexes).toHaveLength(3);
        expect(messages.rankIndexes[0]).toMatchObject({
            name: "byChannel",
            partitionBy: ["channelId"],
            sortBy: [{ direction: "asc", field: "createdAt" }],
        });
        expect(messages.rankIndexes[1]).toMatchObject({
            name: "leaderboard",
            sortBy: [{ direction: "desc", field: "score" }],
        });
        expect(messages.rankIndexes[2]).toMatchObject({
            name: "activeByChannel",
            where: { archived: false },
        });

        // `on` is filled in by defineSchema once the table is keyed.
        const schema = defineSchema({ messages });

        expect(schema.tables.messages.rankIndexes[0]?.on).toBe("messages");
        expect(schema.tables.messages.rankIndexes[1]?.on).toBe("messages");
    });

    it(".rankIndex requires a non-empty sortBy", () => {
        expect.assertions(1);

        const builder = defineTable({ score: v.number() });

        expect(() => builder.rankIndex("bad", { sortBy: [] })).toThrow(/sortBy/);
    });

    it("builder chains return the same instance", () => {
        expect.assertions(1);

        const builder = defineTable({ a: v.string() });
        const chained = builder.index("by_a", ["a"]).shardBy("a");

        expect(chained).toBe(builder);
    });
});

describe("defineSchema", () => {
    it("collects tables into a Schema", () => {
        expect.assertions(3);

        const schema = defineSchema({
            messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
            users: defineTable({ email: v.string() }).global().index("by_email", ["email"], { unique: true }),
        });

        expect(Object.keys(schema.tables)).toEqual(["messages", "users"]);
        expect(schema.tables.users.shardMode).toEqual({ backend: "d1", kind: "global" });
        expect(schema.tables.messages.shardMode).toEqual({ field: "channelId", kind: "shardBy" });
    });

    it("defaults vectorIndexes to an empty object when the second arg is omitted", () => {
        expect.assertions(1);

        const schema = defineSchema({ users: defineTable({ email: v.string() }) });

        expect(schema.vectorIndexes).toEqual({});
    });

    it("standalone defineAggregateIndex entries fold onto the owning table", () => {
        expect.assertions(2);

        const schema = defineSchema(
            { todos: defineTable({ archived: v.boolean(), projectId: v.string() }) },
            {},
            {
                byProject: defineAggregateIndex("byProject", { by: ["projectId"], on: "todos" }),
            },
        );

        expect(schema.tables.todos.aggregateIndexes).toHaveLength(1);
        expect(schema.tables.todos.aggregateIndexes[0]).toMatchObject({ by: ["projectId"], name: "byProject", on: "todos", op: "count" });
    });

    it("standalone defineAggregateIndex throws when `on` table is unknown", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({ todos: defineTable({ projectId: v.string() }) }, {}, { stray: defineAggregateIndex("stray", { by: ["projectId"], on: "missing" }) }),
        ).toThrow(/unknown table/);
    });

    it("standalone defineRankIndex entries fold onto the owning table", () => {
        expect.assertions(2);

        const schema = defineSchema(
            { messages: defineTable({ channelId: v.string(), createdAt: v.number() }) },
            {},
            {},
            {
                byChannel: defineRankIndex("byChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }], table: "messages" }),
            },
        );

        expect(schema.tables.messages.rankIndexes).toHaveLength(1);
        expect(schema.tables.messages.rankIndexes[0]).toMatchObject({
            name: "byChannel",
            on: "messages",
            partitionBy: ["channelId"],
            sortBy: [{ direction: "asc", field: "createdAt" }],
        });
    });

    it("standalone defineRankIndex throws when `table` is unknown", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema(
                { messages: defineTable({ createdAt: v.number() }) },
                {},
                {},
                { stray: defineRankIndex("stray", { sortBy: [{ field: "createdAt" }], table: "missing" }) },
            ),
        ).toThrow(/unknown table/);
    });

    it("defineRankIndex requires a non-empty sortBy", () => {
        expect.assertions(1);

        expect(() => defineRankIndex("bad", { sortBy: [], table: "messages" })).toThrow(/sortBy/);
    });

    it("registers standalone defineVectorIndex entries from the second arg (Shape B)", () => {
        expect.assertions(2);

        const embed = async (text: string): Promise<ReadonlyArray<number>> => [text.length];
        const schema = defineSchema(
            { docs: defineTable({ body: v.string(), title: v.string() }) },
            {
                "docs-title-and-body": defineVectorIndex({
                    dimensions: 1024,
                    embed,
                    metric: "cosine",
                    source: { select: (row) => `${String(row.title)}\n\n${String(row.body)}`, table: "docs" },
                }),
            },
        );

        const index = schema.vectorIndexes["docs-title-and-body"];

        expect(index).toMatchObject({ dimensions: 1024, kind: "vectorIndex", metric: "cosine", table: "docs" });
        expect(index?.select({ body: "B", title: "T" })).toBe("T\n\nB");
    });
});

describe("indexFieldsFromSchema (plan 250 — mask() bare-index-scan / rank oracle)", () => {
    it("maps a regular index's declared `fields` and a rank index's `sortBy` ∪ `partitionBy`", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ createdAt: v.number(), score: v.number(), ssn: v.string() })
                .index("by_ssn", ["ssn"])
                .rankIndex("by_score", { partitionBy: ["ssn"], sortBy: [{ field: "score" }] }),
        });

        expect(indexFieldsFromSchema(schema)).toStrictEqual({
            users: {
                by_score: ["score", "ssn"],
                by_ssn: ["ssn"],
            },
        });
    });

    it("omits a table with no declared indexes rather than mapping it to `{}`", () => {
        expect.assertions(1);

        const schema = defineSchema({ users: defineTable({ email: v.string() }) });

        expect(indexFieldsFromSchema(schema)).toStrictEqual({});
    });

    it("folds a rank index with no `partitionBy` down to just its `sortBy` fields", () => {
        expect.assertions(1);

        const schema = defineSchema({
            messages: defineTable({ createdAt: v.number() }).rankIndex("byTime", { sortBy: [{ field: "createdAt" }] }),
        });

        expect(indexFieldsFromSchema(schema)).toStrictEqual({ messages: { byTime: ["createdAt"] } });
    });

    it("maps a geo index's declared `field` (closes the withGeoIndex position oracle)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            users: defineTable({ homeLocation: v.geoPoint(), name: v.string() }).geoIndex("by_location", { field: "homeLocation" }),
        });

        expect(indexFieldsFromSchema(schema)).toStrictEqual({
            users: {
                by_location: ["homeLocation"],
            },
        });
    });

    it("does NOT include vectorIndexes or aggregateIndexes fields — neither is a reachable ordinal oracle through the masked reader", () => {
        expect.assertions(1);

        const embed = async (text: string): Promise<ReadonlyArray<number>> => [text.length];
        const schema = defineSchema(
            { docs: defineTable({ body: v.string(), ssn: v.string() }).aggregateIndex("byCount") },
            {
                byEmbedding: defineVectorIndex({
                    dimensions: 3,
                    embed,
                    metric: "cosine",
                    source: { select: (row) => String(row.body), table: "docs" },
                }),
            },
        );

        expect(indexFieldsFromSchema(schema)).toStrictEqual({});
    });
});

describe("defineSchema().jurisdiction()", () => {
    it("is chainable and preserves the schema's tables", () => {
        expect.assertions(2);

        const schema = defineSchema({
            messages: defineTable({ text: v.string() }),
        }).jurisdiction("us");

        expect(Object.keys(schema.tables)).toStrictEqual(["messages"]);
        // Still extendable/composable after pinning the jurisdiction.
        expect(typeof schema.extend).toBe("function");
    });

    it("composes with .rls() in either order", () => {
        expect.assertions(2);

        const a = defineSchema({ messages: defineTable({ text: v.string() }) })
            .rls("required")
            .jurisdiction("eu");
        const b = defineSchema({ messages: defineTable({ text: v.string() }) })
            .jurisdiction("eu")
            .rls("required");

        expect(a.rlsMode).toBe("required");
        expect(b.rlsMode).toBe("required");
    });
});
