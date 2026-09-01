import type { MutationCtx } from "../../lunora/_generated/server";

/**
 * A `ctx` double for driving control-plane mutations through `.handler(ctx, args)`.
 *
 * Shared, and modelling the store's REFUSALS rather than only its writes. Every
 * suite here had rolled its own, and every one of those recorded a patch and
 * returned — so nineteen calls that set a field to `undefined` were exercised by
 * a green suite while the real store rejects them outright ("use null to clear a
 * nullable field"). A double that accepts what production refuses is not a
 * shortcut, it is a suite asserting the wrong system.
 *
 * What it models:
 *
 * - **`where`** on the per-table `findMany` facades, by equality.
 * - **The explicit-`undefined` refusal** on `patch`, with the store's own message.
 * - **The rate-limit store**, because most mutations here carry
 *   `.use(rateLimit(...))` and `.handler` runs the middleware chain — a ctx
 *   without it fails with "rate limiter unavailable" before reaching the code
 *   under test.
 *
 * `ops` records every write in order, which is what lets a test assert ordering
 * (`usage.rollup`'s delete-before-patch is a correctness property, not a detail).
 * Note the limiter writes a `rateLimits` row of its own, so a test looking for a
 * mutation's audit entry should select it by table rather than taking the first
 * insert.
 */

type Row = Record<string, unknown>;

/** One recorded write. */
type Op = { id: string; kind: "delete" } | { id: string; kind: "patch"; patch: Row } | { document: Row; kind: "insert"; table: string };

interface FakeCtx {
    ctx: MutationCtx;
    ops: Op[];
}

/** The store's guard, restated so the double refuses exactly what production refuses. */
const assertNoExplicitUndefined = (patch: Row): void => {
    for (const field of Object.keys(patch)) {
        if (patch[field] === undefined) {
            throw new Error(`Cannot patch field '${field}' to undefined — use null to clear a nullable field, or omit the key to leave it unchanged.`);
        }
    }
};

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([field, value]) => row[field] === value);

/**
 * Build the double.
 *
 * `tables` maps table name → rows. `userId` is the signed-in caller, or `null`
 * for an anonymous one; supply a `members` row to satisfy `assertMember`.
 */
const makeCtx = (tables: Record<string, Row[]>, options: { now?: number; userId?: null | string } = {}): FakeCtx => {
    const ops: Op[] = [];
    const userId = options.userId === undefined ? "usr_1" : options.userId;
    const byId = new Map(
        Object.values(tables)
            .flat()
            .map((row) => [row["_id"] as string, row]),
    );

    const facade = (table: string) => {
        return {
            findMany: (args?: { where?: Row }) => Promise.resolve({ page: (tables[table] ?? []).filter((row) => matches(row, args?.where ?? {})) }),
        };
    };

    // Most mutations carry a rate-limit middleware; an empty bucket always allows,
    // which is the first-request path and keeps the limiter out of the assertion.
    const emptyQuery: { first: () => Promise<null>; withIndex: () => typeof emptyQuery } = { first: () => Promise.resolve(null), withIndex: () => emptyQuery };

    const database: Record<string, unknown> = {
        delete: (id: string) => {
            ops.push({ id, kind: "delete" });

            return Promise.resolve();
        },
        get: (id: string) => Promise.resolve(byId.get(id) ?? null),
        insert: (table: string, document: Row) => {
            ops.push({ document, kind: "insert", table });

            return Promise.resolve(`${table}_new`);
        },
        patch: (id: string, patch: Row) => {
            assertNoExplicitUndefined(patch);
            ops.push({ id, kind: "patch", patch });

            return Promise.resolve();
        },
        query: () => emptyQuery,
    };

    for (const table of Object.keys(tables)) {
        database[table] = facade(table);
    }

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(userId === null ? null : { subject: userId }), userId },
        db: database,
        log: { error: () => undefined, info: () => undefined },
        now: options.now ?? 1_700_000_000_000,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, ops };
};

/** An owner membership row, which is what `assertMember` looks for. */
const owner = (organizationId: string, userId = "usr_1"): Row => {
    return { _id: `mem_${userId}`, organizationId, role: "owner", userId };
};

export type { FakeCtx, Op, Row };
export { makeCtx, owner };
