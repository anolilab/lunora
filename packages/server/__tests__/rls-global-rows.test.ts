/**
 * A `.global()` row addressed by id must still be located, read-filtered and
 * write-gated by `rls()`.
 *
 * `@lunora/shard-engine`'s `lookupById` is the one-round-trip seam the RLS
 * middleware prefers over its `get` + per-table `findFirst` probe. That seam is
 * SHARD-LOCAL: a `.global()` row lives in D1, so its owning table is not
 * resolvable from the DO's index and every global id misses. `null` from it
 * therefore means "not resolvable here", not "no such row" — and the middleware
 * that read it as the latter classified every global row as "in no policy-gated
 * table", which made `get()` answer `null` and `patch`/`delete`/`deleteAll` skip
 * the write policy entirely.
 *
 * The fake writer below reproduces exactly that split: `lookupById` answers only
 * for shard-local rows, while `get`/`findFirst` (which reach the global backend
 * through the writer's own fallback) answer for both.
 */
import { describe, expect, it } from "vitest";

import type { Middleware, Policy } from "../src/index";
import { definePolicy, initLunora, rls } from "../src/index";

const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

interface SeedRow extends Record<string, unknown> {
    _id: string;
    global: boolean;
    table: string;
}

interface TestContext {
    auth: { userId: null | string };
    db: unknown;
}

/**
 * Writer whose `lookupById` resolves shard-local rows only — the shape
 * `createShardCtxDb` really has. `deleted` records the ids the writer was asked
 * to erase so a test can prove a denied delete never reached it.
 */
const createSplitWriter = (seed: ReadonlyArray<SeedRow>) => {
    const rows = new Map(seed.map((row) => [row._id, { ...row }] as const));
    const deleted: string[] = [];
    const patched: string[] = [];

    const rowsOfTable = (tableName: string): SeedRow[] => [...rows.values()].filter((row) => row.table === tableName);

    const writer = {
        async aggregate(tableName: string) {
            return rowsOfTable(tableName).length;
        },

        async count(tableName: string) {
            return rowsOfTable(tableName).length;
        },

        async delete(id: string) {
            deleted.push(id);
            rows.delete(id);
        },

        async deleteAll() {
            return { deleted: 0 };
        },

        async deleteMany(ids: ReadonlyArray<string>) {
            return { deleted: ids.length };
        },
        async findFirst(tableName: string, args?: { where?: { _id?: string } }) {
            const page = await writer.findMany(tableName, args);

            return page.page[0] ?? null;
        },

        async findMany(tableName: string, args?: { baseWhere?: Record<string, unknown>; where?: { _id?: string } }) {
            let page = rowsOfTable(tableName);
            const wantedId = args?.where?._id;

            if (typeof wantedId === "string") {
                page = page.filter((row) => row._id === wantedId);
            }

            // Only the one predicate shape these tests build is honoured.
            const owner = args?.baseWhere?.["userId"];

            if (typeof owner === "string") {
                page = page.filter((row) => row["userId"] === owner);
            }

            return { continueCursor: null, isDone: true, page };
        },
        // `get` reaches BOTH backends — the writer falls back to the global one.

        async get(id: string) {
            return rows.get(id) ?? null;
        },

        async groupBy() {
            return [];
        },

        async insert(_tableName: string, document: Record<string, unknown>) {
            return (document["_id"] as string | undefined) ?? "new-id";
        },

        async insertMany() {
            return [];
        },

        async insertManyUnsafe() {
            return [];
        },
        // SHARD-LOCAL ONLY: a global row misses, exactly like the real seam.

        async lookupById(id: string) {
            const row = rows.get(id);

            return row && !row.global ? { row, tableName: row.table } : null;
        },

        async patch(id: string, patch: Record<string, unknown>) {
            patched.push(id);

            const row = rows.get(id);

            if (row) {
                rows.set(id, { ...row, ...patch });
            }
        },

        async patchMany() {
            return { patched: 0 };
        },
        query() {
            throw new Error("query() not used in these tests");
        },

        async rank() {
            return null;
        },

        async rankPage() {
            return { continueCursor: null, isDone: true, page: [] };
        },

        async replace() {
            // no-op
        },
    };

    return { deleted, patched, rows, writer };
};

const lunora = initLunora.dataModel<Record<string, never>>().create();

const makeContext = (writer: unknown, userId: null | string): TestContext => {
    return { auth: { userId }, db: writer };
};

/** `read` allows everything, `update`/`delete` deny everything — so any write that lands is a bypass. */
const readOnlyPolicies: ReadonlyArray<Policy<TestContext>> = [
    definePolicy<TestContext>({ on: "read", table: "profiles", when: () => true }),
    definePolicy<TestContext>({ on: "delete", table: "profiles", when: () => false }),
    definePolicy<TestContext>({ on: "update", table: "profiles", when: () => false }),
];

const seed: ReadonlyArray<SeedRow> = [
    { _creationTime: 1, _id: "p1", global: true, table: "profiles", userId: "victim" },
    { _creationTime: 1, _id: "p2", global: true, table: "profiles", userId: "victim2" },
];

describe("rls — .global() rows addressed by id", () => {
    it("get() returns a global row the read policy admits (it is not 'absent')", async () => {
        expect.assertions(1);

        const database = createSplitWriter(seed);
        const handler = lunora.query.use(rlsForTest<TestContext>(readOnlyPolicies)).query(async ({ ctx }) => (ctx as TestContext & { db: any }).db.get("p1"));

        await expect(handler.handler(makeContext(database.writer, "attacker"), {})).resolves.toMatchObject({ _id: "p1", userId: "victim" });
    });

    it("patch() on a global row runs the update policy and is denied", async () => {
        expect.assertions(2);

        const database = createSplitWriter(seed);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(readOnlyPolicies))
            .mutation(async ({ ctx }) => (ctx as TestContext & { db: any }).db.patch("p1", { userId: "attacker" }));

        await expect(handler.handler(makeContext(database.writer, "attacker"), {})).rejects.toThrow(/denied by policy/u);

        expect(database.patched).toStrictEqual([]);
    });

    it("delete() on a global row runs the delete policy and is denied", async () => {
        expect.assertions(2);

        const database = createSplitWriter(seed);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(readOnlyPolicies))
            .mutation(async ({ ctx }) => (ctx as TestContext & { db: any }).db.delete("p1"));

        await expect(handler.handler(makeContext(database.writer, "attacker"), {})).rejects.toThrow(/denied by policy/u);

        expect(database.deleted).toStrictEqual([]);
    });

    it("deleteAll() over a global table gates every row and erases none when the policy denies", async () => {
        expect.assertions(2);

        const database = createSplitWriter(seed);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(readOnlyPolicies))
            .mutation(async ({ ctx }) => (ctx as TestContext & { db: any }).db.deleteAll("profiles"));

        await expect(handler.handler(makeContext(database.writer, "attacker"), {})).rejects.toThrow(/denied by policy/u);

        expect(database.rows.size).toBe(2);
    });

    it("a global row the read policy hides is not returned by get()", async () => {
        expect.assertions(1);

        const scoped: ReadonlyArray<Policy<TestContext>> = [
            definePolicy<TestContext>({
                on: "read",
                table: "profiles",
                when: ({ auth }) => {
                    return { userId: auth.userId };
                },
            }),
        ];
        const database = createSplitWriter(seed);
        const handler = lunora.query.use(rlsForTest<TestContext>(scoped)).query(async ({ ctx }) => (ctx as TestContext & { db: any }).db.get("p1"));

        await expect(handler.handler(makeContext(database.writer, "attacker"), {})).resolves.toBeNull();
    });

    it("still resolves a shard-local row through the one-round-trip seam (no probe fan-out)", async () => {
        expect.assertions(2);

        const database = createSplitWriter([{ _creationTime: 1, _id: "s1", global: false, table: "profiles", userId: "victim" }]);
        const probes: string[] = [];
        const spied = {
            ...database.writer,
            findFirst: async (tableName: string, args?: { where?: { _id?: string } }) => {
                probes.push(tableName);

                return database.writer.findFirst(tableName, args);
            },
        };
        const handler = lunora.query.use(rlsForTest<TestContext>(readOnlyPolicies)).query(async ({ ctx }) => (ctx as TestContext & { db: any }).db.get("s1"));

        await expect(handler.handler(makeContext(spied, "attacker"), {})).resolves.toMatchObject({ _id: "s1" });

        expect(probes).toStrictEqual([]);
    });
});
