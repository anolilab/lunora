/**
 * Under `.rls("required")` a protected table with no read policy is closed to a
 * direct read, and these tests pin that it stays closed when it is reached as a
 * RELATION of a readable parent instead: a `with` load, a `_count`, or a nested
 * `with` one level down. The child fetch runs inside the engine's relation
 * resolver against the unwrapped writer, so neither the guard nor a fake writer
 * sees it — this runs the real engine.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { query } = initLunora.dataModel().create();

/** See `rls-enforcement.test.ts`: the raw builder types `ctx.db` nominally, so the middleware is cast once here. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const schema = defineSchema({
    audit: defineTable({ note: v.string(), postId: v.string() })
        .public()
        .relations((r) => {
            return { secrets: r.many("secrets", { field: "auditId" }) };
        }),
    notices: defineTable({ text: v.string() })
        .public()
        .relations((r) => {
            return { secrets: r.many("secrets", { field: "noticeId" }) };
        }),
    posts: defineTable({ title: v.string() }).relations((r) => {
        return {
            audit: r.many("audit", { field: "postId" }),
            secrets: r.many("secrets", { field: "postId" }),
        };
    }),
    secrets: defineTable({ auditId: v.string(), body: v.string(), noticeId: v.string(), postId: v.string() }),
}).rls("required");

const readPosts = definePolicy({ on: "read", table: "posts", when: () => true });

/** The writer surface these reads use; the builder's nominal `ctx.db` type does not list `findMany`. */
type FindMany = (table: string, args: Record<string, unknown>) => Promise<{ page: Record<string, unknown>[] }>;

const postsWith = (withInput: Record<string, unknown>) =>
    query
        .use(rlsForTest(definePolicies([readPosts])))
        .query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("posts", { with: withInput }));

/** No `rls()` at all: the guard admits the `.public()` parent, and the child must still be refused. */
const noticesWithSecrets = query.query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("notices", { with: { secrets: true } }));

const harnesses = trackHarnesses();

const seeded = async (): Promise<ReturnType<typeof lunoraTest>> => {
    const t = lunoraTest(schema);

    harnesses.track(t);

    await t.run(async (ctx) => {
        const database = ctx.db as unknown as {
            insert: (table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;
        };

        await database.insert("posts", { _id: "p1", title: "t" }, { allowExplicitId: true });
        await database.insert("notices", { _id: "n1", text: "n" }, { allowExplicitId: true });
        await database.insert("audit", { _id: "a1", note: "a", postId: "p1" }, { allowExplicitId: true });
        await database.insert("secrets", { auditId: "a1", body: "s", noticeId: "n1", postId: "p1" });
    });

    return t;
};

describe("lunoraTest — relation reads of a protected table without a read policy", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("refuses a with-load of the protected child", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ secrets: true }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses a _count of the protected child", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ _count: { secrets: true } }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses the protected table one level down a nested with", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ audit: { with: { secrets: true } } }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses the protected child of a .public() parent read without rls()", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(noticesWithSecrets, {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("still loads a .public() child", async () => {
        expect.assertions(1);

        const t = await seeded();
        const { page } = await t.query(postsWith({ audit: true }), {});

        expect(page.map((post) => (post["audit"] as Record<string, unknown>[]).map((row) => row["_id"]))).toStrictEqual([["a1"]]);
    });
});
