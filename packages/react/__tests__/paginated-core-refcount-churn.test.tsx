import type { CirrusClient, FunctionReference, Unsubscribe } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";

const makeRef = (ref: string): FunctionReference => ({ __cirrusRef: ref });

interface PaginationOpts {
    cursor: null | string;
    endCursor?: null | string;
    numItems: number;
}

/**
 * A subscription-counting backend. Tracks the number of LIVE subscriptions
 * (subscribe minus unsubscribe) plus raw subscribe/unsubscribe call counts so a
 * test can assert the attach/detach refcount lifecycle returns to baseline and
 * never double-detaches (which would over-fire `unsubscribe`).
 */
const createCountingBackend = (initial: string[]) => {
    const items = [...initial].toSorted((a, b) => a.localeCompare(b));

    interface LiveSub {
        opts: PaginationOpts;
    }

    const subs = new Set<LiveSub>();
    let subscribeCalls = 0;
    let unsubscribeCalls = 0;

    const evaluate = (opts: PaginationOpts) => {
        const { cursor, endCursor, numItems } = opts;
        const after = cursor === null ? items : items.filter((value) => value > cursor);

        if (endCursor != null) {
            const inRange = after.filter((value) => value <= endCursor);
            const middle = inRange.length >= 2 ? inRange[Math.floor(inRange.length / 2) - 1] : null;

            return { continueCursor: endCursor, isDone: true, page: inRange, splitCursor: middle };
        }

        const page = after.slice(0, numItems);
        const isDone = after.length <= numItems;
        const last = page.at(-1);

        return { continueCursor: isDone ? null : (last ?? null), isDone, page };
    };

    const query = vi.fn<(reference: FunctionReference, args: unknown) => Promise<unknown>>(async (_reference: FunctionReference, args: unknown) =>
        evaluate((args as { paginationOpts: PaginationOpts }).paginationOpts),
    );

    const subscribe = vi.fn<(reference: FunctionReference, args: unknown, callback: (value: unknown) => void) => Unsubscribe>(
        (_reference: FunctionReference, args: unknown, callback: (value: unknown) => void): Unsubscribe => {
            subscribeCalls += 1;

            const sub: LiveSub = { opts: (args as { paginationOpts: PaginationOpts }).paginationOpts };

            subs.add(sub);
            // Push an initial value so the page resolves through the live channel too.
            callback(evaluate(sub.opts));

            return () => {
                unsubscribeCalls += 1;
                subs.delete(sub);
            };
        },
    );

    const asClient = {
        action: vi.fn<() => Promise<unknown>>(),
        close: vi.fn<() => void>(),
        getAuthToken: vi.fn<() => string | null>(() => null),
        mutation: vi.fn<() => Promise<unknown>>(),
        onAuthTokenChange: vi.fn<() => Unsubscribe>(() => () => undefined),
        query,
        setAuthToken: vi.fn<(token: string | null) => void>(),
        subscribe,
    } as unknown as CirrusClient;

    return {
        asClient,
        liveSubCount: (): number => subs.size,
        subscribeCalls: (): number => subscribeCalls,
        unsubscribeCalls: (): number => unsubscribeCalls,
    };
};

interface ChurnHarnessProps {
    onSetVariant?: (set: (variant: number) => void) => void;
}

/**
 * Renders a paginated query whose base args carry a `variant` value. Bumping
 * `variant` changes the query key (the `resetKey` / `pageKeysHash`), forcing the
 * attach effect to tear down the prior page's subscription and open a fresh one.
 * This is the rapid-arg-change churn the audit flagged.
 */
const ChurnHarness = ({ onSetVariant }: ChurnHarnessProps): ReactElement => {
    const [variant, setVariant] = useState(0);

    onSetVariant?.(setVariant);

    const { results, status } = usePaginatedQuery(makeRef("items:list"), { variant }, { initialNumItems: 2 });

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
        </div>
    );
};

describe("usePaginatedCore — attach/detach refcount churn", () => {
    it("returns subscriptions to baseline after rapid arg changes then unmount", async () => {
        expect.hasAssertions();

        const backend = createCountingBackend(["a", "b", "c", "d", "e", "f"]);

        let setVariant: (variant: number) => void = () => undefined;

        const { unmount } = render(
            <CirrusProvider client={backend.asClient}>
                <ChurnHarness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback capturing the variant setter.
                    onSetVariant={(set) => {
                        setVariant = set;
                    }}
                />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).not.toBe("");
        });

        // Rapidly change args several times. Each distinct `variant` rewrites the
        // page key, so the prior page's subscription must detach and a new one
        // must attach. Done inside a single `act` to maximize batching/churn.
        act(() => {
            setVariant(1);
            setVariant(2);
            setVariant(3);
            setVariant(4);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).not.toBe("");
        });

        // While mounted, exactly one live subscription should remain (the single
        // open-ended first page for the current variant). A double-detach /
        // negative refcount would have closed it (0); a leak would show > 1.
        expect(backend.liveSubCount()).toBe(1);

        unmount();

        // After unmount every subscription must be released: live count back to 0.
        expect(backend.liveSubCount()).toBe(0);

        // Detach must fire exactly once per attach — never more (double-detach),
        // never fewer (leak). subscribe and unsubscribe call counts must match.
        expect(backend.unsubscribeCalls()).toBe(backend.subscribeCalls());
    });

    it("churns base args back and forth without leaking or double-releasing", async () => {
        expect.hasAssertions();

        const backend = createCountingBackend(["a", "b", "c", "d", "e", "f"]);

        let setVariant: (variant: number) => void = () => undefined;

        const { unmount } = render(
            <CirrusProvider client={backend.asClient}>
                <ChurnHarness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback capturing the variant setter.
                    onSetVariant={(set) => {
                        setVariant = set;
                    }}
                />
            </CirrusProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).not.toBe("");
        });

        // Oscillate between two keys repeatedly — exercises the "key reappears"
        // recycle path where a hash leaves and re-enters the desired set.
        for (let index = 0; index < 6; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- intentional: settle each toggle before the next to drive distinct effect passes.
            await act(async () => {
                setVariant(index % 2);
            });
        }

        await waitFor(() => {
            expect(backend.liveSubCount()).toBe(1);
        });

        unmount();

        expect(backend.liveSubCount()).toBe(0);
        expect(backend.unsubscribeCalls()).toBe(backend.subscribeCalls());
    });
});
