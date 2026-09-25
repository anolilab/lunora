/**
 * A read policy whose `OR` holds an `allowAll()` branch admits every row.
 *
 * `allowAll()` is `{}`, the documented spelling of "no filter for this branch",
 * so `{ OR: [isAdmin ? allowAll() : { userId }, { status: "shared" }] }` shows
 * an admin everything. The SQL compiler used to drop the empty branch, leaving
 * `status = 'shared'`, so every read that pushes the policy into SQL (`findMany`
 * and the shard reader) showed the admin the shared rows only.
 */
import type { Middleware, Policy } from "@lunora/server";
import { allowAll, definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { query } = initLunora.dataModel().create();

const schema = defineSchema({
    notes: defineTable({ status: v.string(), userId: v.string() }).index("by_status", ["status"]),
});

/** Same permissive cast `rls-enforcement.test.ts` pins: the raw builder types `ctx.db` nominally. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const policies = definePolicies([
    definePolicy({
        on: "read",
        table: "notes",
        when: ({ auth }) => {
            return { OR: [auth.userId === "admin" ? allowAll() : { userId: auth.userId }, { status: "shared" }] };
        },
    }),
]);

type Doc = Record<string, unknown> & { _id: string };

const reads = query
    .use(rlsForTest(policies))
    .input({})
    .query(async ({ ctx }) => {
        return {
            findMany: ((await ctx.db.findMany("notes", {})) as { page: Doc[] }).page,
            readerCollect: (await ctx.db
                .query("notes")
                .withIndex("by_status", (q: any) => q.eq("status", "private"))
                .collect()) as Doc[],
            readerTake: (await ctx.db.query("notes").take(100)) as Doc[],
        };
    });

const open: ReturnType<typeof lunoraTest>[] = [];

describe("an rls read policy with an allowAll() branch", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("admits every row on findMany and on the shard reader", async () => {
        expect.assertions(4);

        const t = lunoraTest(schema);

        open.push(t);

        await t.run(async (ctx) => {
            await ctx.db.insertMany(
                "notes",
                Array.from({ length: 12 }, (_, index) => {
                    return { status: index % 3 === 0 ? "shared" : "private", userId: `u${String(index % 4)}` };
                }),
            );
        });

        const result = await t.withIdentity({ userId: "admin" }).query(reads, {});

        expect(result.findMany).toHaveLength(12);
        expect(result.readerTake).toHaveLength(12);
        expect(result.readerCollect).toHaveLength(8);

        // Everyone else still sees their own rows plus the shared ones.
        const other = (await t.withIdentity({ userId: "u1" }).query(reads, {})) as { findMany: Doc[] };

        expect(other.findMany.every((document) => document["userId"] === "u1" || document["status"] === "shared")).toBe(true);
    });
});
