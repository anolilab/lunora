import { describe, expect, it } from "vitest";

import type { Page, PaginationResult } from "../src/pagination/index";
import { applyLoadMore, derivePaginationStatus, initialPages, JOIN_FACTOR, rebalance, SPLIT_FACTOR } from "../src/pagination/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("sPLIT_FACTOR / JOIN_FACTOR", () => {
    it("sPLIT_FACTOR is 2", () => {
        expect.assertions(1);
        expect(SPLIT_FACTOR).toBe(2);
    });

    it("jOIN_FACTOR is 0.5", () => {
        expect.assertions(1);
        expect(JOIN_FACTOR).toBe(0.5);
    });
});

// ---------------------------------------------------------------------------
// initialPages
// ---------------------------------------------------------------------------

describe("initialPages", () => {
    it("returns a single open-ended page starting at the feed head", () => {
        expect.assertions(2);

        const pages = initialPages(10);

        expect(pages).toHaveLength(1);
        expect(pages[0]).toEqual({ lower: null, numItems: 10, upper: null });
    });

    it("captures the requested numItems", () => {
        expect.assertions(1);

        const pages = initialPages(5);

        expect(pages[0]?.numItems).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// rebalance — no-op cases
// ---------------------------------------------------------------------------

describe("rebalance — returns undefined when no edit needed", () => {
    it("open-ended pages are never split or joined", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];
        const results: PaginationResult[] = [{ continueCursor: "c", isDone: false, page: ["a", "b", "c", "d", "e"] }];

        // Even with 5 rows on a numItems-2 page, an open-ended page is skipped.
        expect(rebalance(pages, results)).toBeUndefined();
    });

    it("returns undefined when all bounded pages are within range", () => {
        expect.assertions(1);

        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "b" },
            { lower: "b", numItems: 2, upper: null },
        ];
        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "b", isDone: true, page: ["a", "b"] },
            { continueCursor: null, isDone: true, page: ["c", "d"] },
        ];

        expect(rebalance(pages, results)).toBeUndefined();
    });

    it("returns undefined when a bounded page has no result yet", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: "b" }];
        const results: (PaginationResult | undefined)[] = [undefined];

        expect(rebalance(pages, results)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// rebalance — SPLIT
// ---------------------------------------------------------------------------

describe("rebalance — SPLIT", () => {
    it("splits a bounded page that exceeds SPLIT_FACTOR × numItems", () => {
        expect.assertions(2);

        // numItems=2, SPLIT at >4 rows. 5 rows triggers a split.
        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "e" },
            { lower: "e", numItems: 2, upper: null },
        ];
        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "e", isDone: true, page: ["a", "b", "c", "d", "e"], splitCursor: "c" },
            { continueCursor: null, isDone: true, page: ["f", "g"] },
        ];

        const next = rebalance(pages, results);

        expect(next).toBeDefined();
        // Original page 0 is split into two at "c".
        expect(next).toEqual([
            { lower: null, numItems: 2, upper: "c" },
            { lower: "c", numItems: 2, upper: "e" },
            { lower: "e", numItems: 2, upper: null },
        ]);
    });

    it("does NOT split when splitCursor is absent even if row count exceeds threshold", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: "e" }];
        const results: (PaginationResult | undefined)[] = [
            // No splitCursor — server did not supply a midpoint.
            { continueCursor: "e", isDone: true, page: ["a", "b", "c", "d", "e"] },
        ];

        expect(rebalance(pages, results)).toBeUndefined();
    });

    it("splits only the FIRST eligible page per pass", () => {
        expect.assertions(4);

        // Two bounded pages both over threshold — only the first is split.
        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "e" },
            { lower: "e", numItems: 2, upper: "k" },
        ];
        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "e", isDone: true, page: ["a", "b", "c", "d", "e"], splitCursor: "c" },
            { continueCursor: "k", isDone: true, page: ["f", "g", "h", "i", "k"], splitCursor: "h" },
        ];

        const next = rebalance(pages, results);

        expect(next).toHaveLength(3); // First page split → +1 page; second untouched.
        expect(next?.[0]).toEqual({ lower: null, numItems: 2, upper: "c" });
        expect(next?.[1]).toEqual({ lower: "c", numItems: 2, upper: "e" });
        expect(next?.[2]).toEqual({ lower: "e", numItems: 2, upper: "k" }); // unchanged
    });
});

// ---------------------------------------------------------------------------
// rebalance — JOIN
// ---------------------------------------------------------------------------

describe("rebalance — JOIN", () => {
    it("joins a bounded page that shrinks below JOIN_FACTOR × numItems when it has a neighbour", () => {
        expect.assertions(1);

        // numItems=2, JOIN below 1 row. Empty page with a right neighbour joins.
        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "b" },
            { lower: "b", numItems: 2, upper: null },
        ];
        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "b", isDone: true, page: [] }, // 0 rows < 0.5×2 = 1
            { continueCursor: null, isDone: true, page: ["c", "d"] },
        ];

        const next = rebalance(pages, results);

        expect(next).toEqual([{ lower: null, numItems: 2, upper: null }]);
    });

    it("does NOT join a bounded page that has NO following neighbour", () => {
        expect.assertions(1);

        // Only one page — no neighbour to merge with.
        const pages: Page[] = [{ lower: null, numItems: 2, upper: "b" }];
        const results: (PaginationResult | undefined)[] = [{ continueCursor: "b", isDone: true, page: [] }];

        expect(rebalance(pages, results)).toBeUndefined();
    });

    it("joins only the FIRST eligible page per pass", () => {
        expect.assertions(3);

        // Three bounded pages; first two are tiny — only the first is joined.
        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "b" },
            { lower: "b", numItems: 2, upper: "d" },
            { lower: "d", numItems: 2, upper: null },
        ];
        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "b", isDone: true, page: [] }, // tiny
            { continueCursor: "d", isDone: true, page: [] }, // tiny
            { continueCursor: null, isDone: true, page: ["e"] },
        ];

        const next = rebalance(pages, results);

        // First join: page[0] merges with page[1] → boundary "b" dropped.
        expect(next).toHaveLength(2);
        expect(next?.[0]).toEqual({ lower: null, numItems: 2, upper: "d" });
        expect(next?.[1]).toEqual({ lower: "d", numItems: 2, upper: null });
    });
});

// ---------------------------------------------------------------------------
// derivePaginationStatus
// ---------------------------------------------------------------------------

describe("derivePaginationStatus", () => {
    it("returns LoadingFirstPage when skipped=true", () => {
        expect.assertions(2);

        const { status, nextCursor } = derivePaginationStatus(true, []);

        expect(status).toBe("LoadingFirstPage");
        expect(nextCursor).toBeUndefined();
    });

    it("returns LoadingFirstPage when no results yet", () => {
        expect.assertions(1);

        const { status } = derivePaginationStatus(false, [undefined]);

        expect(status).toBe("LoadingFirstPage");
    });

    it("returns LoadingMore when first page loaded but tail is missing", () => {
        expect.assertions(1);

        const results: (PaginationResult | undefined)[] = [{ continueCursor: "b", isDone: false, page: ["a", "b"] }, undefined];
        const { status } = derivePaginationStatus(false, results);

        expect(status).toBe("LoadingMore");
    });

    it("returns Exhausted when tail reports isDone=true", () => {
        expect.assertions(2);

        const results: (PaginationResult | undefined)[] = [{ continueCursor: null, isDone: true, page: ["a", "b"] }];
        const { status, nextCursor } = derivePaginationStatus(false, results);

        expect(status).toBe("Exhausted");
        expect(nextCursor).toBeUndefined();
    });

    it("returns Exhausted when tail reports continueCursor=null (isDone may be false)", () => {
        expect.assertions(1);

        const results: (PaginationResult | undefined)[] = [{ continueCursor: null, isDone: false, page: ["a"] }];
        const { status } = derivePaginationStatus(false, results);

        expect(status).toBe("Exhausted");
    });

    it("returns CanLoadMore and the tail continueCursor when more pages exist", () => {
        expect.assertions(2);

        const results: (PaginationResult | undefined)[] = [{ continueCursor: "cursor-42", isDone: false, page: ["a", "b"] }];
        const { status, nextCursor } = derivePaginationStatus(false, results);

        expect(status).toBe("CanLoadMore");
        expect(nextCursor).toBe("cursor-42");
    });

    it("reads status from the LAST page, not the first", () => {
        expect.assertions(2);

        const results: (PaginationResult | undefined)[] = [
            { continueCursor: "b", isDone: false, page: ["a", "b"] }, // page 0 — bounded
            { continueCursor: "cursor-99", isDone: false, page: ["c", "d"] }, // tail
        ];
        const { status, nextCursor } = derivePaginationStatus(false, results);

        expect(status).toBe("CanLoadMore");
        expect(nextCursor).toBe("cursor-99");
    });
});

// ---------------------------------------------------------------------------
// applyLoadMore
// ---------------------------------------------------------------------------

describe("applyLoadMore", () => {
    it("returns undefined when cursor is undefined", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];

        expect(applyLoadMore(pages, undefined, 2)).toBeUndefined();
    });

    it("returns undefined when cursor is null", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];

        expect(applyLoadMore(pages, null, 2)).toBeUndefined();
    });

    it("pins the tail to [lower, cursor] and appends a fresh open-ended page", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];
        const next = applyLoadMore(pages, "cursor-5", 3);

        expect(next).toEqual([
            { lower: null, numItems: 2, upper: "cursor-5" }, // pinned
            { lower: "cursor-5", numItems: 3, upper: null }, // new open-ended tail
        ]);
    });

    it("does not mutate the input pages array", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];
        const frozen = [...pages];

        applyLoadMore(pages, "cursor-5", 2);

        expect(pages).toEqual(frozen);
    });

    it("new page uses the caller-supplied numberItems, not the pinned page's", () => {
        expect.assertions(1);

        const pages: Page[] = [{ lower: null, numItems: 2, upper: null }];
        const next = applyLoadMore(pages, "c", 10);

        expect(next?.[1]?.numItems).toBe(10);
    });

    it("multi-page: only the last page is pinned, others are preserved", () => {
        expect.assertions(4);

        const pages: Page[] = [
            { lower: null, numItems: 2, upper: "b" },
            { lower: "b", numItems: 2, upper: null },
        ];
        const next = applyLoadMore(pages, "cursor-x", 5);

        expect(next).toHaveLength(3);
        expect(next?.[0]).toEqual({ lower: null, numItems: 2, upper: "b" }); // unchanged
        expect(next?.[1]).toEqual({ lower: "b", numItems: 2, upper: "cursor-x" }); // pinned
        expect(next?.[2]).toEqual({ lower: "cursor-x", numItems: 5, upper: null }); // new
    });
});
