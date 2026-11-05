/**
 * `@lunora/client/pagination` — the framework-agnostic pagination state machine
 * shared by every Lunora UI adapter (React, Vue, Svelte, Solid).
 *
 * Owns cursor tracking, page-size rebalancing (split/join), `initialPages`,
 * `rebalance`, and the shared types (`Page`, `PaginationResult`,
 * `PaginationStatus`, `PaginatedCoreResult`). Nothing here imports a UI
 * framework — each adapter wires the pure functions into its own reactive
 * primitives.
 */

/** Grow factor: a bounded page is split when it exceeds this multiple of its target size. */
const SPLIT_FACTOR = 2;

/** Shrink factor: a bounded page with a neighbour is joined when it falls below this multiple of its target size. */
const JOIN_FACTOR = 0.5;

/** A loaded page: a fixed `(lower, upper]` range plus the size it targets. */
interface Page {
    // `null | string` mirrors the server's cursor wire shape: a `lower` of
    // `null` is the first-page start; an `upper` of `null` is the open-ended
    // (still-growing) final page.
    lower: null | string;
    numItems: number;
    upper: null | string;
}

/** One page returned by a paginated query — the shape `.paginate()` yields. */
interface PaginationResult<T = unknown> {
    continueCursor: null | string;
    isDone: boolean;
    page: T[];

    /**
     * Reactive-pagination only: the midpoint cursor of a bounded
     * `(cursor, endCursor]` page, used to split an over-grown page into two
     * adjacent ranges. Absent on legacy (open-ended) pages.
     */
    splitCursor?: null | string;

    /**
     * Reactive-pagination only: the server's read cut this bounded page short, so it holds only the
     * first rows of its range. Split at `splitCursor` whatever the page's size.
     */
    splitRequired?: boolean;
}

/**
 * Lifecycle of a `usePaginatedQuery` feed.
 *
 * - `LoadingFirstPage` — the first page is in flight; `results` is empty.
 * - `CanLoadMore` — the loaded tail has a cursor; calling `loadMore` fetches the next page.
 * - `LoadingMore` — a `loadMore` page is in flight; earlier results stay visible.
 * - `Exhausted` — every page has loaded and the server reported `isDone`.
 */
type PaginationStatus = "CanLoadMore" | "Exhausted" | "LoadingFirstPage" | "LoadingMore";

interface PaginatedCoreResult<T> {
    /** Request another page off the open-ended tail. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Per-page resolved results in order; entries are `undefined` until a page resolves. */
    pageResults: (PaginationResult<T> | undefined)[];
    status: PaginationStatus;
}

/** First-page seed: a single open-ended range starting at the feed head. */
const initialPages = (numberItems: number): Page[] => [
    // eslint-disable-next-line unicorn/no-null -- `lower: null` is the feed head, `upper: null` the open-ended tail — both are wire-shape cursors.
    { lower: null, numItems: numberItems, upper: null },
];

/**
 * Run the SPLIT/JOIN maintenance pass over the current page list given freshly
 * resolved results. Returns a new page list when a boundary changed, or
 * `undefined` when the layout is already balanced (so the caller can skip a
 * setState).
 *
 * Only ONE structural edit is applied per pass (the first split or join found),
 * letting the subsequent re-render's resolved results drive the next pass — this
 * keeps each transition observable and avoids reasoning about several
 * simultaneous boundary moves.
 */
const rebalance = (pages: Page[], results: (PaginationResult | undefined)[]): Page[] | undefined => {
    for (const [index, page] of pages.entries()) {
        // Only bounded (fully-resolved, fixed-range) pages participate; the
        // open-ended tail grows via `loadMore`, not split/join.
        if (page.upper === null) {
            continue;
        }

        const result = results[index];

        if (!result) {
            continue;
        }

        const size = result.page.length;

        // SPLIT: the range outgrew its target, or the server's read cut it short
        // (`splitRequired`) and the rows past the cut are reachable no other way.
        // Cut at the server's midpoint cursor into `(lower, splitCursor]` and
        // `(splitCursor, upper]`.
        if ((size > SPLIT_FACTOR * page.numItems || result.splitRequired === true) && result.splitCursor) {
            const split = result.splitCursor;
            const next = [...pages];

            next.splice(index, 1, { lower: page.lower, numItems: page.numItems, upper: split }, { lower: split, numItems: page.numItems, upper: page.upper });

            return next;
        }

        // JOIN: the range shrank below its target and has a following neighbour;
        // merge by dropping the shared boundary (this page's upper). The merged
        // page keeps this page's lower and the neighbour's upper. Never into a
        // neighbour the server cut short: the merge would be cut again and split
        // back, and the pages would flip between the two layouts.
        if (size < JOIN_FACTOR * page.numItems && index + 1 < pages.length && results[index + 1]?.splitRequired !== true) {
            const neighbour = pages[index + 1];

            if (!neighbour) {
                continue;
            }

            const next = [...pages];

            next.splice(index, 2, { lower: page.lower, numItems: page.numItems, upper: neighbour.upper });

            return next;
        }
    }

    return undefined;
};

/**
 * Derive the feed `status` and the next-page cursor from the current page list
 * and resolved page results. Framework adapters call this each render/effect to
 * compute what to expose to callers.
 */
const derivePaginationStatus = <T>(
    skipped: boolean,
    pageResults: (PaginationResult<T> | undefined)[],
): { nextCursor: null | string | undefined; status: PaginationStatus } => {
    if (skipped || !pageResults[0]) {
        return { nextCursor: undefined, status: "LoadingFirstPage" };
    }

    const tail = pageResults.at(-1);

    if (!tail) {
        return { nextCursor: undefined, status: "LoadingMore" };
    }

    if (tail.isDone || tail.continueCursor === null) {
        return { nextCursor: undefined, status: "Exhausted" };
    }

    return { nextCursor: tail.continueCursor, status: "CanLoadMore" };
};

/**
 * Apply a `loadMore` to the current page list. Pins the open-ended tail at
 * `cursor` (making it a fixed bounded range) and appends a fresh open-ended
 * page starting at `cursor`. The shared boundary keeps the feed gap- and
 * dup-free.
 *
 * Returns the new page list, or `undefined` when the given `cursor` is not
 * valid (null or undefined — caller should no-op).
 */
const applyLoadMore = (pages: Page[], cursor: null | string | undefined, numberItems: number): Page[] | undefined => {
    if (cursor === undefined || cursor === null) {
        return undefined;
    }

    const next = [...pages];
    const tail = next.at(-1);

    if (tail) {
        next[next.length - 1] = { lower: tail.lower, numItems: tail.numItems, upper: cursor };
    }

    // eslint-disable-next-line unicorn/no-null -- a fresh tail is open-ended (`upper: null`); its lower is the just-pinned boundary cursor.
    next.push({ lower: cursor, numItems: numberItems, upper: null });

    return next;
};

/**
 * What a feed does with one page's failure.
 *
 * - `surface` — report it (the `error` value and `onError`), as before.
 * - `restart` — reload the feed from its first page, silently: the page's cursor no longer decodes.
 * - `ignore` — drop it: a page the feed no longer holds, still reporting from before a restart.
 */
type PageFailure = "ignore" | "restart" | "surface";

/** The feed's first page before any `loadMore`: `(null, null]`, the one page that carries no cursor. */
const isHeadPage = (page: Page): boolean => page.lower === null && page.upper === null;

/**
 * Classify a page failure. Only `INVALID_CURSOR` changes the answer: the server refuses a cursor
 * minted by an older build (a deploy changed the query's order or the engine's cursor encoding), and
 * every bounded page the feed holds carries one, so the only way forward is page one.
 *
 * Two cases surface it instead. The head page has no cursor to be stale. And `restartedSinceLoad`
 * (the feed restarted, and no page past the head has had a frame since) means the server is refusing
 * the cursors it mints now, which a second restart would only repeat on every `loadMore`.
 */
const classifyPageFailure = (pages: Page[], isFailedPage: (page: Page) => boolean, error: { code?: string }, restartedSinceLoad: boolean): PageFailure => {
    if (error.code !== "INVALID_CURSOR") {
        return "surface";
    }

    const page = pages.find((candidate) => isFailedPage(candidate));

    if (page === undefined) {
        return "ignore";
    }

    return isHeadPage(page) || restartedSinceLoad ? "surface" : "restart";
};

export type { Page, PageFailure, PaginatedCoreResult, PaginationResult, PaginationStatus };
export { applyLoadMore, classifyPageFailure, derivePaginationStatus, initialPages, isHeadPage, JOIN_FACTOR, rebalance, SPLIT_FACTOR };
