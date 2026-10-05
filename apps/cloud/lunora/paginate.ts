/**
 * Whole-table draining for the control-plane cron sweeps.
 *
 * `findMany` answers with ONE page (capped at 1000 rows) plus a
 * `continueCursor`/`isDone` pair. A sweep that only needs the oldest or newest
 * rows should say so in the query — order and filter there, take a bounded page
 * — but a sweep that has to visit *every* row (spend caps, dunning) silently
 * skips organizations if it reads one page and stops.
 */

/** One page of a `findMany` result, narrowed to what draining needs. */
interface Page {
    continueCursor: null | string;
    isDone: boolean;
    page: unknown[];
}

/**
 * Runaway stop, not a business limit. The tables drained here are bounded by
 * customer count, so reaching 100 pages (100k rows) means something upstream is
 * wrong — and looping forever inside a mutation is worse than stopping short.
 */
const MAX_PAGES = 100;

/**
 * Follow `continueCursor` until the query reports `isDone`, concatenating every
 * page. `fetchPage` receives the cursor to resume from (`null` for the first
 * page) and should pass it straight through as `findMany`'s `cursor`.
 */
export const collectAll = async <TRow>(fetchPage: (cursor: null | string) => Promise<Page>): Promise<TRow[]> => {
    const rows: TRow[] = [];
    let cursor: null | string = null;

    for (let index = 0; index < MAX_PAGES; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- keyset pagination is sequential by construction
        const result = await fetchPage(cursor);

        rows.push(...(result.page as TRow[]));

        if (result.isDone || result.continueCursor === null) {
            break;
        }

        cursor = result.continueCursor;
    }

    return rows;
};
