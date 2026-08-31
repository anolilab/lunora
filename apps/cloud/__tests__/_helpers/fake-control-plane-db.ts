import type { ControlPlaneDatabase } from "../../src/store";

/**
 * A {@link ControlPlaneDatabase} double that behaves like the real store.
 *
 * The previous version returned every row for every call — `where`, `limit`,
 * `orderBy` and `cursor` were all discarded. That made several suites green
 * against a store that does not exist: the org-scoping predicate in
 * `deploy-alerts.ts` was never exercised, so a regression delivering another
 * org's alerts would have failed nothing, and the 1000-row page cap that
 * truncated the overage reconciler could not be reproduced at all — the bug and
 * its fix were equally invisible.
 *
 * So this honours the four things the sweeps actually depend on:
 *
 * - **`where`** — equality, plus the `{ lt }` / `{ lte }` / `{ gt }` / `{ gte }`
 *   operators the cutoff-filtered reads use.
 * - **`orderBy`** — because a sweep that pushes ordering into the query and gets
 *   an arbitrary order back is being tested against the wrong thing.
 * - **`limit` and `cursor`** — keyset pagination over a configurable page size,
 *   defaulting to the real cap, so a single-page read of a large table truncates
 *   here exactly as it does in production.
 *
 * Individual methods stay overridable for the suites that assert on call
 * arguments rather than results.
 */

/** The real store's page cap. A drain bug only reproduces if the fake enforces it. */
const FAKE_PAGE_SIZE = 1000;

type Row = Record<string, unknown>;

type Comparison = { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown };

/** Whether a `where` value is an operator object rather than an equality literal. */
const isComparison = (value: unknown): value is Comparison =>
    typeof value === "object" && value !== null && !Array.isArray(value) && ["gt", "gte", "lt", "lte"].some((key) => key in value);

/** Apply one `where` entry to a row. */
const matchesEntry = (actual: unknown, expected: unknown): boolean => {
    if (!isComparison(expected)) {
        return actual === expected;
    }

    const value = actual as number;

    return (
        (expected.lt === undefined || value < (expected.lt as number)) &&
        (expected.lte === undefined || value <= (expected.lte as number)) &&
        (expected.gt === undefined || value > (expected.gt as number)) &&
        (expected.gte === undefined || value >= (expected.gte as number))
    );
};

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([field, expected]) => matchesEntry(row[field], expected));

/** Sort by the first `orderBy` key, which is what every caller here specifies. */
const ordered = (rows: Row[], orderBy: Record<string, "asc" | "desc">[] | undefined): Row[] => {
    const first = orderBy?.[0];

    if (!first) {
        return rows;
    }

    const entry = Object.entries(first)[0];

    if (!entry) {
        return rows;
    }

    const [field, direction] = entry;
    const sign = direction === "desc" ? -1 : 1;

    return rows.toSorted((a, b) => {
        const left = a[field] as number | string;
        const right = b[field] as number | string;

        if (left === right) {
            return 0;
        }

        return left < right ? -sign : sign;
    });
};

/**
 * Build the double. `pages` maps table name → its rows; `spies` replaces whole
 * methods for suites that assert on how they were called.
 */
const fakeControlPlaneDb = (
    pages: Record<string, unknown[]>,
    spies: Partial<ControlPlaneDatabase> = {},
    options: { pageSize?: number } = {},
): ControlPlaneDatabase => {
    const pageSize = options.pageSize ?? FAKE_PAGE_SIZE;

    return {
        delete: () => Promise.resolve(undefined),
        findMany: (table, args) => {
            const all = ordered((pages[table] ?? []) as Row[], args?.orderBy);
            const filtered = args?.where ? all.filter((row) => matches(row, args.where as Row)) : all;

            // Keyset pagination by offset: the cursor is the index to resume from,
            // which is enough to model "one page at a time" faithfully without
            // reimplementing the real store's cursor encoding.
            const start = args?.cursor === null || args?.cursor === undefined ? 0 : Number(args.cursor);
            const size = Math.min(args?.limit ?? pageSize, pageSize);
            const page = filtered.slice(start, start + size);
            const next = start + page.length;
            const isDone = next >= filtered.length;

            return Promise.resolve({ continueCursor: isDone ? null : String(next), isDone, page });
        },
        insert: () => Promise.resolve("row_id"),
        patch: () => Promise.resolve(undefined),
        ...spies,
    };
};

export { FAKE_PAGE_SIZE };
export default fakeControlPlaneDb;
