/**
 * Test-double support for the RPC rate limiter (`lunora/guards.ts`).
 *
 * Every public mutation/action now carries `.use(dbRateLimit(RATE_LIMITS, …))`,
 * whose store reaches for `ctx.db.query("rateLimits").withIndex("by_key", …)`.
 * The hand-rolled `db` doubles in these tests only implement the per-table
 * `findMany` facade, so the store threw `db.query is not a function` — and the
 * middleware **fails closed**, turning every call into a 503 and masking what
 * the test was actually asserting.
 *
 * {@link withRateLimitStore} wraps such a double with a real in-memory bucket
 * store. Reads and writes for the `rateLimits` table are served from an isolated
 * `Map`, so limiter bookkeeping never lands in the `inserted` / `patched` arrays
 * the tests assert on; every other table delegates to the original double.
 *
 * The buckets are per-wrapper, so each `makeCtx(...)` starts with a full bucket
 * and the limits never fire mid-test. A test that wants to *exercise* a limit
 * should call the procedure past its configured rate.
 */

/** One stored token-bucket row, matching the `rateLimits` table shape. */
interface BucketRow {
    _id: string;
    key: string;
    prev?: number;
    ts: number;
    value: number;
}

/** The narrow slice of the index-range builder `createDbStore` drives. */
interface IndexRange {
    eq: (field: string, value: unknown) => IndexRange;
}

const RATE_LIMIT_TABLE = "rateLimits";

/**
 * Add a working `query()` (plus `rateLimits`-scoped `insert`/`patch`/`delete`)
 * to a hand-rolled `ctx.db` double. Returns a new object; the input is untouched.
 */
const withRateLimitStore = (database: Record<string, unknown>): Record<string, unknown> => {
    const byKey = new Map<string, BucketRow>();
    const keyById = new Map<string, string>();
    let sequence = 0;

    const originalInsert = database.insert as ((table: string, document: Record<string, unknown>) => Promise<string>) | undefined;
    const originalPatch = database.patch as ((id: string, patch: Record<string, unknown>) => Promise<void>) | undefined;
    const originalDelete = database.delete as ((id: string) => Promise<void>) | undefined;

    return {
        ...database,

        delete: (id: string) => {
            const key = keyById.get(id);

            if (key === undefined) {
                return originalDelete?.(id) ?? Promise.resolve();
            }

            byKey.delete(key);
            keyById.delete(id);

            return Promise.resolve();
        },

        insert: (table: string, document: Record<string, unknown>) => {
            if (table !== RATE_LIMIT_TABLE) {
                return originalInsert?.(table, document) ?? Promise.resolve(`${table}_new`);
            }

            sequence += 1;

            const id = `rateLimits_${String(sequence)}`;
            const key = String(document.key);

            byKey.set(key, { ...document, _id: id, key } as BucketRow);
            keyById.set(id, key);

            return Promise.resolve(id);
        },

        patch: (id: string, patch: Record<string, unknown>) => {
            const key = keyById.get(id);

            if (key === undefined) {
                return originalPatch?.(id, patch) ?? Promise.resolve();
            }

            const existing = byKey.get(key);

            if (existing) {
                byKey.set(key, { ...existing, ...patch });
            }

            return Promise.resolve();
        },

        query: (table: string) => {
            return {
                withIndex: (_index: string, build: (range: IndexRange) => IndexRange) => {
                    // `createDbStore` builds exactly one `.eq(keyField, storageKey)`;
                    // capture that value rather than modelling a general index scan.
                    let storageKey: unknown;

                    const range: IndexRange = {
                        eq: (_field, value) => {
                            storageKey = value;

                            return range;
                        },
                    };

                    build(range);

                    return {
                        first: () => Promise.resolve(table === RATE_LIMIT_TABLE ? (byKey.get(String(storageKey)) ?? null) : null),
                    };
                },
            };
        },
    };
};

export default withRateLimitStore;
