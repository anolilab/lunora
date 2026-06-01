import { bench, describe } from "vitest";

import type { Middleware, Policy } from "../src/index.js";
import { definePolicy, initCirrus, rls } from "../src/index.js";

/**
 * What does `.use(rls(policies))` cost per query call? The middleware
 * computes the effective `baseWhere` once per request, wraps `ctx.db`, and
 * leaves writes / reads gated. The wrap itself runs even when no policy
 * matches the read; the AND-merge runs when one returns a `WhereInput`.
 *
 *  - **baseline** — same query handler, no RLS in the chain. The dispatch
 *    floor.
 *  - **rls(true)** — policy returns `true`; wrapper installs but no
 *    `baseWhere` is merged.
 *  - **rls(predicate)** — policy returns a `WhereInput`; full AND-merge
 *    happens per read.
 *
 * Each bench invokes the registered handler with a fresh ctx — that's
 * exactly what a per-request dispatch does in production.
 */

interface FakeCall {
    args: unknown;
    method: string;
    tableOrId?: string;
}

interface FakeDb {
    calls: FakeCall[];
    writer: {
        count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
        delete: (id: string) => Promise<void>;
        findFirst: (tableName: string, args?: unknown) => Promise<Record<string, unknown> | null>;
        findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Array<Record<string, unknown>> }>;
        get: (id: string) => Promise<Record<string, unknown> | null>;
        insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
        query: (tableName: string) => never;
        replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    };
}

const createFakeDb = (): FakeDb => {
    const calls: FakeCall[] = [];

    return {
        calls,
        writer: {
            async count(tableName, whereOrArgs) {
                calls.push({ args: whereOrArgs, method: "count", tableOrId: tableName });

                return 0;
            },

            async delete(id) {
                calls.push({ args: undefined, method: "delete", tableOrId: id });
            },

            async findFirst(tableName, args) {
                calls.push({ args, method: "findFirst", tableOrId: tableName });

                return null;
            },

            async findFirstOrThrow(tableName) {
                throw new Error(`not found: ${tableName}`);
            },

            async findMany(tableName, args) {
                calls.push({ args, method: "findMany", tableOrId: tableName });

                return { continueCursor: null, isDone: true, page: [] };
            },

            async get() {
                return null;
            },

            async insert(tableName, document) {
                calls.push({ args: document, method: "insert", tableOrId: tableName });

                return "new-id";
            },

            async patch() {
                /* noop */
            },
            query() {
                throw new Error("query() not used in this bench");
            },

            async replace() {
                /* noop */
            },
        },
    };
};

const cirrus = initCirrus.dataModel<Record<string, never>>().create();

interface BenchCtx {
    auth: { roles?: ReadonlyArray<string>; userId: null | string };
    db: FakeDb["writer"];
}

const buildCtx = (): BenchCtx => {
    const db = createFakeDb();

    return { auth: { roles: [], userId: "user_42" }, db: db.writer };
};

// The procedure builder types `ctx.db` nominally; the RLS middleware signature
// is structural, so a permissive cast is needed in the bench harness to attach
// it without dragging the full DataModel typing in here. Same pattern the test
// harness uses (`rlsForTest`).
const rlsAsAny = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Ctx>>) => Middleware<any, any>)(policies);

const baselineHandler = cirrus.query.query(async ({ ctx }) => {
    // Two reads — most queries touch more than one table. The procedure
    // builder types `ctx.db` nominally as `DatabaseReader`; the structural
    // writer (which carries `findMany`/`findFirst`) is what the RLS-wrapped
    // variants see. Cast through `BenchCtx["db"]` here so the bench measures
    // the same surface in every variant.
    const reader = ctx.db as unknown as BenchCtx["db"];

    await reader.findMany("documents", { where: { ownerId: "user_42" } });
    await reader.findFirst("users", { where: { _id: "user_42" } });

    return null;
});

const policyTrue = definePolicy<BenchCtx>({
    on: "read",
    table: "documents",
    when: () => true,
});

const policyPredicate = definePolicy<BenchCtx>({
    on: "read",
    table: "documents",
    when: ({ auth }) => ({ ownerId: auth.userId }),
});

const rlsTrueHandler = cirrus.query.use(rlsAsAny<BenchCtx>([policyTrue])).query(async ({ ctx }) => {
    await ctx.db.findMany("documents", { where: { ownerId: "user_42" } });
    await ctx.db.findFirst("users", { where: { _id: "user_42" } });

    return null;
});

const rlsPredicateHandler = cirrus.query.use(rlsAsAny<BenchCtx>([policyPredicate])).query(async ({ ctx }) => {
    await ctx.db.findMany("documents", { where: { ownerId: "user_42" } });
    await ctx.db.findFirst("users", { where: { _id: "user_42" } });

    return null;
});

describe("rls() middleware — per-query overhead", () => {
    bench("baseline: no RLS in the chain", async () => {
        await baselineHandler.handler(buildCtx() as never, {});
    });

    bench("rls(true): wrapper installs, no baseWhere merged", async () => {
        await rlsTrueHandler.handler(buildCtx() as never, {});
    });

    bench("rls(predicate): full WhereInput AND-merge per read", async () => {
        await rlsPredicateHandler.handler(buildCtx() as never, {});
    });
});
