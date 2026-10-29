import { DatabaseSync } from "node:sqlite";

import type { SchemaLike, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import type { Validator } from "@lunora/values";
import { v } from "@lunora/values";
import { beforeEach, describe, expect, it } from "vitest";

import type { FacadeEntry, FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";
import { createInProcessRuntime, resolveInProcessIdentity } from "../src/in-process";
import { defineSchema, defineTable } from "../src/schema";
import type { TableDefinition } from "../src/types";

/**
 * Many-to-many relations (`r.many(target, { through })`) over the real shard engine on `node:sqlite`: the schema
 * rules that make a join table sound, nested `connect`/`disconnect`/`set` writes, and rollback of a failed `set`.
 *
 * `post_tags` cascades from both sides through its own `r.one(..., { onDelete })` relations, which is how a
 * through relation inherits its delete behaviour. `bad_votes` has a required column besides the two keys, to pin
 * that `connect` refuses a join table it cannot fill in. `audit_links` is `.global()`, to pin the colocation rule.
 */
/** The tag whose join row the `post_tags` trigger rejects; set per test. */
let blockedTag: string;

const joinShape = { postId: v.id("posts"), tagId: v.id("tags") };

const buildSchema = () =>
    defineSchema({
        audit_links: defineTable({ postId: v.id("posts"), tagId: v.id("tags") })
            .global()
            .index("byPair", ["postId", "tagId"], { unique: true }),
        solo_tags: defineTable({ postId: v.id("posts"), tagId: v.id("tags") })
            .index("byPair", ["postId", "tagId"], { unique: true })
            .index("onePerPost", ["postId"], { unique: true }),
        stamped_tags: defineTable({ addedBy: v.string().serverDefault(() => "system"), postId: v.id("posts"), tagId: v.id("tags") }).index(
            "byPair",
            ["postId", "tagId"],
            {
                unique: true,
            },
        ),
        bad_votes: defineTable({ postId: v.id("posts"), role: v.string(), tagId: v.id("tags") }).index("byPair", ["postId", "tagId"], { unique: true }),
        post_tags: defineTable(joinShape)
            .index("byPair", ["postId", "tagId"], { unique: true })
            .relations((r) => {
                return {
                    post: r.one("posts", { field: "postId", onDelete: "cascade" }),
                    tag: r.one("tags", { field: "tagId", onDelete: "cascade" }),
                };
            })
            .triggers((t) => {
                return {
                    rejectBlocked: t.beforeInsert((_context, event) => {
                        if (event.doc.tagId === blockedTag) {
                            throw new Error("tag is blocked");
                        }
                    }),
                };
            }),
        posts: defineTable({ title: v.string() }).relations((r) => {
            return {
                audited: r.many("tags", { through: { from: "postId", table: "audit_links", to: "tagId" } }),
                solo: r.many("tags", { through: { from: "postId", table: "solo_tags", to: "tagId" } }),
                stamped: r.many("tags", { through: { from: "postId", table: "stamped_tags", to: "tagId" } }),
                tags: r.many("tags", { through: { from: "postId", table: "post_tags", to: "tagId" } }),
                voted: r.many("tags", { through: { from: "postId", table: "bad_votes", to: "tagId" } }),
            };
        }),
        tags: defineTable({ label: v.string() }),
    });

const nodeSqlExec = (): SqlExec => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: <Row>(query: string, ...params: unknown[]) => {
            const rows = database.prepare(query).all(...(params as never[])) as Row[];

            return { one: () => rows[0] as Row, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        },
    };
};

let runtime: ReturnType<typeof createInProcessRuntime>;
let writer: ReturnType<ReturnType<typeof createInProcessRuntime>["createWriters"]>["database"];

/** The facade with no transaction around it, for use inside one (`runtime.runInTransaction` does not nest). */
const bare = (name: string): FacadeEntry => bindTableFacade(writer as unknown as FacadeWriterLike, name);

/** The facade whose writes each run as their own mutation, as a mutation handler's would. */
const table = (name: string): FacadeEntry => {
    const entry = bare(name);

    return {
        ...entry,
        delete: async (id) => runtime.runInTransaction(async () => entry.delete(id)),
        insert: async (document, options) => runtime.runInTransaction(async () => entry.insert(document, options)),
        patch: async (id, values) => runtime.runInTransaction(async () => entry.patch(id, values)),
    };
};

const newPost = async (title = "hello"): Promise<string> => (await table("posts").insert({ title })) as string;
const newTag = async (label: string): Promise<string> => (await table("tags").insert({ label })) as string;

/** The tag ids a post is linked to, read straight off the join table. */
const linked = async (post: string): Promise<string[]> => {
    const page = (await table("post_tags").findMany({ where: { postId: post } })) as { page: Record<string, unknown>[] };

    return page.page.map((row) => String(row["tagId"])).toSorted((left, right) => left.localeCompare(right));
};

const sorted = (ids: string[]): string[] => ids.toSorted((left, right) => left.localeCompare(right));

describe("r.many through: schema rules", () => {
    it("records the join table and keys on the relation", () => {
        expect.assertions(1);

        expect(buildSchema().tables["posts"]?.relationMap["tags"]).toStrictEqual({
            kind: "many",
            table: "tags",
            through: { from: "postId", table: "post_tags", to: "tagId" },
        });
    });

    it("names the join table when it is not declared", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                posts: defineTable({ title: v.string() }).relations((r) => {
                    return { tags: r.many("tags", { through: { from: "postId", table: "nope", to: "tagId" } }) };
                }),
                tags: defineTable({ label: v.string() }),
            }),
        ).toThrow(/join table that is not declared/u);
    });

    it("refuses from and to naming the same column", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                join: defineTable({ postId: v.id("posts") }).index("byPair", ["postId", "postId"], { unique: true }),
                posts: defineTable({ title: v.string() }).relations((r) => {
                    return { posts: r.many("posts", { through: { from: "postId", table: "join", to: "postId" } }) };
                }),
            }),
        ).toThrow(/both name "postId"/u);
    });

    it("requires both keys to be required v.id columns on the right tables", () => {
        expect.assertions(2);

        const build = (shape: Record<string, Validator>) => () =>
            defineSchema({
                join: defineTable(shape).index("byPair", ["postId", "tagId"], { unique: true }),
                posts: defineTable({ title: v.string() }).relations((r) => {
                    return { tags: r.many("tags", { through: { from: "postId", table: "join", to: "tagId" } }) };
                }),
                tags: defineTable({ label: v.string() }),
            });

        expect(build({ postId: v.id("tags"), tagId: v.id("tags") })).toThrow(/join\.postId" must be a required v\.id\("posts"\)/u);
        expect(build({ postId: v.id("posts"), tagId: v.optional(v.id("tags")) })).toThrow(/join\.tagId" must be a required v\.id\("tags"\)/u);
    });

    it("requires a unique index over exactly the two keys", () => {
        expect.assertions(2);

        const build = (join: TableDefinition) => () =>
            defineSchema({
                join,
                posts: defineTable({ title: v.string() }).relations((r) => {
                    return { tags: r.many("tags", { through: { from: "postId", table: "join", to: "tagId" } }) };
                }),
                tags: defineTable({ label: v.string() }),
            });

        // A plain index does not stop a repeated connect from storing the pair twice.
        expect(build(defineTable(joinShape).index("byPair", ["postId", "tagId"]))).toThrow(/unique index over \("postId", "tagId"\)/u);
        expect(build(defineTable(joinShape).index("byPair", ["tagId", "postId"], { unique: true }))).not.toThrow();
    });
});

describe("r.many through: nested writes", () => {
    beforeEach(() => {
        blockedTag = "";
        runtime = createInProcessRuntime(buildSchema(), { sql: nodeSqlExec() });
        writer = runtime.createWriters(resolveInProcessIdentity(null)).database;
    });

    it("connect on insert writes one join row per target", async () => {
        expect.assertions(1);

        const [a, b] = [await newTag("a"), await newTag("b")] as [string, string];
        const post = (await table("posts").insert({ tags: { connect: [a, b] }, title: "hello" })) as string;

        await expect(linked(post)).resolves.toStrictEqual(sorted([a, b]));
    });

    it("connect is idempotent and never stores a pair twice", async () => {
        expect.assertions(2);

        const tag = await newTag("a");
        const post = await newPost();

        await table("posts").patch(post, { tags: { connect: [tag] } });
        await table("posts").patch(post, { tags: { connect: [tag] } });

        await expect(linked(post)).resolves.toStrictEqual([tag]);
        expect(((await table("tags").get(tag as never)) as Record<string, unknown>)["label"]).toBe("a");
    });

    it("disconnect deletes the join row, leaves the target, and ignores a link that is not there", async () => {
        expect.assertions(3);

        const [a, b] = [await newTag("a"), await newTag("b")] as [string, string];
        const post = await newPost();
        const unlinked = await newTag("unlinked");

        await table("posts").patch(post, { tags: { connect: [a, b] } });
        await table("posts").patch(post, { tags: { disconnect: [a, unlinked] } });

        await expect(linked(post)).resolves.toStrictEqual([b]);
        await expect(table("tags").get(a as never)).resolves.toMatchObject({ label: "a" });
        await expect(table("posts").patch(post, { tags: { disconnect: [a] } })).resolves.toBeUndefined();
    });

    it("set diffs against the links already there: releases the missing, adds the new, keeps the rest", async () => {
        expect.assertions(2);

        const [a, b, c] = [await newTag("a"), await newTag("b"), await newTag("c")] as [string, string, string];
        const post = await newPost();

        await table("posts").patch(post, { tags: { connect: [a, b] } });

        const kept = ((await table("post_tags").findMany({ where: { postId: post, tagId: b } })) as { page: Record<string, unknown>[] }).page[0]?.["_id"];

        await table("posts").patch(post, { tags: { set: [b, c] } });

        await expect(linked(post)).resolves.toStrictEqual(sorted([b, c]));
        // `b` was already linked, so its join row was left alone rather than deleted and re-inserted.
        await expect(table("post_tags").get(kept as never)).resolves.toMatchObject({ tagId: b });
    });

    it("set to an empty list removes every link", async () => {
        expect.assertions(1);

        const tag = await newTag("a");
        const post = await newPost();

        await table("posts").patch(post, { tags: { connect: [tag] } });
        await table("posts").patch(post, { tags: { set: [] } });

        await expect(linked(post)).resolves.toStrictEqual([]);
    });

    it("a missing target is NOT_FOUND and writes nothing", async () => {
        expect.assertions(2);

        const tag = await newTag("a");
        const post = await newPost();

        await expect(table("posts").patch(post, { tags: { connect: [tag, "missing"] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(linked(post)).resolves.toStrictEqual([]);
    });

    it("writes a join table whose extra required column the server stamps itself", async () => {
        expect.assertions(1);

        const tag = await newTag("a");
        const post = await newPost();

        await table("posts").patch(post, { stamped: { connect: [tag] } });

        await expect(bare("stamped_tags").findMany({ where: { postId: post } })).resolves.toMatchObject({ page: [{ addedBy: "system", tagId: tag }] });
    });

    it("refuses a join table with a required column it cannot fill in", async () => {
        expect.assertions(1);

        const tag = await newTag("a");
        const post = await newPost();

        await expect(table("posts").patch(post, { voted: { connect: [tag] } })).rejects.toMatchObject({
            code: "UNPROCESSABLE",
            message: expect.stringContaining("role"),
        });
    });

    it("refuses a join table on another backend rather than half-apply it", async () => {
        expect.assertions(1);

        const tag = await newTag("a");
        const post = await newPost();

        await expect(table("posts").patch(post, { audited: { connect: [tag] } })).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    });

    it("rolls a failed set back to the join rows it started with", async () => {
        expect.assertions(2);

        const [a, b, bad] = [await newTag("a"), await newTag("b"), await newTag("bad")] as [string, string, string];
        const post = await newPost();

        await table("posts").patch(post, { tags: { connect: [a, b] } });
        blockedTag = bad;

        // `set` releases `a`, then inserts `bad`, whose join row the trigger rejects: the delete has already happened.
        await expect(runtime.runInTransaction(async () => bare("posts").patch(post, { tags: { set: [b, bad] } }))).rejects.toThrow(/blocked/u);

        await expect(linked(post)).resolves.toStrictEqual(sorted([a, b]));
    });

    it("surfaces a unique conflict that is not the pair, instead of reporting a link that was never written", async () => {
        expect.assertions(2);

        const [a, b] = [await newTag("a"), await newTag("b")] as [string, string];
        const post = await newPost();

        await table("posts").patch(post, { solo: { connect: [a] } });

        // `solo_tags` also allows one row per post, so the second tag hits that rule, not the pair.
        await expect(table("posts").patch(post, { solo: { connect: [b] } })).rejects.toMatchObject({ code: "CONFLICT" });
        // The pair that already exists is still a no-op.
        await expect(table("posts").patch(post, { solo: { connect: [a] } })).resolves.toBeUndefined();
    });

    it("refuses naming the same id in connect and disconnect", async () => {
        expect.assertions(1);

        const tag = await newTag("a");
        const post = await newPost();

        await expect(table("posts").patch(post, { tags: { connect: [tag], disconnect: [tag] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("disconnecting a tag that does not exist is NOT_FOUND, as for a one-to-many", async () => {
        expect.assertions(1);

        const post = await newPost();

        await expect(table("posts").patch(post, { tags: { disconnect: ["missing"] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a write on a writer that does not say it is in a transaction", async () => {
        expect.assertions(1);

        const sql = nodeSqlExec();
        const schema = buildSchema() as unknown as SchemaLike;

        runShardMigrations(sql, schema);

        // No `inTransaction` option at all: the writer is not trusted to be inside one.
        const unknown = createShardCtxDb({ schema, sql }) as unknown as FacadeWriterLike;
        const post = (await bindTableFacade(unknown, "posts").insert({ title: "hello" })) as string;

        await expect(bindTableFacade(unknown, "posts").patch(post, { tags: { connect: [] } })).rejects.toMatchObject({ code: "UNPROCESSABLE" });
    });

    it("deleting either side cascades through the join table's own onDelete", async () => {
        expect.assertions(2);

        const [a, b] = [await newTag("a"), await newTag("b")] as [string, string];
        const post = await newPost();

        await table("posts").patch(post, { tags: { connect: [a, b] } });
        await table("tags").delete(a);

        await expect(linked(post)).resolves.toStrictEqual([b]);

        await table("posts").delete(post);

        expect(((await table("post_tags").findMany()) as { page: unknown[] }).page).toHaveLength(0);
    });
});

describe("r.many through: outside a transaction", () => {
    it("refuses a write in an action, where the earlier join rows could not be rolled back", async () => {
        expect.assertions(3);

        const sql = nodeSqlExec();
        const schema = buildSchema() as unknown as SchemaLike;

        // The shard opens a transaction around every mutation; an action is the same writer with none open.
        runShardMigrations(sql, schema);

        let open = false;
        const actionWriter = createShardCtxDb({ inTransaction: () => open, schema, sql }) as unknown as FacadeWriterLike;
        const tag = (await bindTableFacade(actionWriter, "tags").insert({ label: "a" })) as string;
        const post = (await bindTableFacade(actionWriter, "posts").insert({ title: "hello" })) as string;

        await expect(bindTableFacade(actionWriter, "posts").patch(post, { tags: { connect: [tag] } })).rejects.toMatchObject({
            code: "UNPROCESSABLE",
            message: expect.stringContaining("mutation"),
        });

        open = true;

        await expect(bindTableFacade(actionWriter, "posts").patch(post, { tags: { connect: [tag] } })).resolves.toBeUndefined();
        await expect(bindTableFacade(actionWriter, "post_tags").findMany({ where: { postId: post } })).resolves.toMatchObject({ page: [{ tagId: tag }] });
    });
});
