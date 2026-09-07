/**
 * Walk a cursored list route to the end and return every record — shared
 * (bundler-inlined, like {@link file://./stable-key.ts}) by `@lunora/client`,
 * `@lunora/scheduler`, `@lunora/runtime` and `@lunora/cli`, none of which may
 * depend on another.
 *
 * ## The termination rule
 *
 * Keep paging **only** when `truncated === true` AND `cursor` is a non-empty
 * string; stop otherwise.
 *
 * Both halves are load-bearing, and the four hand-written walkers this replaces
 * did not agree on the second. The producers (`SchedulerDO.listPage`, which
 * answers `/list` and `/dead`, and the R2-backed storage lister) only ever set
 * `cursor` alongside `truncated: true`, so on a healthy host the two rules are
 * indistinguishable. They diverge on a malformed page — `truncated: true` with
 * `cursor` absent or `""` — where trusting `truncated` alone re-requests the
 * FIRST page forever, because an empty cursor builds the same URL as no cursor
 * at all. Stopping is the only bounded answer, and a bounded short read beats a
 * hung caller.
 *
 * A cursor that repeats itself is the same hazard one step later, so it throws:
 * the host claims more pages while handing back the page we just read, and the
 * caller asked for the WHOLE list (a scheduler dedupe, an upload pre-flight),
 * where a silent partial answer is a wrong answer rather than a slow one.
 *
 * Building the query string is left to `fetchPage` — three callers append
 * `?cursor=` to a DO path and the fourth appends `&cursor=` to an already-built
 * URL.
 * @param fetchPage fetches one page, given the previous page's cursor
 * @returns every record across every page, in page order
 */
const collectPages = async <T>(fetchPage: (cursor?: string) => Promise<{ cursor?: string; records?: T[]; truncated?: boolean }>): Promise<T[]> => {
    const all: T[] = [];
    let cursor: string | undefined;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page, so the round-trips are inherently sequential
        const page = await fetchPage(cursor);

        // Keep the return honest (never `undefined`) if a host answers 200 with
        // no `records` array.
        all.push(...(Array.isArray(page.records) ? page.records : []));

        if (page.truncated !== true || typeof page.cursor !== "string" || page.cursor.length === 0) {
            return all;
        }

        if (page.cursor === cursor) {
            throw new Error("collectPages: the list did not advance its cursor — refusing to page forever");
        }

        cursor = page.cursor;
    }
};

export { collectPages };
