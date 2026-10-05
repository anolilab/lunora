/**
 * The minimal structural view of the control-plane store the scheduled sweeps
 * and their port-builders read/write — the `.global()` D1 ctx-db, narrowed to
 * the three methods they use. A neutral home (not under `deploy/`), since
 * billing, telemetry, uptime, and deploy all depend on it.
 */
export interface ControlPlaneDatabase {
    // The teardown sweep releases an alias's ownership row once its last
    // deployment is gone; `table` mirrors `patch`'s optional table qualifier.
    delete: (id: string, table?: string) => Promise<unknown>;
    findMany: (
        table: string,
        // `limit`/`orderBy` are pass-throughs the underlying ctx-db already honors
        // (the alert sweep bounds its recent-observation read with them).
        //
        // `cursor` — and `continueCursor`/`isDone` coming back — exist because
        // without them a sweep in `src/` COULD NOT drain a table even when it had
        // to. `findMany` answers one page, capped at 1000 rows, so every fleet-wide
        // read here stopped at that boundary and reported success: the overage
        // reconciler under-counted usage and under-debited, the teardown sweep
        // leaked dispatch scripts, the uptime sweep stopped probing. `lunora/`
        // already had `collectAll` for exactly this; the structural store simply
        // had no way to express it.
        args?: {
            cursor?: null | string;
            limit?: number;
            orderBy?: Record<string, "asc" | "desc">[];
            where?: Record<string, unknown>;
        },
    ) => Promise<{ continueCursor?: null | string; isDone?: boolean; page: unknown[] }>;
    insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
    patch: (id: string, patch: Record<string, unknown>, table?: string) => Promise<unknown>;
}

/** Follow `continueCursor` until the store reports `isDone`. Mirrors `lunora/paginate.ts`'s `collectAll`. */
const MAX_DRAIN_PAGES = 100;

/**
 * Read EVERY row of a table through the structural store, following the cursor.
 *
 * The `src/` counterpart to `lunora/paginate.ts`'s `collectAll`, and it exists for
 * the same reason that one does: a sweep that must visit every organization and
 * reads a single page silently skips everyone past the page cap, while still
 * reporting success. Use this only where the sweep genuinely has to see the whole
 * table — a sweep that wants the oldest or newest rows should say so with
 * `orderBy` + `limit` instead, which is one round trip rather than N.
 *
 * Bounded by {@link MAX_DRAIN_PAGES} so a cursor that never terminates degrades
 * into a truncated read rather than an infinite scheduled invocation.
 */
export const drainTable = async <TRow>(
    database: ControlPlaneDatabase,
    table: string,
    args: { limit?: number; orderBy?: Record<string, "asc" | "desc">[]; where?: Record<string, unknown> } = {},
): Promise<TRow[]> => {
    const rows: TRow[] = [];
    let cursor: null | string = null;

    for (let index = 0; index < MAX_DRAIN_PAGES; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- keyset pagination is sequential by construction
        const result = await database.findMany(table, { ...args, cursor });

        rows.push(...(result.page as TRow[]));

        if (result.isDone !== false || result.continueCursor === null || result.continueCursor === undefined) {
            break;
        }

        cursor = result.continueCursor;
    }

    return rows;
};
