/**
 * Regression tests for plan 215: `lunoraTest` enforces the secure-by-default
 * RLS guard the same way production's generated `buildCtx` does
 * (`enforceRls: true`), so a passing suite means the deploy is RLS-safe.
 *
 * Schema is `.rls("required")` with one protected table (`notes`, no
 * `.public()`). `listUnguarded` never engages RLS — dispatching it must fail
 * exactly as it would in production. `listGuarded` carries a permissive read
 * policy via `.use(rls(...))` — dispatching it must succeed. `t.run` is the
 * harness's trusted escape hatch and must stay unguarded regardless.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import type { LunoraTestOptions } from "../src/index";
import { lunoraTest } from "../src/index";

const { mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    memos: defineTable({
        body: v.string(),
        visibility: v.string(),
    }),
    notes: defineTable({
        body: v.string(),
    }),
}).rls("required");

// No `.use(rls(...))` in the chain — the guard must deny this against the
// protected `notes` table.
const listUnguarded = query.query(async ({ ctx }) => ctx.db.query("notes").collect());
const insertUnguarded = mutation.input({ body: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("notes", { body: args.body }));

/**
 * The raw `initLunora` builder types `ctx.db` nominally (`DatabaseReader` /
 * `DatabaseWriter`); the RLS middleware's structural `DatabaseWriterLike`
 * shape is a superset, so TS rejects the direct `.use(rls(...))` composition
 * outside of codegen's generated, per-project facade types. `@lunora/server`'s
 * own RLS tests (`__tests__/rls.test.ts`, `rls-secure-by-default.test.ts`) pin
 * a permissive cast once for exactly this reason — mirrored here rather than
 * scattering `as unknown as Middleware<…>` at every call site.
 */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const readNotes = definePolicy({
    on: "read",
    table: "notes",
    when: () => true,
});

/**
 * RESTRICTIVE read policy — unlike `readNotes` it returns a `WhereInput`, so
 * the middleware computes a `baseWhere` and the legacy `query()` wrapper takes
 * its filtering branch instead of the `if (!baseWhere) return reader`
 * short-circuit.
 */
const readPublicMemos = definePolicy({
    on: "read",
    table: "memos",
    when: () => {
        return { visibility: "public" };
    },
});

// Carries a permissive read policy — the middleware recovers the unwrapped
// writer via the RLS_UNWRAP_SYMBOL seam, so this reaches `notes` even though
// the table is protected.
const listGuarded = query.use(rlsForTest(definePolicies([readNotes]))).query(async ({ ctx }) => ctx.db.query("notes").collect());

/**
 * The legacy iterator-style reader (`ctx.db.query(table)`) can't push a policy
 * `baseWhere` into SQL, so RLS for this read path is enforced ENTIRELY by the
 * in-memory `.filter(matchesWhere)` in `rls/middleware.ts`'s `query()`. These
 * handlers read a table that HOLDS rows the policy hides, so a reader that
 * forwards unfiltered is observable.
 */
const listMemos = query.use(rlsForTest(definePolicies([readPublicMemos]))).query(async ({ ctx }) => ctx.db.query("memos").collect());
const firstMemo = query.use(rlsForTest(definePolicies([readPublicMemos]))).query(async ({ ctx }) => ctx.db.query("memos").first());
const takeMemos = query.use(rlsForTest(definePolicies([readPublicMemos]))).query(async ({ ctx }) => ctx.db.query("memos").take(10));

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (options?: LunoraTestOptions): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, options);

    open.push(t);

    return t;
};

describe("lunoraTest — RLS enforcement", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("rejects a query dispatched against a protected table by a procedure that never engaged RLS", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.query(listUnguarded, {})).rejects.toMatchObject({ code: "RLS_REQUIRED", name: "RlsRequiredError" });
    });

    it("rejects a mutation dispatched against a protected table by a procedure that never engaged RLS", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.mutation(insertUnguarded, { body: "hi" })).rejects.toMatchObject({ code: "RLS_REQUIRED", name: "RlsRequiredError" });
    });

    it("allows dispatch of a procedure that carries a permissive read policy", async () => {
        expect.assertions(1);

        const t = start();

        await expect(t.query(listGuarded, {})).resolves.toEqual([]);
    });

    it("t.run reaches the protected table without engaging RLS (trusted escape hatch)", async () => {
        expect.assertions(2);

        const t = start();

        const id = await t.run(async (ctx) => ctx.db.insert("notes", { body: "seeded" }));

        expect(typeof id).toBe("string");

        const rows = await t.run(async (ctx) => ctx.db.query("notes").collect());

        expect(rows).toHaveLength(1);
    });

    it("the legacy query() reader drops rows a restrictive read policy hides", async () => {
        expect.assertions(3);

        const t = start();

        await t.run(async (ctx) => {
            await ctx.db.insert("memos", { body: "open", visibility: "public" });
            await ctx.db.insert("memos", { body: "secret", visibility: "private" });
        });

        const rows = (await t.query(listMemos, {})) as { body: string; visibility: string }[];

        expect(rows).toHaveLength(1);
        expect(rows[0]?.body).toBe("open");
        expect(rows.some((row) => row.visibility === "private")).toBe(false);
    });

    it("the legacy query() reader's first()/take() terminals are filtered too", async () => {
        expect.assertions(2);

        const t = start();

        // EVERY seeded row is hidden by the policy, so the terminals must come
        // back empty. Asserting emptiness rather than "the visible row wins"
        // keeps the oracle independent of the reader's (uuid-keyed, not
        // insertion-ordered) row order.
        await t.run(async (ctx) => {
            await ctx.db.insert("memos", { body: "secret", visibility: "private" });
            await ctx.db.insert("memos", { body: "classified", visibility: "private" });
        });

        await expect(t.query(firstMemo, {})).resolves.toBeNull();
        await expect(t.query(takeMemos, {})).resolves.toEqual([]);
    });

    it("enforceRls: false restores the pre-guard permissive behavior", async () => {
        expect.assertions(1);

        const t = start({ enforceRls: false });

        await expect(t.query(listUnguarded, {})).resolves.toEqual([]);
    });
});
