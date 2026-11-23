/**
 * `.use(rls(a)).use(mask(...)).use(rls(b))`: the mask republishes `ctx.db` by spread, so the later
 * `rls()` step wraps the mask instead of resuming the earlier step's chain. A relation read routed
 * by the earlier step must still apply the later step's read policy for the child, keep the
 * mask's redaction on the child's rows, and refuse a protected child that no step policies. Before,
 * the earlier step replaced the later step's filter with its own and served the child unpoliced.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, mask, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { query } = initLunora.dataModel().create();

/** See `rls-enforcement.test.ts`: the raw builder types `ctx.db` nominally, so the middleware is cast once here. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const schema = defineSchema({
    notes: defineTable({ body: v.string(), postId: v.string() }),
    posts: defineTable({ title: v.string() }).relations((r) => {
        return {
            notes: r.many("notes", { field: "postId" }),
            secrets: r.many("secrets", { field: "postId" }),
        };
    }),
    secrets: defineTable({ body: v.string(), label: v.string(), postId: v.string() }),
}).rls("required");

const readPosts = definePolicy({ on: "read", table: "posts", when: () => true });

/** Restrictive: only the `visible` secret may be read. */
const readVisibleSecrets = definePolicy({
    on: "read",
    table: "secrets",
    when: () => {
        return { label: "visible" };
    },
});

type FindMany = (table: string, args: Record<string, unknown>) => Promise<{ page: Record<string, unknown>[] }>;

const maskSecretBody = mask({ secrets: { body: "redact" } }) as unknown as Middleware<any, any>;

/** `rls(first)` → `mask()` → `rls(second)`, reading posts with `withInput`. */
const postsAcrossMask = (first: ReadonlyArray<Policy>, second: ReadonlyArray<Policy>, withInput: Record<string, unknown>) =>
    query
        .use(rlsForTest(definePolicies([...first])))
        .use(maskSecretBody)
        .use(rlsForTest(definePolicies([...second])))
        .query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("posts", { with: withInput }));

const harnesses = trackHarnesses();

const seeded = async (): Promise<ReturnType<typeof lunoraTest>> => {
    const t = lunoraTest(schema);

    harnesses.track(t);

    await t.run(async (ctx) => {
        const database = ctx.db as unknown as {
            insert: (table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;
        };

        await database.insert("posts", { _id: "p1", title: "t" }, { allowExplicitId: true });
        await database.insert("secrets", { body: "visible-body", label: "visible", postId: "p1" });
        await database.insert("secrets", { body: "hidden-body", label: "hidden", postId: "p1" });
        await database.insert("notes", { body: "n", postId: "p1" });
    });

    return t;
};

const secretsOf = (page: Record<string, unknown>[]): Record<string, unknown>[] => (page[0]?.["secrets"] ?? []) as Record<string, unknown>[];

describe("lunoraTest — rls() steps on both sides of a mask()", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("applies the later step's read policy to a child the earlier step routes, with the mask kept", async () => {
        expect.assertions(2);

        const t = await seeded();
        const { page } = await t.query(postsAcrossMask([readPosts], [readVisibleSecrets], { secrets: true }), {});

        expect(secretsOf(page).map((row) => row["label"])).toStrictEqual(["visible"]);
        expect(secretsOf(page).map((row) => row["body"])).not.toContain("visible-body");
    });

    it("applies a child policy the earlier step declares, with the mask kept", async () => {
        expect.assertions(2);

        const t = await seeded();
        const { page } = await t.query(postsAcrossMask([readPosts, readVisibleSecrets], [readPosts], { secrets: true }), {});

        expect(secretsOf(page).map((row) => row["label"])).toStrictEqual(["visible"]);
        expect(secretsOf(page).map((row) => row["body"])).not.toContain("visible-body");
    });

    it("still refuses a direct read of a table only the later step has a read policy for", async () => {
        expect.assertions(1);

        const t = await seeded();
        const direct = query
            .use(rlsForTest(definePolicies([readPosts])))
            .use(maskSecretBody)
            .use(rlsForTest(definePolicies([readVisibleSecrets])))
            .query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("secrets", {}));

        await expect(t.query(direct, {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("does not take a caller's own relation filter for a step's", async () => {
        expect.assertions(1);

        const t = await seeded();
        const forged = query.use(rlsForTest(definePolicies([readPosts]))).query(async ({ ctx }) =>
            (ctx.db as unknown as { findMany: FindMany }).findMany("posts", {
                relationBaseWhere: () => {
                    return {};
                },
                with: { notes: true },
            }),
        );

        await expect(t.query(forged, {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "notes" });
    });

    it("refuses a protected child no step has a read policy for", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsAcrossMask([readPosts], [readVisibleSecrets], { notes: true }), {})).rejects.toMatchObject({
            code: "RLS_REQUIRED",
            table: "notes",
        });
    });
});
