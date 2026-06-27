import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import { act, configure, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";

// The reactive pagination updates settle asynchronously; the 1s default
// `waitFor` timeout flakes under parallel CI load (a later page not yet
// applied). Give async assertions more headroom for this file.
configure({ asyncUtilTimeout: 5000 });

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

interface PaginationOpts {
    cursor: null | string;
    endCursor?: null | string;
    numItems: number;
}

interface PageResult {
    continueCursor: null | string;
    isDone: boolean;
    page: string[];
    splitCursor?: null | string;
}

/**
 * A faithful reactive-pagination backend for the React layer: items are sorted
 * strings whose value doubles as their index-key cursor. It evaluates the same
 * `(cursor, endCursor]` semantics the DO server implements (bounded → whole
 * range + midpoint splitCursor; open-ended → first `numItems` + continueCursor),
 * and — crucially — re-runs every LIVE page subscription against its own fixed
 * range whenever the dataset mutates, pushing fresh per-range results. That is
 * what lets us assert that a mid-list insert/delete grows/shrinks one page
 * without duplicating or skipping rows across boundaries.
 */
const createReactiveBackend = (initial: string[]) => {
    let items = [...initial].toSorted((a, b) => a.localeCompare(b));

    interface LiveSub {
        callback: (value: unknown) => void;
        opts: PaginationOpts;
    }

    const subs = new Set<LiveSub>();

    const evaluate = (opts: PaginationOpts): PageResult => {
        const { cursor, endCursor, numItems } = opts;
        // Lower bound is exclusive; a `null` lower is the feed head.
        const after = cursor === null ? items : items.filter((value) => value > cursor);

        if (endCursor != null) {
            // Bounded page: the whole half-open range, plus the midpoint cursor.
            const inRange = after.filter((value) => value <= endCursor);
            const middle = inRange.length >= 2 ? inRange[Math.floor(inRange.length / 2) - 1] : null;

            return { continueCursor: endCursor, isDone: true, page: inRange, splitCursor: middle };
        }

        // Open-ended tail: first `numItems` rows after the cursor.
        const page = after.slice(0, numItems);
        const isDone = after.length <= numItems;
        const last = page.at(-1);

        return { continueCursor: isDone ? null : (last ?? null), isDone, page };
    };

    const query = vi.fn<(reference: FunctionReference, args: unknown) => Promise<PageResult>>(async (_reference: FunctionReference, args: unknown) =>
        evaluate((args as { paginationOpts: PaginationOpts }).paginationOpts),
    );

    const subscribe = vi.fn<(reference: FunctionReference, args: unknown, callback: (value: unknown) => void) => Unsubscribe>(
        (_reference: FunctionReference, args: unknown, callback: (value: unknown) => void): Unsubscribe => {
            const sub: LiveSub = { callback, opts: (args as { paginationOpts: PaginationOpts }).paginationOpts };

            subs.add(sub);

            return () => {
                subs.delete(sub);
            };
        },
    );

    /** Re-run every live page subscription against its fixed range and push the result. */
    const refresh = (): void => {
        for (const sub of subs) {
            sub.callback(evaluate(sub.opts));
        }
    };

    const insert = (value: string): void => {
        items = [...items, value].toSorted((a, b) => a.localeCompare(b));
        refresh();
    };

    const remove = (value: string): void => {
        items = items.filter((entry) => entry !== value);
        refresh();
    };

    const asClient = {
        action: vi.fn<() => Promise<unknown>>(),
        close: vi.fn<() => void>(),
        getAuthToken: vi.fn<() => string | null>(() => null),
        mutation: vi.fn<() => Promise<unknown>>(),
        onAuthTokenChange: vi.fn<() => Unsubscribe>(() => () => undefined),
        query,
        setAuthToken: vi.fn<(token: string | null) => void>(),
        subscribe,
    } as unknown as LunoraClient;

    return { asClient, insert, query, remove, subscribe, subCount: () => subs.size };
};

interface HarnessProps {
    initialNumItems?: number;
    onLoadMore?: (loadMore: (numberItems: number) => void) => void;
}

const Harness = ({ initialNumItems: initialNumberItems = 2, onLoadMore }: HarnessProps): ReactElement => {
    const { loadMore, results, status } = usePaginatedQuery(makeRef("items:list"), {}, { initialNumItems: initialNumberItems });

    onLoadMore?.(loadMore);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
        </div>
    );
};

/** Load two adjacent pages and return the captured `loadMore`. */
const renderTwoPages = async (backend: ReturnType<typeof createReactiveBackend>): Promise<{ loadMore: (numberItems: number) => void }> => {
    let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

    render(
        <LunoraProvider client={backend.asClient}>
            <Harness
                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback capturing the hook's `loadMore`.
                onLoadMore={(next) => {
                    loadMore = next;
                }}
            />
        </LunoraProvider>,
    );

    await waitFor(() => {
        expect(screen.getByTestId("results").textContent).not.toBe("");
    });

    act(() => {
        loadMore(2);
    });

    await waitFor(() => {
        expect(screen.getByTestId("status").textContent).not.toBe("LoadingMore");
    });

    return { loadMore };
};

describe("usePaginatedQuery — reactive ranges", () => {
    it("inserting into the middle of a 2-page feed grows one page with no dup or skip", async () => {
        expect.hasAssertions();

        // Sorted: a b c d e f. Page 1 = (null, b], page 2 = (b, …].
        const backend = createReactiveBackend(["a", "b", "c", "d", "e", "f"]);

        await renderTwoPages(backend);

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        // Insert "aa" — sorts between a and b, i.e. INTO page 1's range (null, b].
        act(() => {
            backend.insert("aa");
        });

        await waitFor(() => {
            // Page 1 grew to {a, aa, b}; page 2 {c, d} untouched. Every row once.
            expect(screen.getByTestId("results").textContent).toBe("a,aa,b,c,d");
        });

        const flat = (screen.getByTestId("results").textContent ?? "").split(",");

        expect(new Set(flat).size).toBe(flat.length);
    });

    it("deleting a boundary-adjacent row leaves no gap and spares the neighbor", async () => {
        expect.hasAssertions();

        // Sorted: a b c d e f. Page 1 = (null, b], page 2 starts at (b, …].
        const backend = createReactiveBackend(["a", "b", "c", "d", "e", "f"]);

        await renderTwoPages(backend);

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        // Delete "c" — the first row of page 2, adjacent to the shared boundary b.
        act(() => {
            backend.remove("c");
        });

        await waitFor(() => {
            // No gap, no dup across the b boundary: page 1 {a,b} is untouched and
            // the open-ended tail re-reads the next rows after b — now {d, e}.
            expect(screen.getByTestId("results").textContent).toBe("a,b,d,e");
        });
    });

    it("a page that grows past the split threshold splits into two", async () => {
        expect.hasAssertions();

        // initialNumItems 2 ⇒ split when a bounded page exceeds 2×2 = 4 rows.
        const backend = createReactiveBackend(["a", "b", "z1", "z2", "z3", "z4"]);

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={backend.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback capturing the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        // Page 1 = (null, b] = {a, b}. Open a tiny page 2 so page 1 becomes bounded.
        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,z1,z2");
        });

        const pagesBefore = backend.subCount();

        // Insert three rows INTO page 1's range (null, b]: a0..a2 all sort before b.
        act(() => {
            backend.insert("a0");
            backend.insert("a1");
            backend.insert("a2");
        });

        await waitFor(() => {
            // Page 1's range now holds {a, a0, a1, a2, b} = 5 rows > 4 ⇒ split.
            // A split adds a page boundary, so the live subscription count rises.
            expect(backend.subCount()).toBeGreaterThan(pagesBefore);
        });

        // After the split the flattened feed is still correct and dup-free.
        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,a0,a1,a2,b,z1,z2");
        });
    });

    it("a page that shrinks below the join threshold merges with its neighbor", async () => {
        expect.hasAssertions();

        // Sorted: a b c d. Page 1 = (null, b] = {a, b}; page 2 = (b, …].
        const backend = createReactiveBackend(["a", "b", "c", "d"]);

        await renderTwoPages(backend);

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        const pagesBefore = backend.subCount();

        // Delete both rows of page 1's range ⇒ size 0 < 0.5×2 = 1 ⇒ join with page 2.
        act(() => {
            backend.remove("a");
            backend.remove("b");
        });

        await waitFor(() => {
            // Join drops a boundary, so the live subscription count falls.
            expect(backend.subCount()).toBeLessThan(pagesBefore);
        });

        await waitFor(() => {
            // Feed stays correct after the merge: just {c, d}.
            expect(screen.getByTestId("results").textContent).toBe("c,d");
        });
    });
});
