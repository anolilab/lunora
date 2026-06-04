import { bench, describe } from "vitest";

import type { Middleware, Policy } from "../src/index.js";
import { definePolicy, initCirrus, rls } from "../src/index.js";

/**
 * RLS `get()` / id-keyed write round-trip cost as the number of policy-gated
 * tables (K) grows.
 *
 * The wrapped `get(id)` and the `findRowTable` used by patch/replace/delete
 * must discover which policy table owns an id. The legacy path issues
 * `1 base.get` + `N findFirst` membership probes (one per policy table) on
 * every call — ~O(K) storage round-trips. When the underlying writer exposes
 * the optional `getWithTable(id)` seam (which `@cirrus/do` can answer from its
 * internal `lookupById` index in one shot), the wrapper collapses that to a
 * single lookup.
 *
 * Each variant uses a query-counting mock writer so the win is the *number of
 * round-trips*, not just wall-clock — but the bench is still wall-clock so the
 * fast path's flat cost across K is visible against the probe path's growth.
 *
 *   - **probe K=1 / 4 / 16** — no `getWithTable`; 1 get + K findFirst probes.
 *   - **getWithTable K=1 / 4 / 16** — fast path; one lookup regardless of K.
 */

interface CountingWriter {
    count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
    delete: (id: string) => Promise<void>;
    findFirst: (tableName: string, args?: { where?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
    findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
    findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    getWithTable?: (id: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
    insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    query: (tableName: string) => never;
    replace: (id: string, document: Record<string, unknown>) => Promise<void>;
}

const TARGET_ID = "row_1";

/**
 * A mock writer over K tables `t0..t{K-1}`. `TARGET_ID` lives in the LAST
 * policy table (`t{K-1}`) so the probe path can't get lucky and short-circuit
 * on the first table. `withTable` toggles whether the fast-path seam exists.
 */
const makeWriter = (tableCount: number, withTable: boolean): CountingWriter => {
    const owningTable = `t${tableCount - 1}`;
    const row = { _creationTime: 0, _id: TARGET_ID, ownerId: "user_42" };

    const writer: CountingWriter = {
        async count() {
            return 0;
        },
        async delete() {
            /* noop */
        },
        async findFirst(tableName, args) {
            const wantsId = (args?.where as { _id?: string } | undefined)?._id;

            return wantsId === TARGET_ID && tableName === owningTable ? row : null;
        },
        async findFirstOrThrow() {
            return row;
        },
        async findMany() {
            return { continueCursor: null, isDone: true, page: [] };
        },
        async get(id) {
            return id === TARGET_ID ? row : null;
        },
        async insert() {
            return TARGET_ID;
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
    };

    if (withTable) {
        writer.getWithTable = async (id) => (id === TARGET_ID ? { row, tableName: owningTable } : null);
    }

    return writer;
};

const cirrus = initCirrus.dataModel<Record<string, never>>().create();

interface BenchContext {
    auth: { roles?: ReadonlyArray<string>; userId: null | string };
    db: CountingWriter;
}

// The procedure builder types `ctx.db` nominally; the RLS middleware signature
// is structural, so a permissive cast is needed in the bench harness.
const rlsAsAny = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

/** One read policy per table, each restricting to the caller's `ownerId`. */
const policiesFor = (tableCount: number): Policy<BenchContext>[] =>
    Array.from({ length: tableCount }, (_, index) =>
        definePolicy<BenchContext>({
            on: "read",
            table: `t${index}`,
            when: ({ auth }) => ({ ownerId: auth.userId }),
        }),
    );

const buildContext = (writer: CountingWriter): BenchContext => ({ auth: { roles: [], userId: "user_42" }, db: writer });

const makeGetHandler = (tableCount: number) =>
    cirrus.query.use(rlsAsAny<BenchContext>(policiesFor(tableCount))).query(async ({ ctx }) => {
        await (ctx.db as unknown as CountingWriter).get(TARGET_ID);

        return null;
    });

const handlers = {
    1: makeGetHandler(1),
    4: makeGetHandler(4),
    16: makeGetHandler(16),
};

const probeWriters = { 1: makeWriter(1, false), 4: makeWriter(4, false), 16: makeWriter(16, false) };
const fastWriters = { 1: makeWriter(1, true), 4: makeWriter(4, true), 16: makeWriter(16, true) };

describe("rls() get() — table discovery cost vs K policy tables", () => {
    for (const k of [1, 4, 16] as const) {
        bench(`probe path K=${k}: 1 get + ${k} findFirst probes`, async () => {
            await handlers[k].handler(buildContext(probeWriters[k]), {});
        });

        bench(`getWithTable fast path K=${k}: single lookup`, async () => {
            await handlers[k].handler(buildContext(fastWriters[k]), {});
        });
    }
});
