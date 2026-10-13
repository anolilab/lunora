import { DatabaseSync } from "node:sqlite";

import type { SqlExec } from "@lunora/shard-engine";
import { v } from "@lunora/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FacadeEntry, FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";
import { createInProcessRuntime, resolveInProcessIdentity } from "../src/in-process";
import { defineSchema, defineTable } from "../src/schema";

/**
 * Nested relation writes through the table facade, over the real shard engine on `node:sqlite`:
 * `{ author: { connect } }` on a to-one and `{ posts: { connect | disconnect | set } }` on a to-many.
 *
 * `comments.postId` is a required foreign key, to pin that `disconnect` is refused where the key cannot be empty.
 * `v.optional(…)` alone means "may be absent", not "may hold null", so the optional keys here are also `.nullable()`.
 * `audits` is `.global()`, to pin that a relation crossing backends is refused rather than half-applied.
 */
const schema = defineSchema({
    albums: defineTable({ title: v.string() })
        .timestamps()
        .relations((r) => {
            return { tracks: r.many("tracks", { field: "albumId" }) };
        }),
    tracks: defineTable({ albumId: v.optional(v.id("albums").nullable()), name: v.string() }),
    audits: defineTable({ note: v.string(), userId: v.optional(v.id("users").nullable()) })
        .global()
        .relations((r) => {
            return { user: r.one("users", { field: "userId" }) };
        }),
    comments: defineTable({ body: v.string(), postId: v.id("posts") }).relations((r) => {
        return { post: r.one("posts", { field: "postId" }) };
    }),
    posts: defineTable({ authorId: v.optional(v.id("users").nullable()), title: v.string() }).relations((r) => {
        return {
            author: r.one("users", { field: "authorId" }),
            comments: r.many("comments", { field: "postId" }),
        };
    }),
    members: defineTable({ name: v.string(), teamSlug: v.optional(v.string().nullable()) }),
    teams: defineTable({ name: v.string(), slug: v.optional(v.string().nullable()) }).relations((r) => {
        return { members: r.many("members", { field: "teamSlug", references: "slug" }) };
    }),
    users: defineTable({ name: v.string() }).relations((r) => {
        return {
            audits: r.many("audits", { field: "userId" }),
            posts: r.many("posts", { field: "authorId" }),
        };
    }),
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

const table = (name: string): FacadeEntry => bindTableFacade(writer as unknown as FacadeWriterLike, name);

const postsOf = async (userId: string): Promise<string[]> => {
    const page = (await table("posts").findMany({ where: { authorId: userId } })) as { page: Record<string, unknown>[] };

    return page.page.map((row) => String(row["title"])).toSorted((left, right) => left.localeCompare(right));
};

const newPost = async (title: string, authorId?: string): Promise<string> =>
    (await table("posts").insert(authorId === undefined ? { title } : { authorId, title })) as string;

describe("nested relation writes", () => {
    beforeEach(() => {
        runtime = createInProcessRuntime(schema, { sql: nodeSqlExec() });
        writer = runtime.createWriters(resolveInProcessIdentity(null)).database;
    });

    describe("to-one", () => {
        it("connect on insert sets the foreign key from the target", async () => {
            expect.assertions(1);

            const user = (await table("users").insert({ name: "ada" })) as string;
            const post = (await table("posts").insert({ author: { connect: user }, title: "hello" })) as string;
            const row = (await table("posts").get(post)) as Record<string, unknown>;

            expect(row["authorId"]).toBe(user);
        });

        it("connect to a row that does not exist is NOT_FOUND and writes nothing", async () => {
            expect.assertions(2);

            await expect(table("posts").insert({ author: { connect: "nope" }, title: "orphan" })).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(((await table("posts").findMany()) as { page: unknown[] }).page).toHaveLength(0);
        });

        it("connect on patch re-points the key, and disconnect clears it", async () => {
            expect.assertions(2);

            const first = (await table("users").insert({ name: "ada" })) as string;
            const second = (await table("users").insert({ name: "bob" })) as string;
            const post = await newPost("hello", first);

            await table("posts").patch(post, { author: { connect: second } });

            expect(((await table("posts").get(post as never)) as Record<string, unknown>)["authorId"]).toBe(second);

            await table("posts").patch(post, { author: { disconnect: true } });

            expect(((await table("posts").get(post as never)) as Record<string, unknown>)["authorId"] ?? null).toBeNull();
        });

        it("refuses disconnect where the foreign key cannot be empty", async () => {
            expect.assertions(1);

            const post = await newPost("hello");
            const comment = (await table("comments").insert({ body: "hi", post: { connect: post } })) as string;

            await expect(table("comments").patch(comment as never, { post: { disconnect: true } })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
        });

        it.each([
            ["the key and the relation together", { author: { connect: "x" }, authorId: "y" }],
            ["connect and disconnect together", { author: { connect: "x", disconnect: true } }],
            ["set on a to-one", { author: { set: ["x"] } }],
            ["a non-id connect", { author: { connect: 5 } }],
        ])("rejects %s", async (_label, values) => {
            expect.assertions(1);

            await expect(table("posts").insert({ title: "t", ...values })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });
    });

    describe("to-many", () => {
        it("connect on insert points the named rows at the new parent", async () => {
            expect.assertions(1);

            const [a, b] = [await newPost("a"), await newPost("b")];
            const user = (await table("users").insert({ name: "ada", posts: { connect: [a, b] } })) as string;

            await expect(postsOf(user)).resolves.toStrictEqual(["a", "b"]);
        });

        it("connect takes a row from its previous parent", async () => {
            expect.assertions(2);

            const first = (await table("users").insert({ name: "ada" })) as string;
            const second = (await table("users").insert({ name: "bob" })) as string;
            const post = await newPost("moving", first);

            await table("users").patch(second, { posts: { connect: [post] } });

            await expect(postsOf(first)).resolves.toStrictEqual([]);
            await expect(postsOf(second)).resolves.toStrictEqual(["moving"]);
        });

        it("disconnect releases only the rows actually connected to this parent", async () => {
            expect.assertions(2);

            const ada = (await table("users").insert({ name: "ada" })) as string;
            const bob = (await table("users").insert({ name: "bob" })) as string;
            const mine = await newPost("mine", ada);
            const theirs = await newPost("theirs", bob);

            await table("users").patch(ada, { posts: { disconnect: [mine, theirs] } });

            await expect(postsOf(ada)).resolves.toStrictEqual([]);
            // A row connected elsewhere is left alone: disconnecting it from the wrong parent is a no-op.
            await expect(postsOf(bob)).resolves.toStrictEqual(["theirs"]);
        });

        it("set makes the list complete: names are connected, the rest released", async () => {
            expect.assertions(2);

            const user = (await table("users").insert({ name: "ada" })) as string;
            const keep = await newPost("keep", user);
            const drop = await newPost("drop", user);
            const add = await newPost("add");

            await table("users").patch(user, { posts: { set: [keep, add] } });

            await expect(postsOf(user)).resolves.toStrictEqual(["add", "keep"]);
            expect(((await table("posts").get(drop as never)) as Record<string, unknown>)["authorId"] ?? null).toBeNull();
        });

        it("applies to the row an upsert writes, on either branch", async () => {
            expect.assertions(2);

            const post = await newPost("a");
            const created = await table("users").upsert({ create: { name: "ada", posts: { connect: [post] } }, target: "name" });
            const other = await newPost("b");
            const updated = await table("users").upsert({ create: { name: "ada" }, target: "name", update: { posts: { connect: [other] } } });

            expect(created.created).toBe(true);
            expect({ created: updated.created, titles: await postsOf(created.id) }).toStrictEqual({ created: false, titles: ["a", "b"] });
        });

        it.each([
            ["set with connect", { posts: { connect: [], set: [] } }],
            ["a non-array list", { posts: { connect: "x" } }],
            ["a list of non-ids", { posts: { connect: [1] } }],
        ])("rejects %s", async (_label, values) => {
            expect.assertions(1);

            const user = (await table("users").insert({ name: "ada" })) as string;

            await expect(table("users").patch(user as never, values as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("rejects a list past the per-write ceiling", async () => {
            expect.assertions(1);

            const user = (await table("users").insert({ name: "ada" })) as string;
            const ids = Array.from({ length: 501 }, (_unused, index) => `id-${String(index)}`);

            await expect(table("users").patch(user as never, { posts: { connect: ids } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it.each([
            ["disconnect", { comments: { disconnect: ["x"] } }],
            ["set", { comments: { set: [] } }],
        ])("refuses %s where the child's foreign key cannot be empty", async (_label, values) => {
            expect.assertions(1);

            const post = await newPost("p");

            await expect(table("posts").patch(post as never, values as never)).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("cannot be empty"),
            });
        });

        it("points children at the parent's referenced column when it is not _id", async () => {
            expect.assertions(1);

            const member = (await table("members").insert({ name: "m" })) as string;
            const team = (await table("teams").insert({ name: "t", slug: "core" })) as string;

            await table("teams").patch(team, { members: { connect: [member] } });

            expect(((await table("members").get(member as never)) as Record<string, unknown>)["teamSlug"]).toBe("core");
        });

        it("refuses to connect children to a parent that has no value for the referenced column", async () => {
            expect.assertions(2);

            const member = (await table("members").insert({ name: "m" })) as string;
            const team = (await table("teams").insert({ name: "t" })) as string;

            await expect(table("teams").patch(team as never, { members: { connect: [member] } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
            expect(((await table("members").get(member as never)) as Record<string, unknown>)["teamSlug"] ?? null).toBeNull();
        });

        it("a patch that only changes relations still needs the row to exist", async () => {
            expect.assertions(1);

            await expect(table("users").patch("missing", { posts: { connect: [] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
        });
    });

    describe("validation happens before anything is written", () => {
        it.each([
            ["a malformed to-many list", { posts: { connect: "x" } }, "VALIDATION_ERROR"],
            ["set combined with connect", { posts: { connect: [], set: [] } }, "VALIDATION_ERROR"],
            ["a relation on another backend", { audits: { connect: ["x"] } }, "UNPROCESSABLE"],
        ])("insert with %s leaves no parent row behind", async (_label, relation, code) => {
            expect.assertions(2);

            await expect(table("users").insert({ name: "ada", ...relation })).rejects.toMatchObject({ code });
            expect(((await table("users").findMany()) as { page: unknown[] }).page).toHaveLength(0);
        });

        it("patch with an invalid to-many write leaves the parent's own columns alone", async () => {
            expect.assertions(2);

            const user = (await table("users").insert({ name: "ada" })) as string;

            await expect(table("users").patch(user as never, { name: "grace", posts: { connect: "x" } })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
            });
            expect(((await table("users").get(user as never)) as Record<string, unknown>)["name"]).toBe("ada");
        });

        it("rejects an unknown operator instead of storing the object as a column", async () => {
            expect.assertions(2);

            await expect(table("posts").insert({ author: { conect: "x" }, title: "t" })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("conect"),
            });
            expect(((await table("posts").findMany()) as { page: unknown[] }).page).toHaveLength(0);
        });

        it("treats an empty relation object as nothing to do", async () => {
            expect.assertions(2);

            const post = (await table("posts").insert({ author: {}, title: "t" })) as string;
            const row = (await table("posts").get(post)) as Record<string, unknown>;

            expect(row["title"]).toBe("t");
            expect(row).not.toHaveProperty("author");
        });
    });

    describe("atomicity and refusals", () => {
        it("a failure partway through rolls back every child already written", async () => {
            expect.assertions(2);

            const user = (await table("users").insert({ name: "ada" })) as string;
            const good = await newPost("good");

            await expect(
                runtime.runInTransaction(async () => table("users").patch(user as never, { posts: { connect: [good, "missing"] } })),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });

            // `good` was connected before `missing` failed; the transaction takes it back.
            await expect(postsOf(user)).resolves.toStrictEqual([]);
        });

        it("refuses a relation that crosses to a .global() table", async () => {
            expect.assertions(1);

            const user = (await table("users").insert({ name: "ada" })) as string;

            await expect(table("users").patch(user as never, { audits: { connect: ["x"] } })).rejects.toMatchObject({ code: "UNPROCESSABLE" });
        });

        it.each([
            ["insertMany", (entry: FacadeEntry) => entry.insertMany([{ author: { connect: "x" }, title: "t" }])],
            ["patchMany", (entry: FacadeEntry) => entry.patchMany([{ id: "x", values: { author: { disconnect: true } } }] as never)],
            ["replace", (entry: FacadeEntry) => entry.replace("x", { author: { connect: "x" }, title: "t" })],
        ])("%s refuses a relation write instead of storing it as a column value", async (_label, run) => {
            expect.assertions(1);

            await expect((async () => run(table("posts")))()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("refuses a relation a wrapper has marked as not writable", async () => {
            expect.assertions(2);

            const raw = writer as unknown as FacadeWriterLike & { relationWrites: Record<string, Record<string, object>> };
            const refused = {
                ...raw,
                relationWrites: { posts: { ...raw.relationWrites["posts"], author: { ...raw.relationWrites["posts"]?.["author"], refusal: "masked" } } },
            };
            const user = (await table("users").insert({ name: "ada" })) as string;

            await expect(
                bindTableFacade(refused as unknown as FacadeWriterLike, "posts").insert({ author: { connect: user }, title: "t" }),
            ).rejects.toMatchObject({
                code: "UNPROCESSABLE",
                message: expect.stringContaining("masked"),
            });
            expect(((await table("posts").findMany()) as { page: unknown[] }).page).toHaveLength(0);
        });

        it("leaves an ordinary patch alone", async () => {
            expect.assertions(1);

            const post = await newPost("t");

            await table("posts").patch(post, { title: "renamed" });

            expect(((await table("posts").get(post as never)) as Record<string, unknown>)["title"]).toBe("renamed");
        });

        it("refuses an upsert whose target key is supplied by a relation write", async () => {
            expect.assertions(1);

            const user = (await table("users").insert({ name: "ada" })) as string;

            await expect(table("posts").upsert({ create: { author: { connect: user }, title: "t" }, target: "authorId" })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("authorId"),
            });
        });
    });

    describe("relation-only patch", () => {
        it("leaves the parent row exactly as it was, updatedAt included, and changes only the child", async () => {
            expect.assertions(3);

            const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
            const album = (await table("albums").insert({ title: "Live" })) as string;
            const track = (await table("tracks").insert({ name: "Intro" })) as string;
            const before = (await table("albums").get(album)) as Record<string, unknown>;

            clock.mockReturnValue(2000);

            try {
                await table("albums").patch(album, { tracks: { connect: [track] } });
            } finally {
                clock.mockRestore();
            }

            expect(before["updatedAt"]).toBe(1000);
            await expect(table("albums").get(album as never)).resolves.toStrictEqual(before);
            expect(((await table("tracks").get(track as never)) as Record<string, unknown>)["albumId"]).toBe(album);
        });

        it("is NOT_FOUND for a missing parent and writes no child", async () => {
            expect.assertions(2);

            const track = (await table("tracks").insert({ name: "Intro" })) as string;

            await expect(table("albums").patch("nope", { tracks: { connect: [track] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(((await table("tracks").get(track as never)) as Record<string, unknown>)["albumId"] ?? null).toBeNull();
        });
    });
});
