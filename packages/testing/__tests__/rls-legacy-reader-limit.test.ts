/**
 * Issue #822: behind `rls()`, a read policy that returns a `where` used to wrap
 * the legacy `ctx.db.query(t)` reader in an in-memory `.filter()`, so `take(n)`
 * / `first()` / `paginate({ numItems })` dropped their SQL `LIMIT` and read the
 * whole index range. These tests pin both halves of the fix:
 *
 * - **cost** — rows read, counted as the rows SQLite hands back for statements
 * against the table (a `DatabaseSync#prepare` spy; the harness runs every
 * table on one in-memory `node:sqlite` database);
 * - **the security boundary** — every terminal still returns exactly the rows
 * the policy admits, including when the policy hides rows INSIDE the scanned
 * range, across paginate cursor boundaries, and for a policy shape that cannot
 * be pushed into SQL (a `NOT`) and takes the batched in-memory fallback.
 */
import { StatementSync } from "node:sqlite";

import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";

const { query } = initLunora.dataModel().create();

const schema = defineSchema({
    notes: defineTable({
        body: v.string(),
        hidden: v.boolean(),
        location: v.geoPoint(),
        status: v.string(),
        userId: v.string(),
    })
        .index("by_user_and_status", ["userId", "status"])
        .index("by_status", ["status"])
        .searchIndex("by_body", { field: "body" })
        .geoIndex("by_location", { field: "location" }),
});

/** Same permissive cast `rls-enforcement.test.ts` pins: the raw builder types `ctx.db` nominally. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

/** Pushable: a flat equality, compiled into the reader's SQL. */
const ownRows = definePolicies([
    definePolicy({
        on: "read",
        table: "notes",
        when: ({ auth }) => {
            return { userId: auth.userId };
        },
    }),
]);

/** Not pushable (`NOT`): filtered in memory, served from LIMIT-ed batches. */
const ownVisibleRows = definePolicies([
    definePolicy({
        on: "read",
        table: "notes",
        when: ({ auth }) => {
            return { NOT: { hidden: true }, userId: auth.userId };
        },
    }),
]);

type Doc = Record<string, unknown> & { _id: string; hidden: boolean; status: string; userId: string };

interface ReadArgs {
    cursor?: null | string;
    index: "by_status" | "by_user_and_status";
    numItems?: number;
    op: "collect" | "first" | "paginate" | "take" | "unique";
    order?: "asc" | "desc";
    value: string;
}

const readArgs = {
    cursor: v.optional(v.union(v.string(), v.null())),
    index: v.string(),
    numItems: v.optional(v.number()),
    op: v.string(),
    order: v.optional(v.string()),
    value: v.string(),
};

const reader = (policies: ReturnType<typeof definePolicies>) =>
    query
        .use(rlsForTest(policies))
        .input(readArgs)
        .query(async ({ args, ctx }) => {
            const { cursor, index, numItems, op, order, value } = args as unknown as ReadArgs;
            const field = index === "by_status" ? "status" : "userId";
            const base = ctx.db.query("notes").withIndex(index, (q: any) => q.eq(field, value));
            const staged = order === "desc" ? base.order("desc") : base;

            switch (op) {
                case "collect": {
                    return staged.collect();
                }
                case "first": {
                    return staged.first();
                }
                case "paginate": {
                    return staged.paginate({ cursor: cursor ?? null, numItems: numItems ?? 5 });
                }
                case "take": {
                    return staged.take(numItems ?? 5);
                }
                default: {
                    return staged.unique();
                }
            }
        });

const ownReader = reader(ownRows);
const ownVisibleReader = reader(ownVisibleRows);

const ownSearch = query
    .use(rlsForTest(ownRows))
    .input({})
    .query(async ({ ctx }) =>
        ctx.db
            .query("notes")
            .withSearchIndex("by_body", (q: any) => q.search("body", "shared"))
            .take(5),
    );

const ownNear = query
    .use(rlsForTest(ownRows))
    .input({})
    .query(async ({ ctx }) =>
        ctx.db
            .query("notes")
            .withGeoIndex("by_location", (q: any) => q.near({ lat: 52.52, lng: 13.405 }, 5000))
            .take(50),
    );

/**
 * Rows SQLite returns for statements reading `notes` while `run` is in flight.
 * Every harness statement goes through `StatementSync#all`, so a pass-through
 * spy sees each one; the tally is taken before the spy is restored, which would
 * clear it.
 */
const rowsRead = async <T>(
    run: () => Promise<T>,
    reads: (sql: string) => boolean = (sql) => sql.includes(`FROM "notes"`),
): Promise<{ result: T; rows: number }> => {
    const spy = vi.spyOn(StatementSync.prototype, "all");

    try {
        const result = await run();
        const rows = spy.mock.contexts
            .map((context, call) => {
                const { sourceSQL } = context as StatementSync;
                const returned = spy.mock.results[call]?.value as unknown[] | undefined;

                return /^\s*SELECT/iu.test(sourceSQL) && reads(sourceSQL) ? (returned?.length ?? 0) : 0;
            })
            .reduce((sum, count) => sum + count, 0);

        return { result, rows };
    } finally {
        spy.mockRestore();
    }
};

const open: ReturnType<typeof lunoraTest>[] = [];

/**
 * 500 `active` rows for u1 (every 7th hidden), then 200 `shared` rows
 * alternating u1/u2 — so the `by_status` range holds rows the policy hides
 * between the ones it admits.
 */
const seed = async (): Promise<ReturnType<typeof lunoraTest>> => {
    const t = lunoraTest(schema);

    open.push(t);

    const location = { lat: 52.52, lng: 13.405 };

    await t.run(async (ctx) => {
        await ctx.db.insertMany(
            "notes",
            Array.from({ length: 500 }, (_, index) => {
                return { body: `n${String(index)}`, hidden: index % 7 === 0, location, status: "active", userId: "u1" };
            }),
        );
        await ctx.db.insertMany(
            "notes",
            Array.from({ length: 200 }, (_, index) => {
                return { body: `shared ${String(index)}`, hidden: index % 5 === 0, location, status: "shared", userId: index % 2 === 0 ? "u1" : "u2" };
            }),
        );
    });

    return t;
};

/** Ground truth, read unguarded through the trusted escape hatch. */
const expected = async (t: ReturnType<typeof lunoraTest>, keep: (document: Doc) => boolean, status: string): Promise<string[]> => {
    const all = (await t.run(async (ctx) =>
        ctx.db
            .query("notes")
            .withIndex("by_status", (q: any) => q.eq("status", status))
            .collect(),
    )) as Doc[];

    return all.filter((document) => keep(document)).map((document) => document._id);
};

type PageRun = (cursor: null | string) => Promise<{ continueCursor: null | string; isDone: boolean; page: Doc[] }>;

/** Walk every page from `cursor` on, returning the ids in order. */
const walk = async (run: PageRun, cursor: null | string = null, depth = 0): Promise<string[]> => {
    const page = await run(cursor);
    const ids = page.page.map((document) => document._id);

    return page.isDone || page.continueCursor === null || depth > 100 ? ids : [...ids, ...(await walk(run, page.continueCursor, depth + 1))];
};

/** Every bounded and unbounded terminal over the `shared` range returns exactly `truth`. */
const expectTerminals = async (u1: ReturnType<ReturnType<typeof lunoraTest>["withIdentity"]>, handler: typeof ownReader, truth: string[]): Promise<void> => {
    const shared = { index: "by_status", value: "shared" } as const;
    const take = (await u1.query(handler, { ...shared, numItems: 7, op: "take" })) as Doc[];
    const collect = (await u1.query(handler, { ...shared, op: "collect" })) as Doc[];
    const first = (await u1.query(handler, { ...shared, op: "first" })) as Doc | null;
    const last = (await u1.query(handler, { ...shared, numItems: 3, op: "take", order: "desc" })) as Doc[];

    // A full LIMIT of admitted rows, never fewer, never a hidden one.
    expect(take.map((document) => document._id)).toStrictEqual(truth.slice(0, 7));
    expect(collect.map((document) => document._id)).toStrictEqual(truth);
    expect(first?._id).toBe(truth[0]);
    expect(last.map((document) => document._id)).toStrictEqual(truth.slice(-3).toReversed());

    // Across cursor boundaries: every admitted row exactly once, in order.
    const paged = await walk(async (cursor) => u1.query(handler, { ...shared, cursor, numItems: 7, op: "paginate" }) as never);

    expect(paged).toStrictEqual(truth);
};

describe("rls() legacy reader keeps its LIMIT (#822)", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("reads about n rows for a guarded take / paginate / first, like the unguarded read", async () => {
        expect.assertions(9);

        const t = await seed();
        const u1 = t.withIdentity({ userId: "u1" });
        const range = { index: "by_user_and_status", value: "u1" } as const;

        const unguarded = await rowsRead(async () =>
            t.run(async (ctx) =>
                ctx.db
                    .query("notes")
                    .withIndex("by_user_and_status", (q: any) => q.eq("userId", "u1"))
                    .take(5),
            ),
        );
        const take = await rowsRead(async () => u1.query(ownReader, { ...range, numItems: 5, op: "take" }));
        const page = await rowsRead(async () => u1.query(ownReader, { ...range, numItems: 5, op: "paginate" }));
        const first = await rowsRead(async () => u1.query(ownReader, { ...range, op: "first" }));

        expect(unguarded.rows).toBe(5);
        expect(take.result).toHaveLength(5);
        expect(take.rows).toBe(5);
        expect((page.result as { page: Doc[] }).page).toHaveLength(5);
        // One past the page, to learn `isDone` — what `findMany({ limit: 5 })` reads.
        expect(page.rows).toBe(6);
        expect(first.result).not.toBeNull();
        expect(first.rows).toBe(1);

        // Half of the `shared` range is u2's: the policy in SQL still reads just the LIMIT.
        const mixed = await rowsRead(async () => u1.query(ownReader, { index: "by_status", numItems: 7, op: "take", value: "shared" }));

        expect(mixed.rows).toBe(7);

        // The unpushable (`NOT`) policy is served from LIMIT-ed batches, not the range.
        const fallback = await rowsRead(async () => u1.query(ownVisibleReader, { ...range, numItems: 5, op: "take" }));

        expect(fallback.rows).toBeLessThan(50);
    });

    it("excludes rows the policy hides inside the range on every terminal", async () => {
        expect.assertions(12);

        const t = await seed();
        const u1 = t.withIdentity({ userId: "u1" });
        const shared = { index: "by_status", value: "shared" } as const;
        const own = await expected(t, (document) => document.userId === "u1", "shared");
        const ownVisible = await expected(t, (document) => document.userId === "u1" && !document.hidden, "shared");

        await expectTerminals(u1, ownReader, own);
        await expectTerminals(u1, ownVisibleReader, ownVisible);

        // A caller whose policy admits nothing in the range sees nothing.
        await expect(t.withIdentity({ userId: "u3" }).query(ownReader, { ...shared, op: "collect" })).resolves.toStrictEqual([]);
        await expect(t.withIdentity({ userId: "u3" }).query(ownVisibleReader, { ...shared, op: "first" })).resolves.toBeNull();
    });

    it("unique() sees only admitted rows", async () => {
        expect.assertions(2);

        const t = await seed();

        // u2's `shared` rows are hidden from u1, so a range holding exactly one
        // u2 row reads as empty rather than as that row.
        const u2Only = await t.run(async (ctx) =>
            ctx.db.insert("notes", { body: "solo", hidden: false, location: { lat: 0, lng: 0 }, status: "solo", userId: "u2" }),
        );

        await expect(t.withIdentity({ userId: "u1" }).query(ownReader, { index: "by_status", op: "unique", value: "solo" })).resolves.toBeNull();
        await expect(t.withIdentity({ userId: "u2" }).query(ownReader, { index: "by_status", op: "unique", value: "solo" })).resolves.toMatchObject({
            _id: u2Only,
        });
    });

    it("keeps the policy on the search and geo terminals", async () => {
        expect.assertions(4);

        const t = await seed();
        const u1 = t.withIdentity({ userId: "u1" });

        const hits = (await u1.query(ownSearch, {})) as Doc[];
        const near = (await u1.query(ownNear, {})) as Doc[];

        expect(hits).toHaveLength(5);
        expect(hits.every((document) => document.userId === "u1")).toBe(true);
        expect(near).toHaveLength(50);
        expect(near.every((document) => document.userId === "u1")).toBe(true);
    });

    it("keeps the search terminal's LIMIT behind a policy pushed into SQL", async () => {
        expect.assertions(2);

        const t = await seed();
        // The FTS5 statement joins the table as `"notes" m`; its companion tables are `"notes__…"`.
        const search = await rowsRead(
            async () => t.withIdentity({ userId: "u1" }).query(ownSearch, {}),
            (sql) => sql.includes(`"notes" m`),
        );

        expect(search.result).toHaveLength(5);
        expect(search.rows).toBe(5);
    });
});

const itemSchema = defineSchema({
    items: defineTable({
        code: v.string(),
        hidden: v.boolean(),
        level: v.bigint(),
        parentId: v.union(v.string(), v.null()),
        userId: v.string(),
    })
        .index("by_parent", ["parentId"])
        .index("by_user", ["userId"]),
});

/** A read policy on `items` from a fixed `where`. */
const itemPolicy = (where: Record<string, unknown>) =>
    definePolicies([
        definePolicy({
            on: "read",
            table: "items",
            when: () => where as never,
        }),
    ]);

/** 20 u1 rows: `level` 0n–19n, `code` "0"–"19", every 3rd hidden (7 rows), every other `parentId` null (10 rows). */
const seedItems = async (): Promise<ReturnType<typeof lunoraTest>> => {
    const t = lunoraTest(itemSchema);

    open.push(t);

    await t.run(async (ctx) => {
        await ctx.db.insertMany(
            "items",
            Array.from({ length: 20 }, (_, index) => {
                return { code: String(index), hidden: index % 3 === 0, level: BigInt(index), parentId: index % 2 === 0 ? null : "p", userId: "u1" };
            }),
        );
    });

    return t;
};

const byUser = (ctx: any) => ctx.db.query("items").withIndex("by_user", (q: any) => q.eq("userId", "u1"));

/** Suspend an iterator on the reader, then run other terminals on the SAME reader object. */
const interleaved = (where: Record<string, unknown>) =>
    query
        .use(rlsForTest(itemPolicy(where)))
        .input({})
        .query(async ({ ctx }) => {
            const shared = byUser(ctx);
            const iterator = shared[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;

            await iterator.next();

            const collected = (await shared.collect()) as unknown[];
            const taken = (await shared.take(100)) as unknown[];
            const page = (await shared.paginate({ cursor: null, numItems: 100 })) as { page: unknown[] };

            await iterator.return?.(undefined);

            let iterated = 0;

            for await (const row of byUser(ctx) as AsyncIterable<unknown>) {
                iterated += row === undefined ? 0 : 1;
            }

            return { collected: collected.length, iterated, page: page.page.length, taken: taken.length };
        });

const counts = (where: Record<string, unknown>) =>
    query
        .use(rlsForTest(itemPolicy(where)))
        .input({})
        .query(async ({ ctx }) => {
            return { collected: ((await byUser(ctx).collect()) as unknown[]).length, taken: ((await byUser(ctx).take(100)) as unknown[]).length };
        });

const nullParent = (ctx: any) => ctx.db.query("items").withIndex("by_parent", (q: any) => q.eq("parentId", null));

const nullParentReads = query
    .use(rlsForTest(itemPolicy({ userId: "u1" })))
    .input({})
    .query(async ({ ctx }) => {
        return {
            collected: ((await nullParent(ctx).collect()) as unknown[]).length,
            first: (await nullParent(ctx).first()) === null ? 0 : 1,
            page: ((await nullParent(ctx).paginate({ cursor: null, numItems: 100 })) as { page: unknown[] }).page.length,
            taken: ((await nullParent(ctx).take(100)) as unknown[]).length,
        };
    });

describe("rls() legacy reader edge cases (#822 review)", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("a suspended iterator never strips the policy from other terminals on the same reader", async () => {
        expect.assertions(2);

        const t = await seedItems();
        const u1 = t.withIdentity({ userId: "u1" });
        const admitted = { collected: 13, iterated: 13, page: 13, taken: 13 };

        // Pushed into SQL, and kept in memory (`NOT`): 13 of the 20 rows are visible either way.
        await expect(u1.query(interleaved({ hidden: false }), {})).resolves.toStrictEqual(admitted);
        await expect(u1.query(interleaved({ NOT: { hidden: true } }), {})).resolves.toStrictEqual(admitted);
    });

    it("admits exactly what the JS matcher admits for comparisons SQL types differently", async () => {
        expect.assertions(3);

        const t = await seedItems();
        const u1 = t.withIdentity({ userId: "u1" });

        // bigint column vs number operand: 0n–9n are below 10.
        await expect(u1.query(counts({ level: { lt: 10 } }), {})).resolves.toStrictEqual({ collected: 10, taken: 10 });
        // string column vs number operand: JS coerces, so "0"–"4" are below 5.
        await expect(u1.query(counts({ code: { lt: 5 } }), {})).resolves.toStrictEqual({ collected: 5, taken: 5 });
        // An empty operator bag constrains nothing.
        await expect(u1.query(counts({ userId: {} }), {})).resolves.toStrictEqual({ collected: 20, taken: 20 });
    });

    it("gives every terminal the same answer for withIndex(eq(field, null))", async () => {
        expect.assertions(2);

        const t = await seedItems();
        const unguarded = await t.run(async (ctx) => {
            const collected = await nullParent(ctx).collect();
            const taken = await nullParent(ctx).take(100);

            return { collected: collected.length, taken: taken.length };
        });

        // `eq(field, null)` matches the null rows, as `findMany({ where: { field: null } })` does.
        expect(unguarded).toStrictEqual({ collected: 10, taken: 10 });
        await expect(t.withIdentity({ userId: "u1" }).query(nullParentReads, {})).resolves.toStrictEqual({ collected: 10, first: 1, page: 10, taken: 10 });
    });
});
