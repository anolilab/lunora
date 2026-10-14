/**
 * `lunoraTest` must accept only what production can build, and meter what
 * production meters.
 *
 * Identity: `@lunora/runtime`'s `create-worker.ts` drops an identity without a
 * non-empty `userId` to anonymous and strips `userId` out of the forwarded claims,
 * so `withIdentity({ roles: [...] })` with no subject must NOT reach a policy with
 * its roles intact.
 *
 * Headroom: the generated `buildCtx` always passes a `TransactionHeadroomTracker`,
 * so an unbounded write loop must fail with `TRANSACTION_LIMIT_EXCEEDED` here too —
 * per dispatch, not per harness.
 *
 * `auth`: `buildCtx` passes the dispatching identity, so a
 * `.serverDefault(({ auth }) => …)` column stamps the caller, not `null`.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { DEFAULT_TRANSACTION_LIMITS } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    notes: defineTable({
        body: v.string(),
    }),
    owned: defineTable({
        ownerId: v.string().serverDefault(({ auth }) => auth.userId ?? "ANON"),
        title: v.string(),
    }),
}).rls("required");

/** Same permissive cast `rls-enforcement.test.ts` pins: the raw builder types `ctx.db` nominally. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>, options: { roles?: unknown }): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>, o: unknown) => Middleware<any, any>)(policies, options);

const readNotes = definePolicy({
    on: "read",
    table: "notes",
    when: ({ auth }) => auth.can("notes:read"),
});

const insertOwned = definePolicy({ on: "insert", table: "owned", when: () => true });
const readOwned = definePolicy({ on: "read", table: "owned", when: () => true });

const roles = [{ name: "admin", permissions: [{ name: "notes:read" }] }];

const listNotes = query.use(rlsForTest(definePolicies([readNotes]), { roles })).query(async ({ ctx }) => ctx.db.query("notes").collect());

const addOwned = mutation
    .use(rlsForTest(definePolicies([insertOwned, readOwned]), { roles }))
    .input({ title: v.string() })
    .mutation(async ({ args, ctx }) => {
        const id = await ctx.db.insert("owned", { title: args.title });

        return ctx.db.get(id);
    });

describe("lunoraTest identity normalisation", () => {
    it("treats a roles-only identity with no userId as anonymous", async () => {
        expect.assertions(2);

        const t = lunoraTest(schema, { functions: {} });

        await t.run(async (ctx) => {
            await ctx.db.insert("notes", { body: "secret" });
        });

        // An admin WITH a subject is what production can actually forward.
        await expect(t.withIdentity({ roles: ["admin"], userId: "u1" }).query(listNotes, {})).resolves.toHaveLength(1);
        // No subject — production would have dropped the whole identity.
        await expect(t.withIdentity({ roles: ["admin"] }).query(listNotes, {})).resolves.toStrictEqual([]);

        t.close();
    });

    it("keeps userId out of the claims getIdentity() returns", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema, { functions: {} });
        const identity = await t.withIdentity({ email: "a@b.c", userId: "u1" }).query(async (ctx) => ctx.auth.getIdentity());

        expect(identity).toStrictEqual({ email: "a@b.c" });

        t.close();
    });
});

describe("lunoraTest transaction headroom", () => {
    it("stops a mutation that writes past the engine's row ceiling", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema, { enforceRls: false, functions: {} });
        const over = DEFAULT_TRANSACTION_LIMITS.maxWrittenRows + 1;

        await expect(
            t.mutation(async (ctx) => {
                for (let index = 0; index < over; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- the point is a single unbounded write loop
                    await ctx.db.insert("notes", { body: "x" });
                }
            }),
        ).rejects.toThrow(/TRANSACTION_LIMIT_EXCEEDED|over the .*-document limit/u);

        t.close();
    }, 120_000);

    it("gives each dispatch its own budget", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema, { enforceRls: false, functions: {} });
        const half = Math.ceil(DEFAULT_TRANSACTION_LIMITS.maxWrittenRows * 0.6);

        const writeHalf = async (): Promise<void> => {
            await t.mutation(async (ctx) => {
                for (let index = 0; index < half; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- deliberate sequential write loop
                    await ctx.db.insert("notes", { body: "x" });
                }
            });
        };

        await writeHalf();

        // 2 x 60% of the ceiling: over the cap cumulatively, under it per dispatch.
        await expect(writeHalf()).resolves.toBeUndefined();

        t.close();
    }, 240_000);
});

describe("lunoraTest serverDefault auth", () => {
    it("stamps a .serverDefault column from the dispatching identity", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema, { functions: {} });
        const row = await t.withIdentity({ userId: "u1" }).mutation(addOwned, { title: "hi" });

        expect(row?.ownerId).toBe("u1");

        t.close();
    });
});
