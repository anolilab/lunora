import { DatabaseSync } from "node:sqlite";

import type { SqlExec } from "@lunora/shard-engine";
import { v } from "@lunora/values";
import { beforeEach, describe, expect, it } from "vitest";

import type { FacadeEntry, FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";
import { createInProcessRuntime, resolveInProcessIdentity } from "../src/in-process";
import type { Middleware, Policy } from "../src/index";
import { definePolicy, initLunora, rls } from "../src/index";
import { defineSchema, defineTable } from "../src/schema";

/**
 * A many-to-many relation under the `rls()` middleware, over the real shard engine on `node:sqlite`.
 *
 * Plan 489 §3 promises that a read policy on the join table or the target hides a link from `with`, `some` and
 * `_count`, and that a write policy on the join table gates every join row a nested write touches. Both are pinned
 * here, each against the raw writer too, so the policy is what makes the difference.
 */
const schema = defineSchema({
    post_tags: defineTable({ postId: v.id("posts"), tagId: v.id("tags") }).index("byPair", ["postId", "tagId"], { unique: true }),
    posts: defineTable({ title: v.string() }).relations((r) => {
        return { tags: r.many("tags", { through: { from: "postId", table: "post_tags", to: "tagId" } }) };
    }),
    tags: defineTable({ label: v.string() }),
});

interface TestContext {
    auth: { getIdentity: () => Promise<Record<string, unknown>>; userId: string };
    db: FacadeWriterLike;
}

const lunora = initLunora.dataModel<Record<string, never>>().create();

const rlsForTest = (policies: ReadonlyArray<Policy<TestContext>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<TestContext>>) => Middleware<any, any>)(policies);

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
let raw: FacadeWriterLike;
let tags: { hidden: string; visible: string };
let post: string;

const rawTable = (name: string): FacadeEntry => bindTableFacade(raw, name);

const contextFor = (): TestContext => {
    return {
        auth: {
            getIdentity: async () => {
                return { roles: [], userId: "u1" };
            },
            userId: "u1",
        },
        db: raw,
    };
};

/** Run `body` as a query or mutation through `rls(policies)`, with `ctx.db` bound over the engine writer. */
const asQuery = async <Result>(policies: Policy<TestContext>[], body: (db: Record<string, FacadeEntry>) => Promise<Result>): Promise<Result> =>
    lunora.query
        .use(rlsForTest(policies))
        .query(async ({ ctx }) => body(ctx.db as unknown as Record<string, FacadeEntry>))
        .handler(contextFor(), {});

const asMutation = async <Result>(policies: Policy<TestContext>[], body: (db: Record<string, FacadeEntry>) => Promise<Result>): Promise<Result> =>
    runtime.runInTransaction(async () =>
        lunora.mutation
            .use(rlsForTest(policies))
            .mutation(async ({ ctx }) => body(ctx.db as unknown as Record<string, FacadeEntry>))
            .handler(contextFor(), {}),
    );

const linkedIds = async (): Promise<string[]> => {
    const { page } = (await rawTable("post_tags").findMany({ where: { postId: post } })) as { page: Record<string, unknown>[] };

    return page.map((row) => String(row["tagId"])).toSorted((left, right) => left.localeCompare(right));
};

describe("r.many through under rls()", () => {
    beforeEach(async () => {
        runtime = createInProcessRuntime(schema, { sql: nodeSqlExec() });

        raw = runtime.createWriters(resolveInProcessIdentity(null)).rawDatabase as unknown as FacadeWriterLike;
        tags = {
            hidden: (await rawTable("tags").insert({ label: "hidden" })) as string,
            visible: (await rawTable("tags").insert({ label: "visible" })) as string,
        };
        post = (await rawTable("posts").insert({ title: "hello" })) as string;

        await runtime.runInTransaction(async () => rawTable("posts").patch(post, { tags: { connect: [tags.visible, tags.hidden] } }));
    });

    describe.each([
        [
            "the join table",
            (): Policy<TestContext> =>
                definePolicy<TestContext>({
                    on: "read",
                    table: "post_tags",
                    when: () => {
                        return { tagId: tags.visible };
                    },
                }),
        ],
        [
            "the target table",
            (): Policy<TestContext> =>
                definePolicy<TestContext>({
                    on: "read",
                    table: "tags",
                    when: () => {
                        return { _id: tags.visible };
                    },
                }),
        ],
    ])("a read policy on %s", (_label, makePolicy) => {
        it("hides the link from with, some and _count", async () => {
            expect.assertions(6);

            const read = async (policies: Policy<TestContext>[]) =>
                asQuery(policies, async (db) => {
                    const loaded = (await db["posts"]!.findMany({ with: { _count: { tags: true }, tags: true } })) as { page: Record<string, unknown>[] };
                    const matching = (await db["posts"]!.findMany({ where: { tags: { some: { label: "hidden" } } } })) as { page: unknown[] };

                    return {
                        count: (loaded.page[0]?.["_count"] as Record<string, number>)["tags"],
                        labels: (loaded.page[0]?.["tags"] as { label: string }[]).map((tag) => tag.label),
                        matching: matching.page.length,
                    };
                });

            const hidden = await read([makePolicy()]);

            expect(hidden.labels).toStrictEqual(["visible"]);
            expect(hidden.count).toBe(1);
            expect(hidden.matching).toBe(0);

            // Without the policy the same reads see both links, so the policy is what hid it.
            const open = await read([]);

            expect(open.labels.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["hidden", "visible"]);
            expect(open.count).toBe(2);
            expect(open.matching).toBe(1);
        });
    });

    it("a write policy on the join table gates the insert a connect makes, and leaves no join row", async () => {
        expect.assertions(4);

        const other = (await rawTable("tags").insert({ label: "other" })) as string;
        const denyInsert = definePolicy<TestContext>({ on: "insert", table: "post_tags", when: () => false });

        await expect(asMutation([denyInsert], async (db) => db["posts"]!.patch(post, { tags: { connect: [other] } }))).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(linkedIds()).resolves.toStrictEqual([tags.hidden, tags.visible].toSorted((left, right) => left.localeCompare(right)));

        // With no policy the same connect goes through, so the policy is what refused it.
        await expect(asMutation([], async (db) => db["posts"]!.patch(post, { tags: { connect: [other] } }))).resolves.toBeUndefined();
        await expect(linkedIds()).resolves.toContain(other);
    });

    it("a write policy on the join table gates the delete a disconnect makes", async () => {
        expect.assertions(4);

        const denyDelete = definePolicy<TestContext>({ on: "delete", table: "post_tags", when: () => false });

        await expect(asMutation([denyDelete], async (db) => db["posts"]!.patch(post, { tags: { disconnect: [tags.hidden] } }))).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(linkedIds()).resolves.toHaveLength(2);

        await expect(asMutation([], async (db) => db["posts"]!.patch(post, { tags: { disconnect: [tags.hidden] } }))).resolves.toBeUndefined();
        await expect(linkedIds()).resolves.toStrictEqual([tags.visible]);
    });

    it("a caller who cannot read a tag cannot disconnect it, and set leaves a link to it alone", async () => {
        expect.assertions(5);

        const hideTag = definePolicy<TestContext>({
            on: "read",
            table: "tags",
            when: () => {
                return { _id: tags.visible };
            },
        });

        await expect(asMutation([hideTag], async (db) => db["posts"]!.patch(post, { tags: { disconnect: [tags.hidden] } }))).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(linkedIds()).resolves.toHaveLength(2);

        // `set` only sees what the caller can read, so the link to the hidden tag stays and the visible one goes.
        await asMutation([hideTag], async (db) => db["posts"]!.patch(post, { tags: { set: [] } }));

        await expect(linkedIds()).resolves.toStrictEqual([tags.hidden]);

        // Without the policy the same `set` removes both, so the policy is what kept the link.
        await asMutation([], async (db) => db["posts"]!.patch(post, { tags: { set: [] } }));

        await expect(linkedIds()).resolves.toStrictEqual([]);
        await expect(asMutation([], async (db) => db["posts"]!.patch(post, { tags: { disconnect: [tags.hidden] } }))).resolves.toBeUndefined();
    });

    it("connecting to a tag whose existing link the join policy hides succeeds and writes nothing", async () => {
        expect.assertions(2);

        const hideLink = definePolicy<TestContext>({
            on: "read",
            table: "post_tags",
            when: () => {
                return { tagId: tags.visible };
            },
        });

        // The caller cannot see the link to `hidden`, so the pair looks free; the unique index still holds it. The
        // write must neither fail (which would confirm the hidden link exists) nor store a second row.
        // A table with any policy denies the writes no policy allows, so the insert is allowed explicitly.
        const allowInsert = definePolicy<TestContext>({ on: "insert", table: "post_tags", when: () => true });

        await expect(
            asMutation([hideLink, allowInsert], async (db) => db["posts"]!.patch(post, { tags: { connect: [tags.hidden] } })),
        ).resolves.toBeUndefined();
        await expect(linkedIds()).resolves.toHaveLength(2);
    });
});
